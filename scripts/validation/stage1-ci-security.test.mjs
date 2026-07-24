import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { load as parseYaml } from 'js-yaml';

const root = resolve(import.meta.dirname, '..', '..');

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function parsePowerShell(source) {
  const command = [
    '$source = [Console]::In.ReadToEnd()',
    '$tokens = $null',
    '$errors = $null',
    '[void][System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)',
    'if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.ErrorId) }; exit 1 }',
  ].join('; ');
  return spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    {
      cwd: root,
      encoding: 'utf8',
      input: source,
      windowsHide: true,
      timeout: 10_000,
    }
  );
}

function extractMarkedPowerShell(source, marker) {
  const start = `# BEGIN ${marker}`;
  const end = `# END ${marker}`;
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing ${marker} start marker`);
  assert.ok(endIndex > startIndex, `missing ${marker} end marker`);
  return source.slice(startIndex + start.length, endIndex);
}

test('CI is a least-privilege repository-wide Windows Stage 1 gate', () => {
  const source = read('.github/workflows/ci.yml');
  const workflow = parseYaml(source);
  const checkoutSha = '08eba0b27e820071cde6df949e0beb9ba4906955';
  const setupNodeSha = '49933ea5288caeca8642d1e84afbd3f7d6820020';
  const expectedNames = [
    'Check out source',
    'Set up Node.js',
    'Verify exact toolchain',
    'Install exact root dependencies',
    'Audit production and development dependencies',
    'Scan tracked source for secrets',
    'Check repository hygiene',
    'Run workspace contract tests',
    'Run containment tests',
    'Run hygiene tests',
    'Lint with zero warnings',
    'Check formatting',
    'Run backend tests against disposable storage',
    'Run Stage 1 build validation',
  ];
  const expectedRuns = new Map([
    [
      'Verify exact toolchain',
      [
        "if ((node --version) -ne 'v24.18.0') { throw 'Unexpected Node version' }",
        "if ((npm --version) -ne '11.6.2') { throw 'Unexpected npm version' }",
      ].join('\n'),
    ],
    ['Install exact root dependencies', 'npm ci'],
    ['Audit production and development dependencies', 'npm audit --audit-level=high'],
    ['Scan tracked source for secrets', 'npm run scan:secrets'],
    ['Check repository hygiene', 'npm run check:hygiene'],
    ['Run workspace contract tests', 'npm run test:workspace'],
    ['Run containment tests', 'npm run test:containment'],
    ['Run hygiene tests', 'npm run test:hygiene'],
    ['Lint with zero warnings', 'npm run lint'],
    ['Check formatting', 'npm run format:check'],
    ['Run backend tests against disposable storage', 'npm run test:backend:legacy-safe'],
    ['Run Stage 1 build validation', 'npm run build'],
  ]);

  assert.deepEqual(workflow.on, {
    push: { branches: ['main', 'master', 'develop'] },
    pull_request: { branches: ['main', 'master'] },
    workflow_dispatch: null,
  });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs), ['stage-1']);

  const job = workflow.jobs['stage-1'];
  assert.equal(job.name, 'Stage 1 hygiene and workspace');
  assert.equal(job['runs-on'], 'windows-latest');
  assert.equal(job['timeout-minutes'], 20);
  assert.equal(job.defaults, undefined);
  assert.equal(job.strategy, undefined);
  assert.deepEqual(
    job.steps.map(step => step.name),
    expectedNames
  );

  const checkout = job.steps[0];
  assert.deepEqual(checkout, {
    name: 'Check out source',
    uses: `actions/checkout@${checkoutSha}`,
    with: {
      'fetch-depth': 1,
      'persist-credentials': false,
    },
  });

  const setupNode = job.steps[1];
  assert.deepEqual(setupNode, {
    name: 'Set up Node.js',
    uses: `actions/setup-node@${setupNodeSha}`,
    with: {
      'node-version': '24.18.0',
      cache: 'npm',
      'cache-dependency-path': 'package-lock.json',
    },
  });

  for (const step of job.steps.slice(2)) {
    assert.equal(step.run.trim(), expectedRuns.get(step.name));
    assert.deepEqual(
      Object.keys(step).sort(),
      step.name === 'Verify exact toolchain' ? ['name', 'run', 'shell'] : ['name', 'run']
    );
  }
  assert.equal(job.steps[2].shell, 'pwsh');
  assert.doesNotMatch(source, /\$\{\{\s*secrets\./);
  assert.match(source, /Official GitHub-maintained action/i);
  assert.match(source, /checkout v4\.3\.0/i);
  assert.match(source, /setup-node v4\.4\.0/i);
});

test('security policy treats local artifacts as sensitive and revocation as separate', () => {
  const policy = read('SECURITY.md');

  for (const phrase of [
    /runtime databases/i,
    /WAL\/SHM/i,
    /sensitive personal data/i,
    /Report a vulnerability/i,
    /private\s+vulnerability reporting/i,
    /existing private contact channel/i,
    /release prerequisite/i,
    /do not open a\s+public issue/i,
    /must be revoked/i,
    /rewriting Git history does not revoke/i,
    /%LOCALAPPDATA%\\easy-rewind\\legacy-backup\\/i,
    /recovery data, not credential\s+storage/i,
    /excluded from source, builds, tests, logs, diagnostics, exports,\s+and release artifacts/i,
  ]) {
    assert.match(policy, phrase);
  }
});

test('credential response requires provider revocation and backend-only replacement handling', () => {
  const guide = read('docs/security/credential-response.md');

  for (const phrase of [
    /Google AI Studio or Google Cloud/i,
    /revoke or delete the exposed key/i,
    /review provider usage and billing logs/i,
    /private incident\s+record/i,
    /replacement.+backend-only protected\s+configuration flow/is,
    /do not.+quarantine/is,
    /history\s+rewriting and file deletion are containment steps, not revocation/i,
  ]) {
    assert.match(guide, phrase);
  }
});

test('history remediation is a separate post-gate coordinated external action', () => {
  const guide = read('docs/security/git-history-remediation.md');
  const affectedPaths = [
    'backend/.env',
    'backend/data/easy-rewind.db',
    'backend/data/easy-rewind.db-wal',
    'backend/data/easy-rewind.db-shm',
    'backend/data/settings.json',
  ];

  assert.match(guide, /only after (?:the )?containment and workspace gates pass.+collaborator.+freeze/is);
  assert.match(guide, /separate\s+Stage 1 external action.+required before.+final PASS/is);
  assert.match(guide, /repository-external/i);
  assert.match(guide, /non-synced/i);
  assert.match(guide, /\$ExpectedSlug\s+-eq\s+'OWNER\/REPOSITORY'.+throw/is);
  assert.match(guide, /\$BackupMirror/);
  assert.match(guide, /\$RewriteMirror/);
  assert.match(guide, /SetAccessRuleProtection/);
  assert.match(guide, /WindowsIdentity/);
  assert.match(guide, /Set-Acl/);
  assert.match(guide, /show-ref/);
  assert.match(guide, /Get-FileHash/);
  assert.match(guide, /git\s+-C\s+\$RewriteMirror\s+filter-repo/);
  assert.match(guide, /replace-text/);
  assert.match(guide, /git.+log.+--all.+--name-only/is);
  assert.match(guide, /gitleaks.+--redact.+--log-opts.+--all/is);
  assert.match(guide, /git.+-C.+\$RewriteMirror.+push.+--atomic.+--force.+--mirror.+\$RemoteUrl/is);
  assert.match(guide, /\$VerificationMirror/);
  assert.match(guide, /git.+clone.+--mirror.+\$RemoteUrl.+\$VerificationMirror/is);
  assert.match(guide, /git.+-C.+\$BackupMirror.+push.+--atomic.+--force.+--mirror.+\$RemoteUrl/is);
  assert.match(guide, /rollback/i);
  assert.doesNotMatch(guide, /<REMOTE-URL>/);
  assert.doesNotMatch(guide, /Write-(?:Host|Output).*(?:secret|credential)/i);
  assert.match(guide, /discard old clones and re-clone/i);
  assert.match(guide, /forks, caches, release\s+artifacts, pull-request refs, and external mirrors/i);
  assert.match(guide, /key\s+must still be revoked/i);

  for (const affectedPath of affectedPaths) {
    assert.ok(guide.includes(affectedPath), `missing affected path: ${affectedPath}`);
  }
});

test('history rewrite starts from one protected snapshot and aborts on remote drift', () => {
  const guide = read('docs/security/git-history-remediation.md');

  assert.match(guide, /\$ExpectedRepositorySlug\s*=/);
  assert.match(guide, /remote\s+get-url\s+origin/);
  assert.match(guide, /\$RemoteUri\.Query/);
  assert.match(guide, /\$RemoteUri\.Fragment/);
  assert.match(guide, /expected repository slug/i);
  assert.match(guide, /git\s+clone\s+--mirror\s+--no-local\s+\$BackupMirror\s+\$RewriteMirror/);
  assert.doesNotMatch(guide, /git\s+clone\s+--mirror(?:\s+--no-local)?\s+\$RemoteUrl\s+\$RewriteMirror/);
  assert.match(guide, /FREEZE CONFIRMED/);

  const guardClone = guide.indexOf('git clone --mirror $RemoteUrl $RemoteGuardMirror');
  const guardCompare = guide.indexOf('Compare-Object $RecordedBackupRefs $GuardRemoteRefs');
  const forcePush = guide.indexOf('git -C $RewriteMirror push --atomic --force --mirror $RemoteUrl');
  assert.ok(guardClone >= 0, 'missing fresh remote guard clone');
  assert.ok(guardCompare > guardClone, 'remote refs must be compared after the guard clone');
  assert.ok(forcePush > guardCompare, 'force push must occur only after the remote-drift comparison');
});

test('history updates are atomic and provider limitations block release', () => {
  const guide = read('docs/security/git-history-remediation.md');

  const atomicPushes = guide.match(/push\s+--atomic\s+--force\s+--mirror\s+\$RemoteUrl/g) ?? [];
  assert.equal(atomicPushes.length, 2, 'forward and rollback must each use one atomic mirror push');
  assert.doesNotMatch(guide, /push\s+--force\s+--mirror\s+\$RemoteUrl/);
  assert.match(guide, /must not be retried non-atomically|never retry non-atomically/i);
  assert.match(guide, /provider does not\s+support atomic pushes/i);
  assert.match(guide, /protected or read-only provider refs[\s\S]+reject/i);
  assert.match(guide, /refs\/pull/i);
  assert.match(
    guide,
    /GitHub Support[\s\S]+pull-request refs[\s\S]+cached views[\s\S]+server garbage collection[\s\S]+LFS/i
  );
  assert.match(guide, /blocking exit item[\s\S]+final PASS/i);
});

test('sensitive-data rewrite captures protected provider-support evidence', () => {
  const guide = read('docs/security/git-history-remediation.md');
  const filterInvocations = guide.match(/git\s+-C\s+\$RewriteMirror\s+filter-repo[^\r\n]*(?:`\r?\n[^\r\n]*)*/g) ?? [];

  assert.equal(filterInvocations.length, 2);
  for (const invocation of filterInvocations) {
    assert.match(invocation, /--sensitive-data-removal/);
  }
  assert.match(guide, /git\s+filter-repo\s+-h/);
  assert.match(guide, /2\.47/);
  assert.match(guide, /--sensitive-data-removal/);
  assert.match(guide, /\$FilterRepoMetadata[\s\S]+changed-refs/);
  assert.match(guide, /\$FilterRepoMetadata[\s\S]+first-changed-commits/);
  assert.match(guide, /\$FilterRepoMetadata[\s\S]+orphaned_lfs_objects/);
  assert.match(guide, /changedPullRequestRefs/);
  assert.match(guide, /changedPullRequestCount/);
  assert.match(guide, /firstChangedCommits/);
  assert.match(guide, /orphanedLfsObjects/);
  assert.match(guide, /provider-support-evidence\.json/);
  assert.match(guide, /protected incident directory|protected incident artifact/i);
  assert.match(guide, /must not enter public logs|do not print/i);
});

test('replacement cleanup and incident closeout fail closed', () => {
  const guide = read('docs/security/git-history-remediation.md');

  assert.doesNotMatch(guide, /Remove-Item[^\r\n]+SilentlyContinue/);
  assert.match(guide, /Remove-Item\s+-LiteralPath\s+\$ReplacementFile\s+-Force\s+-ErrorAction\s+Stop/);
  assert.match(
    guide,
    /Remove-Item\s+-LiteralPath\s+\$ReplacementFile[\s\S]+Test-Path\s+-LiteralPath\s+\$ReplacementFile/
  );
  assert.match(guide, /catch\s*\{[\s\S]*throw 'Replacement-file cleanup failed/);
  assert.match(guide, /ordinary deletion is not secure erasure/i);

  const closeout = guide.split('## Protected incident closeout')[1] ?? '';
  assert.match(closeout, /\$IncidentRoot\s*=\s*Read-Host/);
  assert.match(closeout, /security-incidents/);
  assert.match(closeout, /history-\\d\{8\}T\\d\{9\}Z/);
  assert.match(closeout, /SetAccessRuleProtection|AreAccessRulesProtected/);
  assert.match(closeout, /\$RootAcl\.GetOwner\(\[Security\.Principal\.SecurityIdentifier\]\)/);
  assert.match(closeout, /\$ExpectedParentItem[\s\S]+ReparsePoint/);
  assert.match(closeout, /Remove-Item\s+-LiteralPath\s+\$IncidentFull\s+-Recurse\s+-Force\s+-ErrorAction\s+Stop/);
  assert.match(closeout, /Test-Path\s+-LiteralPath\s+\$IncidentFull/);
  assert.match(closeout, /media sanitization|cryptographic erasure|destroy the media/i);
});

test('rollback is independently resumable from a protected incident manifest', () => {
  const guide = read('docs/security/git-history-remediation.md');
  const rollback = guide.split('## Exact rollback from the protected mirror')[1] ?? '';

  assert.match(guide, /incident-manifest\.json/);
  assert.match(guide, /expectedRepositorySlug/);
  assert.match(guide, /remoteUrl/);
  for (const artifact of [
    'backupMirror',
    'backupRefs',
    'backupBundle',
    'backupEvidence',
    'postRewriteRefs',
    'postRewriteEvidence',
    'providerSupportEvidence',
  ]) {
    assert.match(guide, new RegExp(`${artifact}\\s*=`));
  }

  assert.match(rollback, /\$IncidentRoot\s*=\s*Read-Host/);
  assert.match(rollback, /incident-manifest\.json/);
  assert.match(rollback, /Resolve-IncidentChild/);
  assert.match(rollback, /security-incidents/);
  assert.match(rollback, /history-\\d\{8\}T\\d\{9\}Z/);
  assert.match(rollback, /AreAccessRulesProtected/);
  assert.match(rollback, /\$RootAcl\.GetOwner\(\[Security\.Principal\.SecurityIdentifier\]\)/);
  assert.match(rollback, /WindowsIdentity/);
  assert.match(rollback, /\$RemoteUri\.Query/);
  assert.match(rollback, /\$RemoteUri\.Fragment/);
  assert.match(rollback, /\$ExpectedRepositorySlug\s*=\s*Read-Host/);
  assert.match(rollback, /Resolve-IncidentChild[\s\S]+RelativePath 'incident-manifest\.json'/);
  assert.match(rollback, /Get-FileHash/);
  assert.match(rollback, /Compare-Object\s+\$RecordedBackupRefs\s+\$CurrentBackupRefs/);
  assert.match(rollback, /postRewriteCapturedAtUtc/);
  assert.match(rollback, /pre-rollback-current\.git/);
  assert.match(rollback, /pre-rollback-current-refs\.txt/);
  assert.match(rollback, /pre-rollback-current\.bundle/);
  assert.match(rollback, /pre-rollback-current-checksums\.json/);
  assert.match(rollback, /Compare-Object\s+\$RecordedPostRewriteRefs\s+\$CurrentRemoteRefs/);
  assert.match(rollback, /git\s+-C\s+\$BackupMirror\s+push\s+--atomic\s+--force\s+--mirror\s+\$RemoteUrl/);

  const preservationClone = rollback.indexOf('git clone --mirror $RemoteUrl $PreRollbackMirror');
  const currentRefCapture = rollback.indexOf('$CurrentRemoteRefs = @(');
  const driftComparison = rollback.indexOf('Compare-Object $RecordedPostRewriteRefs $CurrentRemoteRefs');
  const rollbackPush = rollback.indexOf('push --atomic --force --mirror $RemoteUrl');
  assert.ok(preservationClone >= 0, 'missing fresh pre-rollback preservation mirror');
  assert.ok(currentRefCapture > preservationClone, 'current refs must come from the preservation mirror');
  assert.ok(driftComparison > currentRefCapture, 'rollback drift comparison must follow current-ref capture');
  assert.ok(rollbackPush > driftComparison, 'rollback push must follow preservation and drift validation');
});

test(
  'closeout refuses descendant reparse points without touching their targets',
  { skip: process.platform !== 'win32' },
  t => {
    const guide = read('docs/security/git-history-remediation.md');
    const closeout = guide.split('## Protected incident closeout')[1] ?? '';
    const traversal = extractMarkedPowerShell(closeout, 'TESTED NON-FOLLOWING REPARSE TRAVERSAL');
    const traversalCall = closeout.lastIndexOf('Assert-NoReparseDescendants -RootPath $IncidentFull');
    const finalRootValidation = closeout.indexOf('$PreDeleteIncident =');
    const destructiveCall = closeout.indexOf('Remove-Item -LiteralPath $IncidentFull -Recurse');
    assert.ok(traversalCall >= 0, 'closeout must invoke the tested descendant traversal');
    assert.ok(finalRootValidation > traversalCall, 'root must be revalidated after descendant traversal');
    assert.ok(destructiveCall > finalRootValidation, 'destructive closeout must follow final root validation');
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-closeout-'));
    const externalRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-external-'));
    const incidentRoot = join(fixtureRoot, 'incident');
    const externalMarker = join(externalRoot, 'must-survive.txt');
    const descendantLink = join(incidentRoot, 'nested', 'external-link');
    mkdirSync(join(incidentRoot, 'nested'), { recursive: true });
    writeFileSync(externalMarker, 'preserve', 'utf8');

    try {
      try {
        symlinkSync(externalRoot, descendantLink, 'junction');
      } catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error?.code)) {
          t.skip('Windows link creation is unavailable for the sanitized closeout fixture.');
          return;
        }
        throw new Error('Unexpected failure while creating the sanitized closeout fixture.');
      }

      const encodedRoot = Buffer.from(incidentRoot, 'utf8').toString('base64');
      const command = [
        traversal,
        `$fixtureRoot = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedRoot}'))`,
        "try { Assert-NoReparseDescendants -RootPath $fixtureRoot; exit 0 } catch { [Console]::Error.WriteLine('Unsafe descendant rejected.'); exit 23 }",
      ].join('; ');
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(command, 'utf16le').toString('base64'),
        ],
        {
          cwd: root,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 10_000,
        }
      );

      assert.equal(result.status, 23, 'descendant reparse point must abort closeout traversal');
      assert.match(result.stderr, /Unsafe descendant rejected\./);
      assert.ok(!result.stderr.includes(fixtureRoot), 'fixture failure must not disclose the incident path');
      assert.ok(!result.stderr.includes(externalRoot), 'fixture failure must not disclose the external path');
      assert.ok(existsSync(descendantLink), 'rejected traversal must leave the descendant link untouched');
      assert.ok(existsSync(externalMarker), 'external target must survive rejected traversal');
      assert.equal(readFileSync(externalMarker, 'utf8'), 'preserve');
    } finally {
      const temporaryRoot = resolve(tmpdir());
      for (const [candidate, expectedPrefix] of [
        [fixtureRoot, 'easy-rewind-closeout-'],
        [externalRoot, 'easy-rewind-external-'],
      ]) {
        const resolvedCandidate = resolve(candidate);
        assert.ok(
          resolvedCandidate.startsWith(`${temporaryRoot}${sep}`) &&
            basename(resolvedCandidate).startsWith(expectedPrefix),
          'fixture cleanup target must be an exact sanitized temporary child'
        );
      }
      if (existsSync(descendantLink)) {
        assert.ok(lstatSync(descendantLink).isSymbolicLink(), 'fixture link must remain non-following during cleanup');
        unlinkSync(descendantLink);
      }
      rmSync(fixtureRoot, { force: true, recursive: true });
      try {
        assert.ok(existsSync(externalMarker), 'external target must survive fixture-root cleanup');
      } finally {
        rmSync(externalRoot, { force: true, recursive: true });
      }
    }
  }
);

test('every PowerShell history-remediation block parses without errors', () => {
  const guide = read('docs/security/git-history-remediation.md');
  const blocks = [...guide.matchAll(/```powershell\s*\r?\n([\s\S]*?)```/gi)].map(match => match[1]);

  assert.ok(blocks.length >= 6, 'expected preparation, rewrite, replacement, push, rollback, and closeout blocks');
  for (const [index, block] of blocks.entries()) {
    const result = parsePowerShell(block);
    assert.equal(result.error, undefined, `PowerShell parser failed to start for block ${index + 1}`);
    assert.equal(result.status, 0, `PowerShell block ${index + 1} has parse errors: ${result.stderr.trim()}`);
  }
});

test('README uses only the canonical root workspace setup', () => {
  const readme = read('README.md');

  assert.match(readme, /Node\.js 24\.18\.0 LTS/);
  assert.match(readme, /npm 11\.6\.2/);
  assert.match(readme, /repository root/i);
  assert.match(readme, /npm ci/);
  assert.match(readme, /npm start/);
  assert.match(readme, /npm run verify/);
  assert.match(readme, /Electron's embedded Node runtime/i);
  assert.doesNotMatch(readme, /\bAndroid\b/i);
  assert.doesNotMatch(readme, /cd\s+(?:\.\/)?(?:backend|desktop)\b/i);
  assert.doesNotMatch(readme, /npm install/i);
  assert.doesNotMatch(readme, /real credentials|real (?:Gemini )?(?:API )?key/i);
  assert.doesNotMatch(readme, /(?:extension|dashboard|desktop).{0,80}(?:store|enter|configure).{0,40}key/is);
});

test('public Task 7 files contain no credential-shaped values', () => {
  const publicText = [
    '.github/workflows/ci.yml',
    'README.md',
    'SECURITY.md',
    'docs/security/credential-response.md',
    'docs/security/git-history-remediation.md',
  ]
    .map(read)
    .join('\n');

  assert.doesNotMatch(publicText, /AIza[0-9A-Za-z_-]{20,}/);
  assert.doesNotMatch(publicText, /GEMINI_API_KEY\s*=\s*\S+/);
});

test('the workspace verification suite runs the Task 7 contract test', () => {
  const repository = JSON.parse(read('package.json'));

  assert.match(repository.scripts['test:workspace'], /scripts\/validation\/stage1-ci-security\.test\.mjs/);
  assert.equal(repository.devDependencies['js-yaml'], '4.3.0');
});

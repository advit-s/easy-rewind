import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { load as parseYaml } from 'js-yaml';

const root = resolve(import.meta.dirname, '..', '..');

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function parsePowerShell(source) {
  const sourceBase64 = Buffer.from(source, 'utf8').toString('base64');
  const command = [
    `$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${sourceBase64}'))`,
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
      windowsHide: true,
      timeout: 10_000,
    }
  );
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
  assert.match(guide, /fresh mirror clone/i);
  assert.match(guide, /repository-external/i);
  assert.match(guide, /non-synced/i);
  assert.match(
    guide,
    /\$RemoteUri\.Host\s+-eq\s+'github\.com'.+\$RemoteUri\.AbsolutePath\s+-eq\s+'\/OWNER\/REPOSITORY\.git'.+throw/is
  );
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
  assert.match(guide, /git.+-C.+\$RewriteMirror.+push.+--force.+--mirror.+\$RemoteUrl/is);
  assert.match(guide, /\$VerificationMirror/);
  assert.match(guide, /git.+clone.+--mirror.+\$RemoteUrl.+\$VerificationMirror/is);
  assert.match(guide, /git.+-C.+\$BackupMirror.+push.+--force.+--mirror.+\$RemoteUrl/is);
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

test('every PowerShell history-remediation block parses without errors', () => {
  const guide = read('docs/security/git-history-remediation.md');
  const blocks = [...guide.matchAll(/```powershell\s*\r?\n([\s\S]*?)```/gi)].map(match => match[1]);

  assert.ok(blocks.length >= 4, 'expected preparation, rewrite, push, and rollback blocks');
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

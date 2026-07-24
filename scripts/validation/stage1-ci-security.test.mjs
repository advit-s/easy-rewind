import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..');

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

test('CI is a least-privilege repository-wide Windows Stage 1 gate', () => {
  const workflow = read('.github/workflows/ci.yml');

  assert.match(workflow, /^on:\s*$/m);
  assert.match(workflow, /^\s{2}push:\s*$/m);
  assert.match(workflow, /^\s{2}pull_request:\s*$/m);
  assert.match(workflow, /^\s{2}workflow_dispatch:\s*$/m);
  assert.doesNotMatch(workflow, /^\s+paths(?:-ignore)?:/m);
  assert.match(workflow, /^permissions:\s*\n\s{2}contents:\s*read\s*$/m);
  assert.match(workflow, /^\s{4}runs-on:\s*windows-latest\s*$/m);
  assert.match(workflow, /^\s{4}timeout-minutes:\s*(?:[1-9]|1\d|20)\s*$/m);
  assert.match(workflow, /uses:\s*actions\/checkout@v4\b/);
  assert.match(workflow, /uses:\s*actions\/setup-node@v4\b/);
  assert.match(workflow, /^\s+node-version:\s*24\.18\.0\s*$/m);
  assert.match(workflow, /^\s+cache:\s*npm\s*$/m);
  assert.match(workflow, /^\s+cache-dependency-path:\s*package-lock\.json\s*$/m);
  assert.match(workflow, /\(node --version\).+v24\.18\.0/);
  assert.match(workflow, /\(npm --version\).+11\.6\.2/);
  assert.doesNotMatch(workflow, /working-directory:\s*(?:\.\/)?(?:backend|desktop)/);
  assert.doesNotMatch(workflow, /continue-on-error\s*:/);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(workflow, /^\s+(?:GEMINI_API_KEY|DATABASE_PATH|ALLOWED_ORIGINS):/m);

  for (const command of [
    'npm ci',
    'npm audit --audit-level=high',
    'npm run scan:secrets',
    'npm run check:hygiene',
    'npm run test:workspace',
    'npm run test:containment',
    'npm run test:hygiene',
    'npm run lint',
    'npm run format:check',
    'npm run test:backend:legacy-safe',
    'npm run build',
  ]) {
    assert.ok(workflow.includes(command), `missing CI gate: ${command}`);
  }

  assert.match(workflow, /Official GitHub-maintained action/i);
});

test('security policy treats local artifacts as sensitive and revocation as separate', () => {
  const policy = read('SECURITY.md');

  for (const phrase of [
    /runtime databases/i,
    /WAL\/SHM/i,
    /sensitive personal data/i,
    /report.+privately/is,
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
  assert.match(guide, /offline\s+mirror backup/i);
  assert.match(guide, /git filter-repo/);
  assert.match(guide, /replace-text/);
  assert.match(guide, /scan all rewritten refs/i);
  assert.doesNotMatch(guide, /^\s*git push --force --mirror\s*$/m);
  assert.match(guide, /^\s*git push --force --mirror\s+<REMOTE-URL>\s*$/m);
  assert.match(guide, /discard old clones and re-clone/i);
  assert.match(guide, /forks, caches, release\s+artifacts, pull-request refs, and external mirrors/i);
  assert.match(guide, /key must still be revoked/i);

  for (const affectedPath of affectedPaths) {
    assert.ok(guide.includes(affectedPath), `missing affected path: ${affectedPath}`);
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
});

const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const test = require('node:test');

const { createTestEnvironment } = require('./test-environment');

const repositoryRoot = resolve(__dirname, '..', '..', '..');

test('two test environments never share runtime paths', async () => {
  const first = await createTestEnvironment();
  const second = await createTestEnvironment();

  try {
    assert.notEqual(first.root, second.root);
    for (const key of ['database', 'settings', 'log', 'export']) {
      assert.equal(typeof first.paths[key], 'string');
      assert.equal(typeof second.paths[key], 'string');
      assert.equal(resolve(first.paths[key]), first.paths[key]);
      assert.equal(resolve(second.paths[key]), second.paths[key]);
      assert.notEqual(first.paths[key], second.paths[key]);
    }
    assert.equal(first.clock.now().toISOString(), '2024-01-02T03:04:05.000Z');
    assert.equal(first.generateId(), 'test-id-0001');
    assert.equal(first.generateId(), 'test-id-0002');
    assert.deepEqual(first.scheduler, { enabled: false });
    assert.equal(first.env.GEMINI_API_KEY, '');
    assert.equal(second.env.GEMINI_API_KEY, '');
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});

test('cleanup is idempotent and stays scoped to its unique temporary root', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'easy-rewind-test-parent-'));
  const sentinel = join(parent, 'sentinel.txt');
  writeFileSync(sentinel, 'keep');

  try {
    const environment = await createTestEnvironment({ temporaryRoot: parent });

    await environment.cleanup();
    await environment.cleanup();

    assert.equal(existsSync(environment.root), false);
    assert.equal(existsSync(sentinel), true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('repository-contained temporary roots are rejected', async () => {
  await assert.rejects(
    createTestEnvironment({ temporaryRoot: join(repositoryRoot, 'backend', 'data') }),
    /outside the repository/i
  );
});

test('linked temporary roots are rejected without touching their targets', async t => {
  const external = mkdtempSync(join(tmpdir(), 'easy-rewind-test-external-'));
  const link = join(mkdtempSync(join(tmpdir(), 'easy-rewind-test-link-parent-')), 'linked');
  const marker = join(external, 'marker.txt');
  writeFileSync(marker, 'keep');

  try {
    try {
      symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip('directory-link creation is unavailable');
        return;
      }
      throw error;
    }
    await assert.rejects(createTestEnvironment({ temporaryRoot: link }), /symbolic link|reparse-point link/i);
    assert.equal(existsSync(marker), true);
  } finally {
    if (existsSync(link)) unlinkSync(link);
    rmSync(resolve(link, '..'), { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

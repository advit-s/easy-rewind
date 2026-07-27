const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const test = require('node:test');

const { runImportProbe } = require('./support/import-safety-probe');

function createFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'easy-rewind-import-probe-fixture-'));
  for (const [name, source] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return root;
}

function fixtureEntries(root) {
  return readdirSync(root, { recursive: true })
    .map(entry => String(entry).replaceAll('\\', '/'))
    .sort();
}

function removeFixture(root) {
  rmSync(root, { recursive: true, force: true });
}

test('probe detects environment and exported runtime-config mutations without reporting values', () => {
  const secretValue = 'sensitive-fixture-value-do-not-report';
  const root = createFixture({
    'config.js': "module.exports = { config: { mode: 'safe' } };\n",
    'mutator.js': `
      const holder = require('./config');
      process.env.EASY_REWIND_FIXTURE_MUTATION = ${JSON.stringify(secretValue)};
      holder.config.mode = ${JSON.stringify(secretValue)};
    `,
  });
  const before = fixtureEntries(root);

  try {
    const result = runImportProbe({
      modules: [join(root, 'config.js'), join(root, 'mutator.js')],
      sourceRoot: root,
      mutableExportTargets: [{ modulePath: join(root, 'config.js'), exportName: 'config' }],
    });

    assert.equal(result.status, 1);
    assert.deepEqual(result.report.environmentMutations, [{ operation: 'set', key: 'EASY_REWIND_FIXTURE_MUTATION' }]);
    assert.deepEqual(result.report.mutableConfigChanges, [{ module: 'source/config.js', exportName: 'config' }]);
    assert.doesNotMatch(JSON.stringify(result.report), new RegExp(secretValue, 'i'));
    assert.equal(result.report.pathsChanged, false);
    assert.deepEqual(fixtureEntries(root), before);
  } finally {
    removeFixture(root);
  }
});

test('probe ignores environment operations that do not change process state', () => {
  const root = createFixture({
    'environment-noop.js': `
      delete process.env.EASY_REWIND_IMPORT_ABSENT_FIXTURE_KEY;
      process.env.DATABASE_PATH = process.env.DATABASE_PATH;
    `,
  });

  try {
    const result = runImportProbe({ modules: [join(root, 'environment-noop.js')], sourceRoot: root });

    assert.equal(result.status, 0);
    assert.deepEqual(result.report.environmentMutations, []);
  } finally {
    removeFixture(root);
  }
});

test('probe detects and blocks synchronous writes and write-mode opens', () => {
  const root = createFixture({
    'sync-write.js': `
      const fs = require('node:fs');
      fs.writeFileSync(process.env.SETTINGS_PATH, 'blocked');
      fs.openSync(process.env.LOG_PATH, fs.constants.O_CREAT | fs.constants.O_WRONLY);
      fs.mkdtempDisposableSync(process.env.EXPORT_PATH).remove();
    `,
  });
  const before = fixtureEntries(root);

  try {
    const result = runImportProbe({ modules: [join(root, 'sync-write.js')], sourceRoot: root });

    assert.equal(result.status, 1);
    assert.deepEqual(result.report.violations.map(({ operation }) => operation).sort(), [
      'mkdtempDisposableSync',
      'openSync',
      'writeFileSync',
    ]);
    assert.equal(result.report.pathsChanged, false);
    assert.deepEqual(fixtureEntries(root), before);
  } finally {
    removeFixture(root);
  }
});

test('probe detects and blocks callback and open-for-write filesystem APIs', () => {
  const root = createFixture({
    'callback-write.js': `
      const fs = require('node:fs');
      fs.writeFile(process.env.SETTINGS_PATH, 'blocked', () => {});
      fs.open(process.env.LOG_PATH, 'w', () => {});
    `,
  });
  const before = fixtureEntries(root);

  try {
    const result = runImportProbe({ modules: [join(root, 'callback-write.js')], sourceRoot: root });

    assert.equal(result.status, 1);
    assert.deepEqual(result.report.violations.map(({ operation }) => operation).sort(), ['open', 'writeFile']);
    assert.equal(result.report.pathsChanged, false);
    assert.deepEqual(fixtureEntries(root), before);
  } finally {
    removeFixture(root);
  }
});

test('probe detects and blocks promise filesystem writes and write-mode opens', () => {
  const root = createFixture({
    'promise-write.js': `
      const fs = require('node:fs/promises');
      void fs.writeFile(process.env.EXPORT_PATH, 'blocked');
      void fs.mkdtempDisposable(process.env.SETTINGS_PATH);
      void (async () => {
        const handle = await fs.open(process.env.DATABASE_PATH, 'a');
        await handle.writeFile('blocked');
        handle.createWriteStream().end('blocked');
      })();
    `,
  });
  const before = fixtureEntries(root);

  try {
    const result = runImportProbe({ modules: [join(root, 'promise-write.js')], sourceRoot: root });

    assert.equal(result.status, 1);
    assert.deepEqual(result.report.violations.map(({ operation }) => operation).sort(), [
      'fileHandle.createWriteStream',
      'fileHandle.writeFile',
      'promises.mkdtempDisposable',
      'promises.open',
      'promises.writeFile',
    ]);
    assert.equal(result.report.pathsChanged, false);
    assert.deepEqual(fixtureEntries(root), before);
  } finally {
    removeFixture(root);
  }
});

test('probe detects and blocks write streams without creating their target', () => {
  const root = createFixture({
    'stream-write.js': `
      const fs = require('node:fs');
      const stream = fs.createWriteStream(process.env.LOG_PATH);
      stream.end('blocked');
    `,
  });
  const before = fixtureEntries(root);

  try {
    const result = runImportProbe({ modules: [join(root, 'stream-write.js')], sourceRoot: root });

    assert.equal(result.status, 1);
    assert.deepEqual(
      result.report.violations.map(({ operation }) => operation),
      ['createWriteStream']
    );
    assert.equal(result.report.pathsChanged, false);
    assert.deepEqual(fixtureEntries(root), before);
  } finally {
    removeFixture(root);
  }
});

test('probe reports every non-baseline residual handle and resource type', () => {
  const root = createFixture({
    'residual-resource.js': `
      const { MessageChannel } = require('node:worker_threads');
      const channel = new MessageChannel();
      channel.port1.on('message', () => {});
      module.exports = channel;
    `,
  });

  try {
    const result = runImportProbe({ modules: [join(root, 'residual-resource.js')], sourceRoot: root });

    assert.equal(result.status, 1);
    assert.ok(result.report.newBackendHandles.includes('MessagePort'));
    assert.ok(result.report.newBackendResources.includes('MessagePort'));
    assert.equal(result.report.pathsChanged, false);
  } finally {
    removeFixture(root);
  }
});

test('probe accepts an inert fixture and removes its isolated runtime directory', () => {
  const root = createFixture({
    'inert.js': "module.exports = Object.freeze({ status: 'inert' });\n",
  });

  try {
    const result = runImportProbe({ modules: [join(root, 'inert.js')], sourceRoot: root });

    assert.equal(result.status, 0);
    assert.deepEqual(result.report.violations, []);
    assert.deepEqual(result.report.environmentMutations, []);
    assert.deepEqual(result.report.mutableConfigChanges, []);
    assert.deepEqual(result.report.newBackendHandles, []);
    assert.deepEqual(result.report.newBackendResources, []);
    assert.equal(result.report.pathsChanged, false);
    assert.equal(readFileSync(join(root, 'inert.js'), 'utf8').includes('inert'), true);
  } finally {
    removeFixture(root);
  }
});

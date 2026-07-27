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
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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

test('probe denies every child-process entry point without exposing commands or touching external targets', () => {
  const root = createFixture({
    'external/sentinel.txt': 'original',
    'source/placeholder.txt': '',
  });
  const sourceRoot = join(root, 'source');
  const externalTarget = join(root, 'external', 'sentinel.txt');
  const writeCode = `require('node:fs').writeFileSync(${JSON.stringify(externalTarget)}, 'changed')`;
  writeFileSync(
    join(sourceRoot, 'processes.js'),
    `
      const childProcess = require('node:child_process');
      const executable = process.execPath;
      const writeCode = ${JSON.stringify(writeCode)};
      const command = [JSON.stringify(executable), '-e', JSON.stringify(writeCode)].join(' ');
      childProcess.spawnSync(executable, ['-e', writeCode]);
      childProcess.execSync(command);
      childProcess.execFileSync(executable, ['-e', writeCode]);
      for (const invoke of [
        () => childProcess.spawn(null),
        () => childProcess.exec(null),
        () => childProcess.execFile(null),
        () => childProcess.fork(null),
        () => childProcess._forkChild(null),
      ]) {
        try { invoke(); } catch {}
      }
    `
  );

  try {
    const result = runImportProbe({
      modules: [join(sourceRoot, 'processes.js')],
      sourceRoot,
    });

    assert.equal(result.status, 1);
    assert.deepEqual(result.report.violations.map(({ operation }) => operation).sort(), [
      'child_process._forkChild',
      'child_process.exec',
      'child_process.execFile',
      'child_process.execFileSync',
      'child_process.execSync',
      'child_process.fork',
      'child_process.spawn',
      'child_process.spawnSync',
    ]);
    assert.equal(readFileSync(externalTarget, 'utf8'), 'original');
    assert.equal(JSON.stringify(result.report).includes(externalTarget), false);
  } finally {
    removeFixture(root);
  }
});

test('probe denies direct CommonJS and ESM ChildProcess launches without exposing their targets', () => {
  const root = createFixture({
    'external/cjs-sentinel.txt': 'original',
    'external/esm-sentinel.txt': 'original',
    'source/placeholder.txt': '',
  });
  const sourceRoot = join(root, 'source');
  const cjsTarget = join(root, 'external', 'cjs-sentinel.txt');
  const esmTarget = join(root, 'external', 'esm-sentinel.txt');

  function directLaunchSource(importStatement, target, changedValue) {
    const writeCode = `require('node:fs').writeFileSync(${JSON.stringify(target)}, ${JSON.stringify(changedValue)})`;
    return `
      ${importStatement}
      const target = ${JSON.stringify(target)};
      const child = new ChildProcess();
      child.spawn({
        stdio: 'ignore',
        detached: true,
        args: [process.execPath, '-e', ${JSON.stringify(writeCode)}],
        cwd: undefined,
        envPairs: Object.entries(process.env).map(entry => entry.join('=')),
        file: process.execPath,
        windowsHide: true,
        windowsVerbatimArguments: false,
      });
      child.unref();
      if (child.pid) {
        const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + 5000;
        while (readFileSync(target, 'utf8') === 'original' && Date.now() < deadline) {
          Atomics.wait(waitBuffer, 0, 0, 10);
        }
      }
    `;
  }

  writeFileSync(
    join(sourceRoot, 'direct-child.cjs'),
    directLaunchSource(
      "const { ChildProcess } = require('node:child_process'); const { readFileSync } = require('node:fs');",
      cjsTarget,
      'changed-cjs'
    )
  );
  writeFileSync(
    join(sourceRoot, 'direct-child.mjs'),
    directLaunchSource(
      "import { ChildProcess } from 'node:child_process'; import { readFileSync } from 'node:fs';",
      esmTarget,
      'changed-esm'
    )
  );

  try {
    const result = runImportProbe({
      modules: [join(sourceRoot, 'direct-child.cjs'), join(sourceRoot, 'direct-child.mjs')],
      sourceRoot,
    });

    assert.deepEqual(
      {
        status: result.status,
        operations: result.report.violations.map(({ operation }) => operation),
        cjsSentinel: readFileSync(cjsTarget, 'utf8'),
        esmSentinel: readFileSync(esmTarget, 'utf8'),
      },
      {
        status: 1,
        operations: ['child_process.ChildProcess.spawn', 'child_process.ChildProcess.spawn'],
        cjsSentinel: 'original',
        esmSentinel: 'original',
      }
    );
    assert.equal(JSON.stringify(result.report).includes(cjsTarget), false);
    assert.equal(JSON.stringify(result.report).includes(esmTarget), false);
  } finally {
    removeFixture(root);
  }
});

test('probe denies global, node:timers, and node:timers/promises scheduling entry points', () => {
  const root = createFixture({
    'timers.js': `
      const timers = require('node:timers');
      const timerPromises = require('node:timers/promises');
      setImmediate(() => {});
      timers.setTimeout(() => {}, 1).unref();
      timers.setInterval(() => {}, 1).unref();
      timers.setImmediate(() => {}).unref();
      void timerPromises.setTimeout(1, undefined, { ref: false });
      void timerPromises.setImmediate(undefined, { ref: false });
      void timerPromises.setInterval(1, undefined, { ref: false }).next();
      void timerPromises.scheduler.wait(1);
      void timerPromises.scheduler.yield();
    `,
  });

  try {
    const result = runImportProbe({ modules: [join(root, 'timers.js')], sourceRoot: root });

    assert.equal(result.status, 1);
    assert.deepEqual(result.report.violations.map(({ operation }) => operation).sort(), [
      'setImmediate',
      'timers.setImmediate',
      'timers.setInterval',
      'timers.setTimeout',
      'timers/promises.scheduler.wait',
      'timers/promises.scheduler.yield',
      'timers/promises.setImmediate',
      'timers/promises.setInterval',
      'timers/promises.setTimeout',
    ]);
  } finally {
    removeFixture(root);
  }
});

test('probe denies Worker construction without touching external targets', () => {
  const root = createFixture({
    'external/sentinel.txt': 'original',
    'source/worker.js': `
      const { Worker } = require('node:worker_threads');
      new Worker("process.exit(0)", { eval: true });
    `,
  });
  const sourceRoot = join(root, 'source');
  const externalTarget = join(root, 'external', 'sentinel.txt');

  try {
    const result = runImportProbe({ modules: [join(sourceRoot, 'worker.js')], sourceRoot });

    assert.equal(result.status, 1);
    assert.ok(result.report.violations.some(({ operation }) => operation === 'worker_threads.Worker'));
    assert.equal(readFileSync(externalTarget, 'utf8'), 'original');
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

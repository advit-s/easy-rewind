const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const test = require('node:test');

const backendRoot = resolve(__dirname, '..');

function productionModules(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'test' || entry.name === 'tests' || entry.name === 'data'
        ? []
        : productionModules(absolutePath);
    }
    return entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') ? [absolutePath] : [];
  });
}

test('importing every backend production module is inert', () => {
  const modules = [join(backendRoot, 'server.js'), ...productionModules(join(backendRoot, 'routes'))];
  const childScript = String.raw`
    'use strict';
    const fs = require('node:fs');
    const net = require('node:net');
    const os = require('node:os');
    const path = require('node:path');

    const modules = JSON.parse(process.env.EASY_REWIND_IMPORT_MODULES);
    const backendRoot = process.env.EASY_REWIND_IMPORT_BACKEND_ROOT;
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-rewind-import-safety-'));
    const runtimePaths = {
      database: path.join(runtimeRoot, 'database.sqlite'),
      settings: path.join(runtimeRoot, 'settings.json'),
      log: path.join(runtimeRoot, 'backend.log'),
      export: path.join(runtimeRoot, 'export.json'),
    };
    Object.assign(process.env, {
      DATABASE_PATH: runtimePaths.database,
      SETTINGS_PATH: runtimePaths.settings,
      LOG_PATH: runtimePaths.log,
      EXPORT_PATH: runtimePaths.export,
      EASY_REWIND_SCHEDULERS_ENABLED: 'false',
      GEMINI_API_KEY: '',
    });

    const repositoryData = path.join(backendRoot, 'data');
    const snapshotPaths = roots => {
      const entries = [];
      for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        const pending = [root];
        while (pending.length > 0) {
          const current = pending.pop();
          for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const absolute = path.join(current, entry.name);
            entries.push(path.relative(root, absolute).replaceAll('\\', '/'));
            if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(absolute);
          }
        }
      }
      return entries.sort();
    };

    const violations = [];
    const activeHandlesBefore = process._getActiveHandles().filter(handle => handle !== process.stdout && handle !== process.stderr);
    const activeResourcesBefore = process.getActiveResourcesInfo();
    const pathsBefore = snapshotPaths([repositoryData, runtimeRoot]);
    const original = {
      appendFileSync: fs.appendFileSync,
      mkdirSync: fs.mkdirSync,
      openSync: fs.openSync,
      readFileSync: fs.readFileSync,
      setInterval: global.setInterval,
      setTimeout: global.setTimeout,
      writeFileSync: fs.writeFileSync,
      listen: net.Server.prototype.listen,
    };

    const recordPath = (operation, target) => {
      const absolute = path.resolve(String(target));
      if (absolute.startsWith(path.resolve(backendRoot)) || absolute.startsWith(path.resolve(runtimeRoot))) {
        violations.push({ operation, path: path.relative(path.dirname(backendRoot), absolute).replaceAll('\\', '/') });
        return true;
      }
      return false;
    };

    fs.readFileSync = function(target, ...args) {
      if (String(target).endsWith('.env')) recordPath('readFileSync', target);
      return original.readFileSync.call(this, target, ...args);
    };
    fs.writeFileSync = function(target, ...args) {
      if (recordPath('writeFileSync', target)) return;
      return original.writeFileSync.call(this, target, ...args);
    };
    fs.appendFileSync = function(target, ...args) {
      if (recordPath('appendFileSync', target)) return;
      return original.appendFileSync.call(this, target, ...args);
    };
    fs.mkdirSync = function(target, ...args) {
      if (recordPath('mkdirSync', target)) return target;
      return original.mkdirSync.call(this, target, ...args);
    };
    fs.openSync = function(target, flags, ...args) {
      if (/[wa+]/.test(String(flags)) && recordPath('openSync', target)) {
        throw new Error('blocked import-time open');
      }
      return original.openSync.call(this, target, flags, ...args);
    };
    global.setInterval = function() {
      violations.push({ operation: 'setInterval' });
      return { unref() {} };
    };
    global.setTimeout = function() {
      violations.push({ operation: 'setTimeout' });
      return { unref() {} };
    };
    net.Server.prototype.listen = function() {
      violations.push({ operation: 'listen' });
      return this;
    };

    let importError;
    try {
      for (const modulePath of modules) require(modulePath);
    } catch (error) {
      importError = { name: error.name, message: error.message };
    }

    setImmediate(() => {
      const activeHandlesAfter = process._getActiveHandles().filter(
        handle => handle !== process.stdout && handle !== process.stderr
      );
      const newBackendHandles = activeHandlesAfter
        .filter(handle => !activeHandlesBefore.includes(handle))
        .filter(handle => handle instanceof net.Server || handle?.constructor?.name === 'Timeout')
        .map(handle => handle.constructor.name);
      const activeResourcesAfter = process.getActiveResourcesInfo();
      const targetedResources = ['TCPSERVERWRAP', 'Timeout'];
      const newBackendResources = targetedResources.flatMap(resource => {
        const beforeCount = activeResourcesBefore.filter(value => value === resource).length;
        const afterCount = activeResourcesAfter.filter(value => value === resource).length;
        return Array(Math.max(0, afterCount - beforeCount)).fill(resource);
      });
      const pathsAfter = snapshotPaths([repositoryData, runtimeRoot]);

      Object.assign(fs, {
        appendFileSync: original.appendFileSync,
        mkdirSync: original.mkdirSync,
        openSync: original.openSync,
        readFileSync: original.readFileSync,
        writeFileSync: original.writeFileSync,
      });
      global.setInterval = original.setInterval;
      global.setTimeout = original.setTimeout;
      net.Server.prototype.listen = original.listen;
      fs.rmSync(runtimeRoot, { recursive: true, force: true });

      const report = {
        imported: modules.length,
        importError,
        violations,
        newBackendHandles,
        newBackendResources,
        pathsChanged: JSON.stringify(pathsBefore) !== JSON.stringify(pathsAfter),
      };
      process.stdout.write('\nIMPORT_SAFETY_REPORT:' + JSON.stringify(report) + '\n');
      process.exitCode =
        importError ||
        violations.length ||
        newBackendHandles.length ||
        newBackendResources.length ||
        report.pathsChanged
          ? 1
          : 0;
    }, 0);
  `;

  const result = spawnSync(process.execPath, ['-e', childScript], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      EASY_REWIND_IMPORT_MODULES: JSON.stringify(modules),
      EASY_REWIND_IMPORT_BACKEND_ROOT: backendRoot,
    },
    timeout: 30_000,
    windowsHide: true,
  });
  const reportMatch = /IMPORT_SAFETY_REPORT:(\{.*\})/.exec(result.stdout);
  assert.notEqual(reportMatch, null, `import-safety child did not report:\n${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(reportMatch[1]);

  assert.equal(
    result.status,
    0,
    `backend imports were not inert:\n${JSON.stringify(report, null, 2)}\n${result.stderr}`
  );
  assert.equal(report.imported, modules.length);
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.newBackendHandles, []);
  assert.deepEqual(report.newBackendResources, []);
  assert.equal(report.pathsChanged, false);
});

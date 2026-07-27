'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const { syncBuiltinESMExports } = require('node:module');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');

const modules = JSON.parse(process.env.EASY_REWIND_IMPORT_MODULES);
const sourceRoot = path.resolve(process.env.EASY_REWIND_IMPORT_SOURCE_ROOT);
const mutableExportTargets = JSON.parse(process.env.EASY_REWIND_IMPORT_MUTABLE_EXPORTS);
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

function stableValue(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function') return '[function]';
    if (typeof value === 'bigint') return `[bigint:${value}]`;
    return value;
  }
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(entry => stableValue(entry, seen));
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, stableValue(value[key], seen)])
  );
}

function fingerprint(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

function snapshotPaths(roots) {
  const entries = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const pending = [root];
    while (pending.length > 0) {
      const current = pending.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name);
        const label = path.relative(root, absolute).replaceAll('\\', '/');
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          entries.push(`${label}:directory`);
          pending.push(absolute);
        } else if (entry.isFile()) {
          const digest = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
          entries.push(`${label}:file:${digest}`);
        } else {
          entries.push(`${label}:other`);
        }
      }
    }
  }
  return entries.sort();
}

function safeName(value, fallback) {
  return typeof value === 'string' && /^[A-Za-z0-9_$.-]+$/.test(value) ? value : fallback;
}

function safeModuleLabel(modulePath) {
  const absolute = path.resolve(modulePath);
  const relativePath = path.relative(sourceRoot, absolute);
  if (
    relativePath !== '' &&
    path.isAbsolute(relativePath) === false &&
    relativePath !== '..' &&
    relativePath.startsWith(`..${path.sep}`) === false
  ) {
    return `source/${relativePath.replaceAll('\\', '/')}`;
  }
  return 'external-module';
}

function safePath(target) {
  if (typeof target !== 'string' && !Buffer.isBuffer(target) && !(target instanceof URL)) return 'descriptor';
  const absolute = path.resolve(String(target));
  const sourceRelative = path.relative(sourceRoot, absolute);
  if (
    sourceRelative === '' ||
    (path.isAbsolute(sourceRelative) === false &&
      sourceRelative !== '..' &&
      sourceRelative.startsWith(`..${path.sep}`) === false)
  ) {
    return sourceRelative ? `source/${sourceRelative.replaceAll('\\', '/')}` : 'source';
  }
  const runtimeRelative = path.relative(runtimeRoot, absolute);
  if (
    runtimeRelative === '' ||
    (path.isAbsolute(runtimeRelative) === false &&
      runtimeRelative !== '..' &&
      runtimeRelative.startsWith(`..${path.sep}`) === false)
  ) {
    return runtimeRelative ? `runtime/${runtimeRelative.replaceAll('\\', '/')}` : 'runtime';
  }
  return 'external';
}

function opensForWrite(flags) {
  if (typeof flags === 'number') {
    const writeMask =
      fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_TRUNC;
    return (flags & writeMask) !== 0;
  }
  return /[wax+]/.test(String(flags));
}

const pathsBefore = snapshotPaths([sourceRoot, runtimeRoot]);
const violations = [];
const environmentMutations = [];
const environmentMutationKeys = new Set();
const originalEnvironment = process.env;
const environmentDescriptor = Object.getOwnPropertyDescriptor(process, 'env');
const environmentBaseline = Object.fromEntries(Object.entries(originalEnvironment));
const original = {
  fs: new Map(),
  fsPromises: new Map(),
  listen: net.Server.prototype.listen,
  setInterval: global.setInterval,
  setTimeout: global.setTimeout,
};

function recordViolation(operation, target) {
  violations.push({ operation, path: safePath(target) });
}

function recordEnvironmentMutation(operation, key) {
  const safeKey = safeName(String(key), 'unsafe-key');
  const identity = `${operation}:${safeKey}`;
  if (environmentMutationKeys.has(identity)) return;
  environmentMutationKeys.add(identity);
  environmentMutations.push({ operation, key: safeKey });
}

const environmentProxy = new Proxy(originalEnvironment, {
  set(target, key, value) {
    const existed = Object.hasOwn(target, key);
    const before = target[key];
    const updated = Reflect.set(target, key, value, target);
    if (!existed || target[key] !== before) recordEnvironmentMutation('set', key);
    return updated;
  },
  defineProperty(target, key, descriptor) {
    const before = Object.getOwnPropertyDescriptor(target, key);
    const updated = Reflect.defineProperty(target, key, descriptor);
    const after = Object.getOwnPropertyDescriptor(target, key);
    if (JSON.stringify(before) !== JSON.stringify(after)) recordEnvironmentMutation('define', key);
    return updated;
  },
  deleteProperty(target, key) {
    const existed = Object.hasOwn(target, key);
    const deleted = Reflect.deleteProperty(target, key);
    if (existed && deleted) recordEnvironmentMutation('delete', key);
    return deleted;
  },
});
Object.defineProperty(process, 'env', {
  ...environmentDescriptor,
  value: environmentProxy,
});

function replace(target, originals, name, implementation) {
  if (typeof target[name] !== 'function') return;
  originals.set(name, target[name]);
  target[name] = implementation;
}

function callbackFrom(args) {
  return [...args].reverse().find(argument => typeof argument === 'function');
}

function completeCallback(args, ...values) {
  const callback = callbackFrom(args);
  if (callback) queueMicrotask(() => callback(null, ...values));
}

for (const name of [
  'appendFileSync',
  'chmodSync',
  'chownSync',
  'copyFileSync',
  'cpSync',
  'fdatasyncSync',
  'fchmodSync',
  'fchownSync',
  'fsyncSync',
  'ftruncateSync',
  'futimesSync',
  'lchmodSync',
  'lchownSync',
  'linkSync',
  'lutimesSync',
  'mkdirSync',
  'mkdtempSync',
  'renameSync',
  'rmSync',
  'rmdirSync',
  'symlinkSync',
  'truncateSync',
  'unlinkSync',
  'utimesSync',
  'writeFileSync',
  'writeSync',
  'writevSync',
]) {
  replace(fs, original.fs, name, function (target) {
    recordViolation(name, target);
    return name === 'mkdirSync' || name === 'mkdtempSync' ? target : undefined;
  });
}

replace(fs, original.fs, 'readFileSync', function (target, ...args) {
  if (String(target).endsWith('.env')) recordViolation('readFileSync', target);
  return original.fs.get('readFileSync').call(this, target, ...args);
});

replace(fs, original.fs, 'openSync', function (target, flags, ...args) {
  if (opensForWrite(flags)) {
    recordViolation('openSync', target);
    return -1;
  }
  return original.fs.get('openSync').call(this, target, flags, ...args);
});

replace(fs, original.fs, 'mkdtempDisposableSync', function (target) {
  recordViolation('mkdtempDisposableSync', target);
  return {
    path: target,
    remove() {},
    [Symbol.dispose]() {},
  };
});

for (const name of [
  'appendFile',
  'chmod',
  'chown',
  'copyFile',
  'cp',
  'fdatasync',
  'fchmod',
  'fchown',
  'fsync',
  'ftruncate',
  'futimes',
  'lchmod',
  'lchown',
  'link',
  'lutimes',
  'mkdir',
  'mkdtemp',
  'rename',
  'rm',
  'rmdir',
  'symlink',
  'truncate',
  'unlink',
  'utimes',
  'write',
  'writeFile',
  'writev',
]) {
  replace(fs, original.fs, name, function (target, ...args) {
    recordViolation(name, target);
    completeCallback(args, name === 'mkdir' || name === 'mkdtemp' ? target : undefined);
    return undefined;
  });
}

replace(fs, original.fs, 'open', function (target, flags, ...args) {
  if (opensForWrite(flags)) {
    recordViolation('open', target);
    completeCallback(args, -1);
    return undefined;
  }
  return original.fs.get('open').call(this, target, flags, ...args);
});

replace(fs, original.fs, 'createWriteStream', function (target) {
  recordViolation('createWriteStream', target);
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
});

for (const name of [
  'appendFile',
  'chmod',
  'chown',
  'copyFile',
  'cp',
  'lchmod',
  'lchown',
  'link',
  'lutimes',
  'mkdir',
  'mkdtemp',
  'rename',
  'rm',
  'rmdir',
  'symlink',
  'truncate',
  'unlink',
  'utimes',
  'writeFile',
]) {
  replace(fsPromises, original.fsPromises, name, async function (target) {
    recordViolation(`promises.${name}`, target);
    return name === 'mkdir' || name === 'mkdtemp' ? target : undefined;
  });
}

replace(fsPromises, original.fsPromises, 'open', async function (target, flags) {
  if (!opensForWrite(flags)) return original.fsPromises.get('open').call(this, target, flags);
  recordViolation('promises.open', target);
  return {
    fd: -1,
    async appendFile() {
      recordViolation('fileHandle.appendFile', target);
    },
    async chmod() {
      recordViolation('fileHandle.chmod', target);
    },
    async chown() {
      recordViolation('fileHandle.chown', target);
    },
    async close() {},
    createWriteStream() {
      recordViolation('fileHandle.createWriteStream', target);
      return new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
    },
    async datasync() {
      recordViolation('fileHandle.datasync', target);
    },
    async sync() {
      recordViolation('fileHandle.sync', target);
    },
    async truncate() {
      recordViolation('fileHandle.truncate', target);
    },
    async utimes() {
      recordViolation('fileHandle.utimes', target);
    },
    async write() {
      recordViolation('fileHandle.write', target);
    },
    async writeFile() {
      recordViolation('fileHandle.writeFile', target);
    },
    async writev() {
      recordViolation('fileHandle.writev', target);
    },
  };
});

replace(fsPromises, original.fsPromises, 'mkdtempDisposable', async function (target) {
  recordViolation('promises.mkdtempDisposable', target);
  return {
    path: target,
    async remove() {},
    async [Symbol.asyncDispose]() {},
  };
});

global.setInterval = function () {
  violations.push({ operation: 'setInterval', path: 'scheduler' });
  return {
    hasRef: () => false,
    ref() {
      return this;
    },
    refresh() {
      return this;
    },
    unref() {
      return this;
    },
  };
};
global.setTimeout = function () {
  violations.push({ operation: 'setTimeout', path: 'scheduler' });
  return {
    hasRef: () => false,
    ref() {
      return this;
    },
    refresh() {
      return this;
    },
    unref() {
      return this;
    },
  };
};
net.Server.prototype.listen = function () {
  violations.push({ operation: 'listen', path: 'listener' });
  return this;
};
syncBuiltinESMExports();

const stdioHandles = [process.stdin, process.stdout, process.stderr];
const activeHandlesBefore = process._getActiveHandles();
const activeHandleBaseline = new Set(activeHandlesBefore);
const activeResourcesBefore = process.getActiveResourcesInfo();
const configFingerprints = new Map();
let importError;

try {
  for (const target of mutableExportTargets) {
    const imported = require(target.modulePath);
    configFingerprints.set(
      `${path.resolve(target.modulePath)}\0${target.exportName}`,
      fingerprint(imported[target.exportName])
    );
  }
  for (const modulePath of modules) require(modulePath);
} catch (error) {
  importError = { name: safeName(error?.name, 'Error') };
}

function restoreEnvironment() {
  Object.defineProperty(process, 'env', {
    ...environmentDescriptor,
    value: originalEnvironment,
  });
  for (const key of Object.keys(originalEnvironment)) {
    if (!Object.hasOwn(environmentBaseline, key)) delete originalEnvironment[key];
  }
  for (const [key, value] of Object.entries(environmentBaseline)) originalEnvironment[key] = value;
}

function restoreFilesystem() {
  for (const [name, implementation] of original.fs) fs[name] = implementation;
  for (const [name, implementation] of original.fsPromises) fsPromises[name] = implementation;
  global.setInterval = original.setInterval;
  global.setTimeout = original.setTimeout;
  net.Server.prototype.listen = original.listen;
  syncBuiltinESMExports();
}

function subtractResourceTypes(before, after) {
  const counts = new Map();
  for (const type of before) counts.set(type, (counts.get(type) || 0) + 1);
  const additions = [];
  for (const type of after) {
    const remaining = counts.get(type) || 0;
    if (remaining > 0) counts.set(type, remaining - 1);
    else additions.push(safeName(type, 'UnknownResource'));
  }
  return additions.sort();
}

function handleType(handle) {
  return safeName(handle?.constructor?.name, 'UnknownHandle');
}

async function settleEventLoop() {
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function main() {
  await settleEventLoop();
  const mutableConfigChanges = [];
  for (const target of mutableExportTargets) {
    const key = `${path.resolve(target.modulePath)}\0${target.exportName}`;
    const imported = require(target.modulePath);
    if (configFingerprints.get(key) !== fingerprint(imported[target.exportName])) {
      mutableConfigChanges.push({
        module: safeModuleLabel(target.modulePath),
        exportName: safeName(target.exportName, 'unsafe-export'),
      });
    }
  }

  const activeHandlesAfter = process._getActiveHandles();
  const newBackendHandles = activeHandlesAfter
    .filter(handle => activeHandleBaseline.has(handle) === false)
    .map(handleType)
    .sort();
  const activeResourcesAfter = process.getActiveResourcesInfo();
  const newBackendResources = subtractResourceTypes(activeResourcesBefore, activeResourcesAfter);
  const pathsAfter = snapshotPaths([sourceRoot, runtimeRoot]);
  const pathsChanged = JSON.stringify(pathsBefore) !== JSON.stringify(pathsAfter);
  const report = {
    imported: modules.length,
    importError,
    violations,
    environmentMutations,
    mutableConfigChanges,
    newBackendHandles,
    newBackendResources,
    pathsChanged,
  };
  const status =
    importError ||
    violations.length ||
    environmentMutations.length ||
    mutableConfigChanges.length ||
    newBackendHandles.length ||
    newBackendResources.length ||
    pathsChanged
      ? 1
      : 0;

  restoreEnvironment();
  restoreFilesystem();
  for (const handle of activeHandlesAfter) {
    if (activeHandleBaseline.has(handle)) continue;
    try {
      handle.close?.();
      handle.destroy?.();
    } catch {
      // The isolated child is terminated after reporting.
    }
  }
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  void stdioHandles;
  process.stdout.write(`\nIMPORT_SAFETY_REPORT:${JSON.stringify(report)}\n`, () => process.exit(status));
}

main().catch(error => {
  restoreEnvironment();
  restoreFilesystem();
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  const report = {
    imported: modules.length,
    importError: { name: safeName(error?.name, 'Error') },
    violations,
    environmentMutations,
    mutableConfigChanges: [],
    newBackendHandles: [],
    newBackendResources: [],
    pathsChanged: true,
  };
  process.stdout.write(`\nIMPORT_SAFETY_REPORT:${JSON.stringify(report)}\n`, () => process.exit(1));
});

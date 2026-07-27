'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const { syncBuiltinESMExports } = require('node:module');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const timers = require('node:timers');
const timerPromises = require('node:timers/promises');
const workerThreads = require('node:worker_threads');

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
const runtimePropertyRestorations = [];
const original = {
  fs: new Map(),
  fsPromises: new Map(),
  listen: net.Server.prototype.listen,
  setImmediate: global.setImmediate,
  setInterval: global.setInterval,
  setTimeout: global.setTimeout,
};

function recordViolation(operation, target) {
  violations.push({ operation, path: safePath(target) });
}

function recordRuntimeViolation(operation, category) {
  violations.push({ operation, path: category });
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

function replaceRuntimeProperty(target, name, implementation) {
  if (typeof target[name] !== 'function') return;
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  runtimePropertyRestorations.push({
    target,
    name,
    descriptor,
  });
  Object.defineProperty(target, name, {
    configurable: descriptor?.configurable ?? true,
    enumerable: descriptor?.enumerable ?? true,
    writable: descriptor?.writable ?? true,
    value: implementation,
  });
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

function deniedTimerHandle() {
  return {
    close() {},
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
    [Symbol.toPrimitive]() {
      return 0;
    },
  };
}

function deniedAsyncIterator() {
  return {
    async next() {
      return { done: true, value: undefined };
    },
    async return() {
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

class DeniedChildProcess extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.exitCode = 0;
    this.killed = true;
    this.pid = undefined;
    this.signalCode = null;
    this.stderr = null;
    this.stdin = null;
    this.stdout = null;
  }

  disconnect() {}

  kill() {
    return false;
  }

  ref() {
    return this;
  }

  send() {
    return false;
  }

  unref() {
    return this;
  }
}

replaceRuntimeProperty(childProcess.ChildProcess.prototype, 'spawn', function () {
  recordRuntimeViolation('child_process.ChildProcess.spawn', 'process');
});

for (const name of ['spawn', 'exec', 'execFile', 'fork']) {
  replaceRuntimeProperty(childProcess, name, function () {
    recordRuntimeViolation(`child_process.${name}`, 'process');
    return new DeniedChildProcess();
  });
}

replaceRuntimeProperty(childProcess, '_forkChild', function () {
  recordRuntimeViolation('child_process._forkChild', 'process');
  return new DeniedChildProcess();
});

replaceRuntimeProperty(childProcess, 'spawnSync', function () {
  recordRuntimeViolation('child_process.spawnSync', 'process');
  return {
    error: undefined,
    output: [null, Buffer.alloc(0), Buffer.alloc(0)],
    pid: 0,
    signal: null,
    status: 0,
    stderr: Buffer.alloc(0),
    stdout: Buffer.alloc(0),
  };
});

for (const name of ['execSync', 'execFileSync']) {
  replaceRuntimeProperty(childProcess, name, function () {
    recordRuntimeViolation(`child_process.${name}`, 'process');
    return Buffer.alloc(0);
  });
}

class DeniedWorker extends EventEmitter {
  constructor() {
    super();
    recordRuntimeViolation('worker_threads.Worker', 'worker');
    this.performance = Object.freeze({});
    this.resourceLimits = Object.freeze({});
    this.stderr = null;
    this.stdin = null;
    this.stdout = null;
    this.threadId = -1;
  }

  getHeapSnapshot() {
    return Promise.resolve();
  }

  postMessage() {}

  ref() {
    return this;
  }

  terminate() {
    return Promise.resolve(0);
  }

  unref() {
    return this;
  }
}

replaceRuntimeProperty(workerThreads, 'Worker', DeniedWorker);

global.setInterval = function () {
  recordRuntimeViolation('setInterval', 'scheduler');
  return deniedTimerHandle();
};
global.setTimeout = function () {
  recordRuntimeViolation('setTimeout', 'scheduler');
  return deniedTimerHandle();
};
global.setImmediate = function () {
  recordRuntimeViolation('setImmediate', 'scheduler');
  return deniedTimerHandle();
};

for (const name of ['setInterval', 'setTimeout', 'setImmediate']) {
  replaceRuntimeProperty(timers, name, function () {
    recordRuntimeViolation(`timers.${name}`, 'scheduler');
    return deniedTimerHandle();
  });
}

replaceRuntimeProperty(timerPromises, 'setTimeout', function (_delay, value) {
  recordRuntimeViolation('timers/promises.setTimeout', 'scheduler');
  return Promise.resolve(value);
});
replaceRuntimeProperty(timerPromises, 'setImmediate', function (value) {
  recordRuntimeViolation('timers/promises.setImmediate', 'scheduler');
  return Promise.resolve(value);
});
replaceRuntimeProperty(timerPromises, 'setInterval', function () {
  recordRuntimeViolation('timers/promises.setInterval', 'scheduler');
  return deniedAsyncIterator();
});
for (const name of ['wait', 'yield']) {
  replaceRuntimeProperty(timerPromises.scheduler, name, function () {
    recordRuntimeViolation(`timers/promises.scheduler.${name}`, 'scheduler');
    return Promise.resolve();
  });
}

net.Server.prototype.listen = function () {
  recordRuntimeViolation('listen', 'listener');
  return this;
};
syncBuiltinESMExports();

const processEventNames = process.eventNames.bind(process);
const processRawListeners = process.rawListeners.bind(process);
function probeBaselineProcessListener() {}
process.on('easy-rewind-import-probe-baseline', probeBaselineProcessListener);
const processListenerBaseline = new Map(
  processEventNames().map(eventName => [eventName, processRawListeners(eventName)])
);
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
  for (const restoration of runtimePropertyRestorations.reverse()) {
    if (restoration.descriptor) {
      Object.defineProperty(restoration.target, restoration.name, restoration.descriptor);
    } else {
      delete restoration.target[restoration.name];
    }
  }
  runtimePropertyRestorations.length = 0;
  global.setImmediate = original.setImmediate;
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

function retainBaselineProcessListeners(eventName, currentListeners) {
  const remaining = new Map();
  for (const listener of processListenerBaseline.get(eventName) || []) {
    remaining.set(listener, (remaining.get(listener) || 0) + 1);
  }

  const retained = [];
  for (const listener of currentListeners) {
    const count = remaining.get(listener) || 0;
    if (count === 0) continue;
    retained.push(listener);
    remaining.set(listener, count - 1);
  }
  return retained;
}

function replaceRawProcessListeners(eventName, listeners) {
  const events = process._events;
  if (!events || typeof events !== 'object') throw new Error('Process listener table unavailable');
  if (listeners.length === 0) {
    Reflect.deleteProperty(events, eventName);
  } else {
    Reflect.set(events, eventName, listeners.length === 1 ? listeners[0] : listeners);
  }
}

function removeImportedProcessListeners() {
  let removed = 0;
  for (const eventName of processEventNames()) {
    const currentListeners = processRawListeners(eventName);
    const retainedListeners = retainBaselineProcessListeners(eventName, currentListeners);
    if (retainedListeners.length === currentListeners.length) continue;
    removed += currentListeners.length - retainedListeners.length;
    replaceRawProcessListeners(eventName, retainedListeners);
  }

  if (process._events && typeof process._events === 'object') {
    process._eventsCount = Reflect.ownKeys(process._events).length;
  }
  for (let index = 0; index < removed; index += 1) {
    recordRuntimeViolation('process.listener', 'process');
  }
}

function baselineProcessListenersRemain() {
  for (const [eventName, baselineListeners] of processListenerBaseline) {
    const remaining = new Map();
    for (const listener of processRawListeners(eventName)) {
      remaining.set(listener, (remaining.get(listener) || 0) + 1);
    }
    for (const listener of baselineListeners) {
      const count = remaining.get(listener) || 0;
      if (count === 0) return false;
      remaining.set(listener, count - 1);
    }
  }
  return true;
}

async function settleEventLoop() {
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise(resolve => original.setImmediate(resolve));
  }
}

function cleanupProbe(activeHandles = []) {
  let importedListenersRemoved = false;
  try {
    removeImportedProcessListeners();
    for (const handle of activeHandles) {
      if (activeHandleBaseline.has(handle)) continue;
      try {
        handle.close?.();
        handle.destroy?.();
        handle.terminate?.();
      } catch {
        // The isolated child is terminated after reporting.
      }
    }
    removeImportedProcessListeners();
    importedListenersRemoved = true;
  } finally {
    if (importedListenersRemoved) {
      try {
        restoreEnvironment();
      } finally {
        try {
          restoreFilesystem();
        } finally {
          original.fs.get('rmSync').call(fs, runtimeRoot, { recursive: true, force: true });
        }
      }
    } else {
      original.fs.get('rmSync').call(fs, runtimeRoot, { recursive: true, force: true });
    }
  }
}

async function main() {
  let activeHandlesAfter = [];
  let baselineProcessListenersPreserved = true;
  let report;
  let status;
  try {
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

    removeImportedProcessListeners();
    baselineProcessListenersPreserved = baselineProcessListenersRemain();
    if (!baselineProcessListenersPreserved) {
      recordRuntimeViolation('process.listenerBaseline', 'process');
    }
    activeHandlesAfter = process._getActiveHandles();
    const newBackendHandles = activeHandlesAfter
      .filter(handle => activeHandleBaseline.has(handle) === false)
      .map(handleType)
      .sort();
    const activeResourcesAfter = process.getActiveResourcesInfo();
    const newBackendResources = subtractResourceTypes(activeResourcesBefore, activeResourcesAfter);
    const pathsAfter = snapshotPaths([sourceRoot, runtimeRoot]);
    const pathsChanged = JSON.stringify(pathsBefore) !== JSON.stringify(pathsAfter);
    report = {
      imported: modules.length,
      importError,
      violations,
      environmentMutations,
      mutableConfigChanges,
      newBackendHandles,
      newBackendResources,
      pathsChanged,
      baselineProcessListenersPreserved,
    };
    status =
      importError ||
      violations.length ||
      environmentMutations.length ||
      mutableConfigChanges.length ||
      newBackendHandles.length ||
      newBackendResources.length ||
      pathsChanged
        ? 1
        : 0;
  } finally {
    cleanupProbe(activeHandlesAfter);
  }

  void stdioHandles;
  process.stdout.write(`\nIMPORT_SAFETY_REPORT:${JSON.stringify(report)}\n`, () => process.exit(status));
}

main().catch(error => {
  cleanupProbe();
  const report = {
    imported: modules.length,
    importError: { name: safeName(error?.name, 'Error') },
    violations,
    environmentMutations,
    mutableConfigChanges: [],
    newBackendHandles: [],
    newBackendResources: [],
    pathsChanged: true,
    baselineProcessListenersPreserved: baselineProcessListenersRemain(),
  };
  process.stdout.write(`\nIMPORT_SAFETY_REPORT:${JSON.stringify(report)}\n`, () => process.exit(1));
});

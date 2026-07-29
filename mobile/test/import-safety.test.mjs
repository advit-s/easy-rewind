import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const mobileRoot = path.resolve(import.meta.dirname, '..');

async function collectTypeScriptModules(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const modules = [];

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        modules.push(...(await collectTypeScriptModules(absolutePath)));
      } else if (entry.isFile() && absolutePath.endsWith('.ts') && !absolutePath.endsWith('.d.ts')) {
        modules.push(absolutePath);
      }
    }

    return modules;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function forbiddenOperation(name) {
  return () => {
    throw new Error(`${name} must not run while importing mobile modules`);
  };
}

test('mobile core imports are inert with injected throwing platform ports', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const originalSetTimeout = globalThis.setTimeout;

  globalThis.fetch = forbiddenOperation('network request');
  globalThis.setInterval = forbiddenOperation('interval');
  globalThis.setTimeout = forbiddenOperation('timer');

  try {
    const portsModule = await import(pathToFileURL(path.join(mobileRoot, 'src', 'platform', 'ports.ts')).href);
    const calls = [];
    const throwingPorts = {
      credentials: {
        get: forbiddenOperation('secure credential read'),
        set: forbiddenOperation('secure credential write'),
        remove: forbiddenOperation('secure credential removal'),
      },
      transport: {
        request: forbiddenOperation('pinned network request'),
      },
      scheduler: {
        register: forbiddenOperation('background scheduler registration'),
        unregister: forbiddenOperation('background scheduler removal'),
      },
      notifications: {
        schedule: forbiddenOperation('notification scheduling'),
        cancel: forbiddenOperation('notification cancellation'),
      },
      network: {
        getStatus: forbiddenOperation('network status read'),
        subscribe: forbiddenOperation('network listener registration'),
      },
      clock: {
        now: forbiddenOperation('clock read'),
      },
    };

    assert.equal(
      portsModule.definePlatformPorts(throwingPorts),
      throwingPorts,
      'port injection must not eagerly call an adapter'
    );

    const moduleDirectories = ['db', 'domain', 'sync'];
    for (const directory of moduleDirectories) {
      const modules = await collectTypeScriptModules(path.join(mobileRoot, 'src', directory));
      for (const modulePath of modules) {
        await import(pathToFileURL(modulePath).href);
        calls.push(modulePath);
      }
    }

    assert.deepEqual(calls, calls.slice(), 'all discovered imports completed');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalSetInterval;
    globalThis.setTimeout = originalSetTimeout;
  }
});

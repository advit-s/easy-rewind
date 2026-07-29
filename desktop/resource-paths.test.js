'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function expectedDevelopmentPaths(desktopDirectory) {
  const repositoryRoot = path.dirname(desktopDirectory);
  return {
    backendModuleRoot: path.join(repositoryRoot, 'backend'),
    dashboardDirectory: path.join(repositoryRoot, 'frontend'),
    iconPath: path.join(desktopDirectory, 'assets', 'tray-icon.png'),
    overlayPath: path.join(desktopDirectory, 'overlay.html'),
    overlayStylePath: path.join(desktopDirectory, 'overlay.css'),
    preloadPath: path.join(desktopDirectory, 'preload.js'),
  };
}

function expectedPackagedPaths(resourcesPath) {
  const applicationRoot = path.join(resourcesPath, 'app.asar');
  return {
    backendModuleRoot: path.join(applicationRoot, 'backend'),
    dashboardDirectory: path.join(applicationRoot, 'frontend'),
    iconPath: path.join(applicationRoot, 'desktop', 'assets', 'tray-icon.png'),
    overlayPath: path.join(applicationRoot, 'desktop', 'overlay.html'),
    overlayStylePath: path.join(applicationRoot, 'desktop', 'overlay.css'),
    preloadPath: path.join(applicationRoot, 'desktop', 'preload.js'),
  };
}

function fileSystemFor(resourcePaths, missingPath) {
  const directories = new Set([resourcePaths.backendModuleRoot, resourcePaths.dashboardDirectory]);
  const files = new Set([
    resourcePaths.iconPath,
    resourcePaths.overlayPath,
    resourcePaths.overlayStylePath,
    resourcePaths.preloadPath,
  ]);
  return {
    lstatSync(candidate) {
      if (candidate === missingPath || (!directories.has(candidate) && !files.has(candidate))) {
        throw new Error('fixture resource unavailable');
      }
      return {
        isDirectory: () => directories.has(candidate),
        isFile: () => files.has(candidate),
        isSymbolicLink: () => false,
      };
    },
  };
}

test('development resources resolve from an absolute repository desktop directory', () => {
  const desktopDirectory = 'C:\\Users\\Tést User\\easy rewind\\desktop';
  const expected = expectedDevelopmentPaths(desktopDirectory);
  const { resolveDesktopResourcePaths } = require('./resource-paths');
  const resources = resolveDesktopResourcePaths({
    desktopDirectory,
    electronApp: { isPackaged: false },
    fileSystem: fileSystemFor(expected),
    processLike: {},
  });

  assert.deepEqual(resources, expected);
  assert.equal(Object.isFrozen(resources), true);
});

test('packaged resources resolve only beneath the injected Electron resources path', () => {
  const resourcesPath = 'D:\\Program Files\\易回溯\\resources';
  const expected = expectedPackagedPaths(resourcesPath);
  const { resolveDesktopResourcePaths } = require('./resource-paths');
  const resources = resolveDesktopResourcePaths({
    desktopDirectory: 'C:\\source\\easy-rewind\\desktop',
    electronApp: { isPackaged: true },
    fileSystem: fileSystemFor(expected),
    processLike: { resourcesPath },
  });

  assert.deepEqual(resources, expected);
  for (const resourcePath of Object.values(resources)) {
    assert.equal(path.relative(resourcesPath, resourcePath).startsWith('..'), false);
    assert.equal(path.isAbsolute(resourcePath), true);
  }
});

test('resource roots reject relative, non-normalized traversal, and NUL-containing paths', () => {
  const { resolveDesktopResourcePaths } = require('./resource-paths');
  const invalidInputs = [
    {
      desktopDirectory: 'desktop',
      electronApp: { isPackaged: false },
      processLike: {},
    },
    {
      desktopDirectory: 'C:\\source\\easy-rewind\\desktop\\..\\private',
      electronApp: { isPackaged: false },
      processLike: {},
    },
    {
      desktopDirectory: 'C:\\source\\easy-rewind\\desktop\0private',
      electronApp: { isPackaged: false },
      processLike: {},
    },
    {
      desktopDirectory: 'C:\\source\\easy-rewind\\desktop',
      electronApp: { isPackaged: true },
      processLike: { resourcesPath: '..\\resources' },
    },
    {
      desktopDirectory: 'C:\\source\\easy-rewind\\desktop',
      electronApp: { isPackaged: true },
      processLike: { resourcesPath: 'C:\\app\\resources\\..\\private' },
    },
    {
      desktopDirectory: 'C:\\source\\easy-rewind\\desktop',
      electronApp: { isPackaged: true },
      processLike: { resourcesPath: 'C:\\app\\resources\0private' },
    },
  ];

  for (const input of invalidInputs) {
    assert.throws(
      () =>
        resolveDesktopResourcePaths({
          ...input,
          fileSystem: { lstatSync: assert.fail },
        }),
      {
        name: 'DesktopResourcePathError',
        code: 'DESKTOP_RESOURCE_PATH_INVALID',
        message: 'Desktop resource paths are invalid.',
      }
    );
  }
});

test('every missing or wrong-type required resource fails closed through injected filesystem checks', () => {
  const desktopDirectory = 'C:\\source\\easy rewind\\desktop';
  const expected = expectedDevelopmentPaths(desktopDirectory);
  const { resolveDesktopResourcePaths } = require('./resource-paths');

  for (const requiredPath of Object.values(expected)) {
    assert.throws(
      () =>
        resolveDesktopResourcePaths({
          desktopDirectory,
          electronApp: { isPackaged: false },
          fileSystem: fileSystemFor(expected, requiredPath),
          processLike: {},
        }),
      error =>
        error?.name === 'DesktopResourcePathError' &&
        error.code === 'DESKTOP_RESOURCE_UNAVAILABLE' &&
        error.message === 'Required desktop resources are unavailable.' &&
        !error.message.includes(requiredPath)
    );
  }

  assert.throws(
    () =>
      resolveDesktopResourcePaths({
        desktopDirectory,
        electronApp: { isPackaged: false },
        fileSystem: {
          lstatSync() {
            return {
              isDirectory: () => false,
              isFile: () => false,
              isSymbolicLink: () => false,
            };
          },
        },
        processLike: {},
      }),
    {
      name: 'DesktopResourcePathError',
      code: 'DESKTOP_RESOURCE_UNAVAILABLE',
    }
  );
});

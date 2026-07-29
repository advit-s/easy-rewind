'use strict';

const path = require('node:path');

class DesktopResourcePathError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DesktopResourcePathError';
    this.code = code;
  }
}

function invalidResourcePath() {
  return new DesktopResourcePathError('DESKTOP_RESOURCE_PATH_INVALID', 'Desktop resource paths are invalid.');
}

function unavailableResource() {
  return new DesktopResourcePathError('DESKTOP_RESOURCE_UNAVAILABLE', 'Required desktop resources are unavailable.');
}

function exactAbsolutePath(value) {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 32_768 &&
    !value.includes('\0') &&
    path.isAbsolute(value) &&
    path.resolve(value) === value
  );
}

function containedBy(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertResource(fileSystem, candidate, expectedType) {
  try {
    const metadata = fileSystem.lstatSync(candidate);
    if (
      metadata === null ||
      typeof metadata !== 'object' ||
      typeof metadata.isSymbolicLink !== 'function' ||
      metadata.isSymbolicLink() ||
      typeof metadata[expectedType] !== 'function' ||
      !metadata[expectedType]()
    ) {
      throw unavailableResource();
    }
  } catch (error) {
    if (error instanceof DesktopResourcePathError) throw error;
    throw unavailableResource();
  }
}

function resolveDesktopResourcePaths({
  desktopDirectory = __dirname,
  electronApp,
  fileSystem = require('node:fs'),
  processLike = process,
} = {}) {
  if (
    electronApp === null ||
    typeof electronApp !== 'object' ||
    typeof electronApp.isPackaged !== 'boolean' ||
    processLike === null ||
    typeof processLike !== 'object' ||
    fileSystem === null ||
    typeof fileSystem !== 'object' ||
    typeof fileSystem.lstatSync !== 'function' ||
    !exactAbsolutePath(desktopDirectory)
  ) {
    throw invalidResourcePath();
  }

  const packaged = electronApp.isPackaged;
  if (packaged && !exactAbsolutePath(processLike.resourcesPath)) {
    throw invalidResourcePath();
  }
  const resourceRoot = packaged
    ? path.join(processLike.resourcesPath, 'app.asar')
    : path.dirname(desktopDirectory);
  if (!exactAbsolutePath(resourceRoot)) throw invalidResourcePath();

  const desktopRoot = packaged ? path.join(resourceRoot, 'desktop') : desktopDirectory;
  const resources = {
    backendModuleRoot: path.join(resourceRoot, 'backend'),
    dashboardDirectory: path.join(resourceRoot, 'frontend'),
    iconPath: path.join(desktopRoot, 'assets', 'tray-icon.png'),
    overlayPath: path.join(desktopRoot, 'overlay.html'),
    overlayStylePath: path.join(desktopRoot, 'overlay.css'),
    preloadPath: path.join(desktopRoot, 'preload.js'),
  };
  if (
    !Object.values(resources).every(candidate => exactAbsolutePath(candidate) && containedBy(resourceRoot, candidate))
  ) {
    throw invalidResourcePath();
  }

  assertResource(fileSystem, resources.backendModuleRoot, 'isDirectory');
  assertResource(fileSystem, resources.dashboardDirectory, 'isDirectory');
  assertResource(fileSystem, resources.iconPath, 'isFile');
  assertResource(fileSystem, resources.overlayPath, 'isFile');
  assertResource(fileSystem, resources.overlayStylePath, 'isFile');
  assertResource(fileSystem, resources.preloadPath, 'isFile');
  return Object.freeze(resources);
}

module.exports = {
  DesktopResourcePathError,
  resolveDesktopResourcePaths,
};

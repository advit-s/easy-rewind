import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const electronVersion = '43.2.0';
const nativePackageName = 'better-sqlite3';
const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const sharedNodeModules = join(repositoryRoot, 'node_modules');
const sharedNativeModule = join(sharedNodeModules, nativePackageName);

class StagingError extends Error {}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function copyRegularTree(sourceRoot, destinationRoot) {
  const pending = [[sourceRoot, destinationRoot]];
  while (pending.length > 0) {
    const [source, destination] = pending.pop();
    const sourceMetadata = lstatSync(source);
    if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
      throw new StagingError();
    }
    mkdirSync(destination);
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const sourceEntry = join(source, entry.name);
      const destinationEntry = join(destination, entry.name);
      const metadata = lstatSync(sourceEntry);
      if (metadata.isSymbolicLink()) throw new StagingError();
      if (metadata.isDirectory()) {
        pending.push([sourceEntry, destinationEntry]);
      } else if (metadata.isFile()) {
        copyFileSync(sourceEntry, destinationEntry, constants.COPYFILE_EXCL);
        if (
          metadata.size !== lstatSync(destinationEntry).size ||
          hashFile(sourceEntry) !== hashFile(destinationEntry)
        ) {
          throw new StagingError();
        }
      } else {
        throw new StagingError();
      }
    }
  }
}

function packageDirectory(nodeModules, packageName) {
  return join(nodeModules, ...packageName.split('/'));
}

function copyDependencyTree(packageName, stagingNodeModules, copied = new Set()) {
  if (copied.has(packageName)) return;
  copied.add(packageName);
  const source = packageDirectory(sharedNodeModules, packageName);
  const destination = packageDirectory(stagingNodeModules, packageName);
  mkdirSync(dirname(destination), { recursive: true });
  copyRegularTree(source, destination);
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    copyDependencyTree(dependency, stagingNodeModules, copied);
  }
}

function bindingSnapshot(moduleRoot) {
  const snapshot = new Map();
  const pending = [moduleRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    const directoryMetadata = lstatSync(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      throw new StagingError();
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) throw new StagingError();
      if (metadata.isDirectory()) {
        pending.push(path);
      } else if (metadata.isFile() && entry.name.endsWith('.node')) {
        snapshot.set(relative(moduleRoot, path).split(sep).join('/'), {
          device: metadata.dev,
          identity: metadata.ino,
          size: metadata.size,
          sha256: hashFile(path),
        });
      }
    }
  }
  if (snapshot.size === 0) throw new StagingError();
  return snapshot;
}

function snapshotsEqual(left, right) {
  return (
    left.size === right.size &&
    [...left].every(([label, value]) => JSON.stringify(right.get(label)) === JSON.stringify(value))
  );
}

function verifyNodeLoad(moduleRoot, executable = process.execPath, environment = undefined) {
  const verification = spawnSync(
    executable,
    [
      '-e',
      `const Database = require(process.argv[1]);
const database = new Database(':memory:');
if (database.prepare('select 1 as ok').get().ok !== 1) process.exit(2);
database.close();`,
      moduleRoot,
    ],
    {
      encoding: 'utf8',
      env: environment,
      timeout: 30_000,
      windowsHide: true,
    }
  );
  return verification.status === 0 && !verification.error && !verification.signal;
}

function main() {
  let stagingRoot;
  let failed = false;
  try {
    const originalBefore = bindingSnapshot(sharedNativeModule);
    if (!verifyNodeLoad(sharedNativeModule)) throw new StagingError();

    stagingRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-electron-native-'));
    const stagingNodeModules = join(stagingRoot, 'node_modules');
    mkdirSync(stagingNodeModules);
    copyDependencyTree(nativePackageName, stagingNodeModules);
    writeFileSync(
      join(stagingRoot, 'package.json'),
      `${JSON.stringify(
        {
          name: 'easy-rewind-electron-native-staging',
          private: true,
          dependencies: { [nativePackageName]: '13.0.1' },
        },
        null,
        2
      )}\n`,
      { encoding: 'utf8', flag: 'wx' }
    );

    const stagedModule = packageDirectory(stagingNodeModules, nativePackageName);
    const stagedBefore = bindingSnapshot(stagedModule);
    const rebuildCli = join(sharedNodeModules, '@electron', 'rebuild', 'lib', 'cli.js');
    const rebuild = spawnSync(
      process.execPath,
      [
        rebuildCli,
        '--version',
        electronVersion,
        '--module-dir',
        stagingNodeModules,
        '--which-module',
        nativePackageName,
        '--force',
        '--sequential',
      ],
      {
        cwd: stagingRoot,
        encoding: 'utf8',
        timeout: 600_000,
        windowsHide: true,
      }
    );

    const originalAfter = bindingSnapshot(sharedNativeModule);
    if (!snapshotsEqual(originalBefore, originalAfter) || !verifyNodeLoad(sharedNativeModule)) {
      throw new StagingError();
    }
    if (rebuild.status !== 0 || rebuild.error || rebuild.signal) throw new StagingError();
    const stagedAfter = bindingSnapshot(stagedModule);
    if (snapshotsEqual(stagedBefore, stagedAfter)) throw new StagingError();

    const electronExecutable = join(sharedNodeModules, 'electron', 'dist', 'electron.exe');
    let electronVerified = false;
    try {
      electronVerified =
        lstatSync(electronExecutable).isFile() &&
        verifyNodeLoad(stagedModule, electronExecutable, {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
        });
    } catch {
      electronVerified = false;
    }
    if (lstatSync(electronExecutable, { throwIfNoEntry: false }) && !electronVerified) {
      throw new StagingError();
    }

    process.stdout.write(
      electronVerified
        ? 'Electron native staging rebuild passed with Electron runtime verification.\n'
        : 'Electron native staging rebuild passed; Electron executable unavailable, runtime verification deferred to Stage 6.\n'
    );
  } catch {
    failed = true;
    process.stderr.write('Electron native staging rebuild failed.\n');
  } finally {
    if (stagingRoot) {
      try {
        rmSync(stagingRoot, { recursive: true, force: true });
      } catch {
        failed = true;
        process.stderr.write('Electron native staging cleanup failed.\n');
      }
    }
  }
  if (failed) process.exitCode = 1;
}

main();

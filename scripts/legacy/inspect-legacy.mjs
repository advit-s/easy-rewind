import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { discoverLegacy } = require('../../backend/src/legacy/discover-legacy');
const { inspectLegacy } = require('../../backend/src/legacy/inspect-legacy');
const { writeLegacyReport } = require('../../backend/src/legacy/legacy-report');

function parseArguments(argv) {
  if (!Array.isArray(argv)) throw new Error('Legacy inspection arguments are invalid.');
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--manifest', '--output'].includes(flag) || typeof value !== 'string' || value.length === 0 || values[flag]) {
      throw new Error('Legacy inspection requires one --manifest and one --output path.');
    }
    values[flag] = value;
  }
  if (!values['--manifest'] || !values['--output']) {
    throw new Error('Legacy inspection requires one --manifest and one --output path.');
  }
  const manifestPath = resolve(values['--manifest']);
  const outputPath = resolve(values['--output']);
  if (manifestPath !== values['--manifest'] || outputPath !== values['--output']) {
    throw new Error('Legacy inspection paths must be exact absolute paths.');
  }
  return Object.freeze({ manifestPath, outputPath });
}

function localPermissions() {
  return Object.freeze({
    async restrictDirectory(path) {
      chmodSync(path, 0o700);
    },
    async restrictFile(path) {
      chmodSync(path, 0o600);
    },
  });
}

async function main(argv = process.argv.slice(2)) {
  const { manifestPath, outputPath } = parseArguments(argv);
  const scriptPath = fileURLToPath(import.meta.url);
  const repositoryRoot = resolve(dirname(scriptPath), '..', '..');
  const discovered = discoverLegacy({ manifestPath });
  if (!discovered.available) throw new Error('A verified legacy quarantine manifest is required.');

  const workRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-legacy-inspection-'));
  const filePermissions = localPermissions();
  try {
    await filePermissions.restrictDirectory(workRoot);
    const report = await inspectLegacy({
      manifestPath: discovered.manifestPath,
      workRoot,
      filePermissions,
    });
    await writeLegacyReport({
      report,
      outputPath,
      repositoryRoot,
      filePermissions,
    });
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
  process.stdout.write('SENSITIVE MIGRATION METADATA report written.\n');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : 'Legacy inspection failed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

export { main, parseArguments };

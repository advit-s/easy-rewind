import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createLegacyMigrationPlan } = require('../../backend/src/legacy/plan-migration');
const { runLegacyMigration } = require('../../backend/src/legacy/run-migration');
const { rollbackLegacyMigration } = require('../../backend/src/legacy/rollback-migration');

function parseFlags(values) {
  const flags = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (
      typeof flag !== 'string' ||
      !flag.startsWith('--') ||
      typeof value !== 'string' ||
      value.length === 0 ||
      Object.hasOwn(flags, flag)
    ) {
      throw new Error('Legacy migration arguments are invalid.');
    }
    flags[flag] = value;
  }
  return flags;
}

function exactPath(value) {
  const path = resolve(value);
  if (path !== value) throw new Error('Legacy migration paths must be exact absolute paths.');
  return path;
}

function requireFlags(flags, names) {
  const allowed = new Set(names);
  if (names.some(name => !Object.hasOwn(flags, name)) || Object.keys(flags).some(name => !allowed.has(name))) {
    throw new Error(`Legacy migration requires exactly: ${names.join(', ')}.`);
  }
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length < 1)
    throw new Error('An explicit plan, run, or rollback command is required.');
  const [command, ...values] = argv;
  const flags = parseFlags(values);
  if (command === 'plan') {
    const names = [
      '--manifest',
      '--destination',
      '--work-root',
      '--recovery-root',
      '--rollback-root',
      '--output',
      '--available-disk-bytes',
    ];
    requireFlags(flags, names);
    const availableDiskBytes = Number(flags['--available-disk-bytes']);
    if (!Number.isSafeInteger(availableDiskBytes) || availableDiskBytes < 0) {
      throw new Error('Available disk bytes must be a non-negative safe integer.');
    }
    return Object.freeze({
      command,
      manifestPath: exactPath(flags['--manifest']),
      destinationPath: exactPath(flags['--destination']),
      workRoot: exactPath(flags['--work-root']),
      recoveryRoot: exactPath(flags['--recovery-root']),
      rollbackRoot: exactPath(flags['--rollback-root']),
      outputPath: exactPath(flags['--output']),
      availableDiskBytes,
    });
  }
  if (command === 'run') {
    const names = ['--plan', '--confirm', '--destination', '--work-root'];
    requireFlags(flags, names);
    if (!/^[a-f0-9]{64}$/.test(flags['--confirm'])) {
      throw new Error('Run confirmation must be one exact plan fingerprint.');
    }
    return Object.freeze({
      command,
      planPath: exactPath(flags['--plan']),
      confirmationFingerprint: flags['--confirm'],
      destinationPath: exactPath(flags['--destination']),
      workRoot: exactPath(flags['--work-root']),
    });
  }
  if (command === 'rollback') {
    const names = ['--metadata', '--destination'];
    requireFlags(flags, names);
    return Object.freeze({
      command,
      metadataPath: exactPath(flags['--metadata']),
      destinationPath: exactPath(flags['--destination']),
    });
  }
  throw new Error('An explicit plan, run, or rollback command is required.');
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
  const options = parseArguments(argv);
  const filePermissions = localPermissions();
  if (options.command === 'plan') {
    const plan = await createLegacyMigrationPlan({ ...options, filePermissions });
    writeFileSync(options.outputPath, `${JSON.stringify(plan, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await filePermissions.restrictFile(options.outputPath);
    process.stdout.write(`Plan created. Confirm only this fingerprint: ${plan.fingerprint}\n`);
    return;
  }
  if (options.command === 'run') {
    const plan = JSON.parse(readFileSync(options.planPath, 'utf8'));
    const result = await runLegacyMigration({ ...options, plan, filePermissions });
    process.stdout.write(`Migration ${result.state}. Rollback metadata retained.\n`);
    return;
  }
  const result = await rollbackLegacyMigration({ ...options, filePermissions });
  process.stdout.write(`Migration ${result.state} from verified backup.\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : 'Legacy migration failed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

export { main, parseArguments };

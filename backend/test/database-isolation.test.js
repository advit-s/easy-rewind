const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { copyFileSync, mkdirSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const test = require('node:test');

const repositoryRoot = resolve(__dirname, '..', '..');

test('DATABASE_PATH selects a repository-external database for each process', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-database-isolation-'));
  const helperCopy = join(fixtureRoot, 'backend', 'routes', 'helpers.js');
  const databasePath = join(fixtureRoot, 'runtime', 'database.sqlite');
  mkdirSync(dirname(helperCopy), { recursive: true });
  mkdirSync(dirname(databasePath), { recursive: true });
  copyFileSync(join(repositoryRoot, 'backend', 'routes', 'helpers.js'), helperCopy);

  try {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `
          const helpers = require(${JSON.stringify(helperCopy)});
          const database = helpers.getDb();
          process.stdout.write(JSON.stringify({ databasePath: database.name }));
          database.close();
        `,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          DATABASE_PATH: databasePath,
          SETTINGS_PATH: join(fixtureRoot, 'runtime', 'settings.json'),
          NODE_PATH: join(repositoryRoot, 'node_modules'),
        },
        windowsHide: true,
      }
    );
    const report = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(resolve(report.databasePath), resolve(databasePath));
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

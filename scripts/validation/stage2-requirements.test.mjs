import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import {
  parseCsv,
  parseRequirementRows,
  requirementColumns,
  requirementStatuses,
  validateRequirementsLedger,
} from './stage2-requirements.mjs';

const root = resolve(import.meta.dirname, '..', '..');
const requirementsPath = join(root, 'docs', 'release', 'requirements', 'stages-2-7.csv');
const requirementsText = readFileSync(requirementsPath, 'utf8');
const expectedColumns = [
  'id',
  'requirement',
  'stage',
  'source',
  'verification_command',
  'evidence_path',
  'status',
  'blocker',
];
const expectedStage2Ids = [
  'S2-01',
  'S2-02',
  'S2-03',
  'S2-04',
  'S2-05',
  'S2-06',
  'S2-07',
  'S2-08',
  'S2-09',
  'S2-10',
  'S2-11',
  'S2-12',
  'S2-13',
  'S2-14',
];

test('strict CSV parsing rejects quotes inside unquoted fields', () => {
  assert.throws(() => parseCsv('id,requ"ire"ment\n'), /quote/i);
});

test('strict CSV parsing rejects text after a closing quote', () => {
  assert.throws(() => parseCsv('"id"x,requirement\n'), /closing quote/i);
});

test('strict CSV parsing rejects backslash quote escapes instead of treating them as CSV escapes', () => {
  assert.throws(() => parseCsv(String.raw`"i\"d",requirement"`), /quote|escape/i);
});

test('strict CSV parsing rejects unterminated quoted records', () => {
  assert.throws(() => parseCsv('"id,requirement\n'), /unterminated/i);
});

test('strict CSV parsing accepts doubled quote escapes and CRLF records', () => {
  assert.deepEqual(parseCsv('"a""b",c\r\n'), [['a"b', 'c']]);
});

test('the validator and evidence document the same status vocabulary', () => {
  const expectedStatuses = ['blocked', 'failing', 'implemented', 'not-started', 'verified'];
  const evidence = readFileSync(join(root, 'docs', 'release', 'evidence', 'stage-2', 'README.md'), 'utf8');

  assert.deepEqual([...requirementStatuses].sort(), expectedStatuses);
  for (const status of expectedStatuses) {
    assert.match(evidence, new RegExp(`\\\`${status}\\\``), `Stage 2 evidence does not document ${status}`);
  }
});

function csvRow(values) {
  return `${values.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')}\n`;
}

function removeTemporaryFixture(fixtureRoot, prefix) {
  const temporaryRoot = resolve(tmpdir());
  const resolvedFixtureRoot = resolve(fixtureRoot);
  const relativeFixture = relative(temporaryRoot, resolvedFixtureRoot);

  assert.equal(
    isAbsolute(relativeFixture) ||
      relativeFixture.startsWith(`..${sep}`) ||
      relativeFixture === '..' ||
      basename(resolvedFixtureRoot).startsWith(prefix) === false,
    false,
    'fixture cleanup target must be the expected temporary child'
  );
  rmSync(resolvedFixtureRoot, { recursive: true, force: true });
}

function withRequirementsFixture(callback) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-stage2-requirements-'));

  try {
    for (const stage of ['2', '3']) {
      const evidenceRoot = join(fixtureRoot, 'docs', 'release', 'evidence', `stage-${stage}`);
      mkdirSync(evidenceRoot, { recursive: true });
      writeFileSync(join(evidenceRoot, 'README.md'), '# Fixture\n', 'utf8');
      writeFileSync(join(evidenceRoot, 'commands.md'), '# Fixture\n', 'utf8');
    }
    return callback(fixtureRoot);
  } finally {
    removeTemporaryFixture(fixtureRoot, 'easy-rewind-stage2-requirements-');
  }
}

function validateWithExtraRow(fixtureRoot, row) {
  return validateRequirementsLedger({
    text: `${requirementsText}${csvRow(row)}`,
    repositoryRoot: fixtureRoot,
    expectedStage2Ids,
  });
}

test('global ledger invariants reject a duplicate ID on an irrelevant-stage row', () => {
  withRequirementsFixture(fixtureRoot => {
    assert.throws(
      () =>
        validateWithExtraRow(fixtureRoot, [
          'S2-01',
          'duplicate',
          '3',
          'source',
          'command',
          'docs/release/evidence/stage-3/README.md',
          'not-started',
          'pending',
        ]),
      /unique/i
    );
  });
});

test('global ledger invariants reject a blank required value on an irrelevant-stage row', () => {
  withRequirementsFixture(fixtureRoot => {
    assert.throws(
      () =>
        validateWithExtraRow(fixtureRoot, [
          'S3-01',
          'blank source',
          '3',
          '',
          'command',
          'docs/release/evidence/stage-3/README.md',
          'not-started',
          'pending',
        ]),
      /empty source/i
    );
  });
});

test('global ledger invariants reject an unsafe evidence path on an irrelevant-stage row', () => {
  withRequirementsFixture(fixtureRoot => {
    assert.throws(
      () =>
        validateWithExtraRow(fixtureRoot, [
          'S3-01',
          'unsafe evidence',
          '3',
          'source',
          'command',
          '../outside.md',
          'not-started',
          'pending',
        ]),
      /evidence_path|evidence path/i
    );
  });
});

test('global ledger invariants reject undocumented statuses', () => {
  withRequirementsFixture(fixtureRoot => {
    assert.throws(
      () =>
        validateWithExtraRow(fixtureRoot, [
          'S3-01',
          'invalid status',
          '3',
          'source',
          'command',
          'docs/release/evidence/stage-3/README.md',
          'waiting',
          'pending',
        ]),
      /status/i
    );
  });
});

test('global ledger invariants enforce ID and stage consistency', () => {
  withRequirementsFixture(fixtureRoot => {
    assert.throws(
      () =>
        validateWithExtraRow(fixtureRoot, [
          'S3-01',
          'mismatched stage',
          '2',
          'source',
          'command',
          'docs/release/evidence/stage-2/README.md',
          'not-started',
          'pending',
        ]),
      /does not match stage/i
    );
  });
});

test('the Task 1 ledger keeps exactly fourteen Stage 2 rows while allowing valid future-stage rows', () => {
  withRequirementsFixture(fixtureRoot => {
    const validated = validateWithExtraRow(fixtureRoot, [
      'S3-01',
      'future row',
      '3',
      'source',
      'command',
      'docs/release/evidence/stage-3/README.md',
      'not-started',
      'pending',
    ]);

    assert.equal(validated.rows.length, 15);
    assert.equal(validated.stage2Rows.length, 14);
    assert.equal(
      validated.rows.some(row => row.id === 'S3-01' && row.stage === '3'),
      true
    );
  });
});

test('evidence validation rejects a linked directory that resolves outside the canonical evidence root', t => {
  const externalRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-stage2-external-'));

  try {
    writeFileSync(join(externalRoot, 'README.md'), '# External fixture\n', 'utf8');
    withRequirementsFixture(fixtureRoot => {
      const linkedDirectory = join(fixtureRoot, 'docs', 'release', 'evidence', 'stage-2', 'linked');

      try {
        symlinkSync(externalRoot, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error?.code)) {
          t.skip('Directory-link creation is unavailable for the sanitized evidence fixture.');
          return;
        }
        throw error;
      }

      const rows = parseRequirementRows(requirementsText);
      rows[0].evidence_path = 'docs/release/evidence/stage-2/linked/README.md';
      const linkedLedger = [
        csvRow(requirementColumns),
        ...rows.map(row => csvRow(requirementColumns.map(column => row[column]))),
      ].join('');

      assert.throws(
        () =>
          validateRequirementsLedger({
            text: linkedLedger,
            repositoryRoot: fixtureRoot,
            expectedStage2Ids,
          }),
        /link|canonical|outside/i
      );
    });
    assert.equal(
      existsSync(join(externalRoot, 'README.md')),
      true,
      'linked external target must survive fixture cleanup'
    );
  } finally {
    removeTemporaryFixture(externalRoot, 'easy-rewind-stage2-external-');
  }
});

test('evidence validation rejects a direct symbolic-link evidence entry', t => {
  const externalRoot = mkdtempSync(join(tmpdir(), 'easy-rewind-stage2-external-file-'));

  try {
    const externalFile = join(externalRoot, 'README.md');
    writeFileSync(externalFile, '# External fixture\n', 'utf8');
    withRequirementsFixture(fixtureRoot => {
      const linkedFile = join(fixtureRoot, 'docs', 'release', 'evidence', 'stage-2', 'linked-file.md');

      try {
        symlinkSync(externalFile, linkedFile, 'file');
      } catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error?.code)) {
          t.skip('File-link creation is unavailable for the sanitized evidence fixture.');
          return;
        }
        throw error;
      }

      const rows = parseRequirementRows(requirementsText);
      rows[0].evidence_path = 'docs/release/evidence/stage-2/linked-file.md';
      const linkedLedger = [
        csvRow(requirementColumns),
        ...rows.map(row => csvRow(requirementColumns.map(column => row[column]))),
      ].join('');

      assert.throws(
        () =>
          validateRequirementsLedger({
            text: linkedLedger,
            repositoryRoot: fixtureRoot,
            expectedStage2Ids,
          }),
        /symbolic link|reparse-point link/i
      );
    });
    assert.equal(existsSync(externalFile), true, 'symbolic-link target must survive fixture cleanup');
  } finally {
    removeTemporaryFixture(externalRoot, 'easy-rewind-stage2-external-file-');
  }
});

function readStage2Rows() {
  assert.equal(
    existsSync(requirementsPath),
    true,
    'missing Stage 2 requirements file: docs/release/requirements/stages-2-7.csv'
  );

  assert.deepEqual(requirementColumns, expectedColumns);
  return parseRequirementRows(readFileSync(requirementsPath, 'utf8'));
}

test('Stage 2 requirements use the complete explicit ID set and stable columns', () => {
  const { stage2Rows } = validateRequirementsLedger({
    text: readFileSync(requirementsPath, 'utf8'),
    repositoryRoot: root,
    expectedStage2Ids,
  });

  assert.deepEqual(stage2Rows.map(row => row.id).sort(), [...expectedStage2Ids].sort());
});

test('every Stage 2 requirement points to a safe repository evidence file that exists', () => {
  const rows = readStage2Rows();
  const validated = validateRequirementsLedger({
    text: readFileSync(requirementsPath, 'utf8'),
    repositoryRoot: root,
    expectedStage2Ids,
  });

  assert.equal(validated.rows.length, rows.length);
});

test('root verification adds the Stage 2 requirements gate without changing the Stage 1 gate', () => {
  const repository = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  assert.equal(repository.scripts['test:requirements'], 'node --test scripts/validation/stage2-requirements.test.mjs');
  assert.equal(
    repository.scripts['verify:stage1'],
    'npm run scan:secrets && npm run check:hygiene && npm run lint && npm run format:check && npm test && npm run build'
  );
  assert.equal(repository.scripts.verify, 'npm run verify:stage1 && npm run test:requirements');
});

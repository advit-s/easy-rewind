import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..');
const requirementsPath = join(root, 'docs', 'release', 'requirements', 'stages-2-7.csv');
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

function parseCsv(text) {
  const records = [];
  let field = '';
  let record = [];
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      record.push(field);
      field = '';
    } else if (character === '\n') {
      record.push(field.replace(/\r$/, ''));
      records.push(record);
      field = '';
      record = [];
    } else {
      field += character;
    }
  }

  assert.equal(quoted, false, 'requirements CSV has an unterminated quoted field');
  if (field || record.length > 0) {
    record.push(field.replace(/\r$/, ''));
    records.push(record);
  }

  return records.filter(row => row.some(value => value.length > 0));
}

function readStage2Rows() {
  assert.equal(
    existsSync(requirementsPath),
    true,
    'missing Stage 2 requirements file: docs/release/requirements/stages-2-7.csv'
  );

  const [columns, ...records] = parseCsv(readFileSync(requirementsPath, 'utf8'));
  assert.deepEqual(columns, expectedColumns, 'requirements CSV columns changed');

  return records.map((record, index) => {
    assert.equal(record.length, expectedColumns.length, `requirements CSV row ${index + 2} has unstable columns`);
    return Object.fromEntries(expectedColumns.map((column, columnIndex) => [column, record[columnIndex]]));
  });
}

test('Stage 2 requirements use the complete explicit ID set and stable columns', () => {
  const rows = readStage2Rows();
  const stage2Rows = rows.filter(row => row.stage === '2');
  const ids = stage2Rows.map(row => row.id);

  assert.equal(new Set(ids).size, ids.length, 'Stage 2 requirement IDs must be unique');
  assert.deepEqual([...ids].sort(), [...expectedStage2Ids].sort(), 'Stage 2 requirement IDs are missing or unexpected');

  for (const row of stage2Rows) {
    for (const column of ['requirement', 'source', 'verification_command', 'status', 'blocker']) {
      assert.notEqual(row[column].trim(), '', `${row.id} has an empty ${column}`);
    }
  }
});

test('every Stage 2 requirement points to a safe repository evidence file that exists', () => {
  for (const row of readStage2Rows().filter(candidate => candidate.stage === '2')) {
    const evidencePath = row.evidence_path.trim();

    assert.notEqual(evidencePath, '', `${row.id} has an empty evidence_path`);
    assert.equal(isAbsolute(evidencePath), false, `${row.id} evidence_path must be repository-relative`);
    assert.equal(evidencePath.includes('\\'), false, `${row.id} evidence_path must use forward slashes`);
    assert.equal(evidencePath.split('/').includes('..'), false, `${row.id} evidence_path must not traverse`);
    assert.match(
      evidencePath,
      /^docs\/release\/evidence\/stage-2\/[A-Za-z0-9._/-]+$/,
      `${row.id} evidence_path must stay inside Stage 2 release evidence`
    );

    const resolvedEvidencePath = resolve(root, evidencePath);
    assert.equal(
      relative(root, resolvedEvidencePath).startsWith(`..${sep}`),
      false,
      `${row.id} evidence_path escapes the repository`
    );
    assert.equal(existsSync(resolvedEvidencePath), true, `${row.id} evidence file is missing: ${evidencePath}`);
    assert.equal(
      statSync(resolvedEvidencePath).isFile(),
      true,
      `${row.id} evidence path is not a file: ${evidencePath}`
    );
  }
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

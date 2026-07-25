import assert from 'node:assert/strict';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const requirementColumns = [
  'id',
  'requirement',
  'stage',
  'source',
  'verification_command',
  'evidence_path',
  'status',
  'blocker',
];
export const requirementStatuses = new Set(['not-started', 'failing', 'implemented', 'verified', 'blocked']);

function isStrictDescendant(parentPath, candidatePath) {
  const relativePath = relative(parentPath, candidatePath);
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    isAbsolute(relativePath) === false &&
    relativePath.startsWith(`..${sep}`) === false
  );
}

function assertUnlinkedPathComponents(canonicalRepositoryRoot, repositoryRelativePath, requirementId) {
  let currentPath = canonicalRepositoryRoot;
  let currentMetadata;

  for (const component of repositoryRelativePath.split('/').filter(part => part && part !== '.')) {
    currentPath = resolve(currentPath, component);
    currentMetadata = lstatSync(currentPath);
    assert.equal(
      currentMetadata.isSymbolicLink(),
      false,
      `${requirementId} evidence path must not traverse a symbolic link or reparse-point link`
    );
  }

  return { path: currentPath, metadata: currentMetadata };
}

export function parseCsv(text) {
  const records = [];
  let field = '';
  let record = [];
  let state = 'field-start';

  function finishField() {
    record.push(field);
    field = '';
  }

  function finishRecord() {
    finishField();
    records.push(record);
    record = [];
    state = 'field-start';
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (state === 'quoted') {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        state = 'after-quote';
      } else {
        field += character;
      }
      continue;
    }

    if (state === 'after-quote') {
      if (character === ',') {
        finishField();
        state = 'field-start';
      } else if (character === '\n') {
        finishRecord();
      } else if (character === '\r' && text[index + 1] === '\n') {
        finishRecord();
        index += 1;
      } else {
        throw new Error('requirements CSV contains text after a closing quote');
      }
      continue;
    }

    if (character === '"') {
      if (state !== 'field-start') {
        throw new Error('requirements CSV contains a quote inside an unquoted field');
      }
      state = 'quoted';
    } else if (character === ',') {
      finishField();
      state = 'field-start';
    } else if (character === '\n') {
      finishRecord();
    } else if (character === '\r' && text[index + 1] === '\n') {
      finishRecord();
      index += 1;
    } else if (character === '\r') {
      throw new Error('requirements CSV contains an invalid record terminator');
    } else {
      field += character;
      state = 'unquoted';
    }
  }

  if (state === 'quoted') {
    throw new Error('requirements CSV has an unterminated quoted field');
  }
  if (field || record.length > 0 || state === 'after-quote') {
    finishField();
    records.push(record);
  }

  return records.filter(row => row.some(value => value.length > 0));
}

export function parseRequirementRows(text) {
  const [columns, ...records] = parseCsv(text);
  assert.deepEqual(columns, requirementColumns, 'requirements CSV columns changed');

  return records.map((record, index) => {
    assert.equal(record.length, requirementColumns.length, `requirements CSV row ${index + 2} has unstable columns`);
    return Object.fromEntries(requirementColumns.map((column, columnIndex) => [column, record[columnIndex]]));
  });
}

export function validateRequirementsLedger({ text, repositoryRoot, expectedStage2Ids }) {
  const rows = parseRequirementRows(text);
  const ids = rows.map(row => row.id);
  const canonicalRepositoryRoot = realpathSync.native(resolve(repositoryRoot));

  assert.equal(new Set(ids).size, ids.length, 'Requirement IDs must be globally unique');

  for (const row of rows) {
    for (const column of requirementColumns) {
      assert.notEqual(row[column].trim(), '', `${row.id} has an empty ${column}`);
    }
    assert.equal(requirementStatuses.has(row.status), true, `${row.id} has an invalid status`);

    const idMatch = /^S([2-7])-\d{2}$/.exec(row.id);
    assert.notEqual(idMatch, null, `${row.id} is not a stable stages 2-7 requirement ID`);
    assert.equal(idMatch[1], row.stage, `${row.id} does not match stage ${row.stage}`);

    const evidencePath = row.evidence_path.trim();
    assert.equal(isAbsolute(evidencePath), false, `${row.id} evidence_path must be repository-relative`);
    assert.equal(evidencePath.includes('\\'), false, `${row.id} evidence_path must use forward slashes`);
    assert.equal(evidencePath.split('/').includes('..'), false, `${row.id} evidence_path must not traverse`);
    assert.match(
      evidencePath,
      new RegExp(`^docs/release/evidence/stage-${row.stage}/[A-Za-z0-9._/-]+$`),
      `${row.id} evidence_path must stay inside its Stage ${row.stage} release evidence`
    );

    const resolvedEvidencePath = resolve(canonicalRepositoryRoot, evidencePath);
    assert.equal(
      isStrictDescendant(canonicalRepositoryRoot, resolvedEvidencePath),
      true,
      `${row.id} evidence_path escapes the repository`
    );
    assert.equal(existsSync(resolvedEvidencePath), true, `${row.id} evidence file is missing: ${evidencePath}`);
    const evidenceEntry = assertUnlinkedPathComponents(canonicalRepositoryRoot, evidencePath, row.id);
    assert.equal(evidenceEntry.metadata.isFile(), true, `${row.id} evidence path is not a file: ${evidencePath}`);

    const evidenceRoot = resolve(canonicalRepositoryRoot, 'docs', 'release', 'evidence', `stage-${row.stage}`);
    const canonicalEvidenceRoot = realpathSync.native(evidenceRoot);
    const canonicalEvidencePath = realpathSync.native(evidenceEntry.path);
    assert.equal(
      isStrictDescendant(canonicalRepositoryRoot, canonicalEvidenceRoot),
      true,
      `${row.id} canonical evidence root resolves outside the canonical repository root`
    );
    assert.equal(
      isStrictDescendant(canonicalRepositoryRoot, canonicalEvidencePath),
      true,
      `${row.id} canonical evidence file resolves outside the canonical repository root`
    );
    assert.equal(
      isStrictDescendant(canonicalEvidenceRoot, canonicalEvidencePath),
      true,
      `${row.id} canonical evidence file resolves outside its canonical evidence root`
    );
  }

  const stage2Rows = rows.filter(row => row.stage === '2');
  assert.equal(stage2Rows.length, 14, 'Task 1 requirements ledger must contain exactly 14 Stage 2 rows');
  assert.deepEqual(
    stage2Rows.map(row => row.id).sort(),
    [...expectedStage2Ids].sort(),
    'Stage 2 requirement IDs are missing or unexpected'
  );

  return { rows, stage2Rows };
}

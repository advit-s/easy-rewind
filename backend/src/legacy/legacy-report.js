'use strict';

const { lstatSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { basename, dirname, isAbsolute, relative, resolve, sep } = require('node:path');

const classification = 'SENSITIVE MIGRATION METADATA';
const forbiddenOutputSegments = new Set([
  'artifacts',
  'build',
  'coverage',
  'diagnostics',
  'dist',
  'export',
  'exports',
  'log',
  'logs',
  'legacy-backup',
  'legacy-inspection-work',
  'migration-temp',
  'migration-work',
  'out',
  'playwright-report',
  'release',
  'inspection-work',
  'quarantine',
  'test',
  'tests',
  'test-results',
]);

class LegacyReportError extends Error {
  constructor(code) {
    const messages = {
      LEGACY_REPORT_INVALID: 'Legacy inspection report metadata is invalid.',
      LEGACY_REPORT_PATH_INVALID: 'Legacy inspection report output path is invalid.',
      LEGACY_REPORT_WRITE_FAILED: 'Legacy inspection report could not be written safely.',
    };
    super(messages[code] ?? messages.LEGACY_REPORT_WRITE_FAILED);
    this.name = 'LegacyReportError';
    this.code = code;
  }
}

function fail(code) {
  throw new LegacyReportError(code);
}

function safeIdentifier(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255 || value.includes('\0')) {
    fail('LEGACY_REPORT_INVALID');
  }
  return value;
}

function safeCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('LEGACY_REPORT_INVALID');
  return value;
}

function freezeTable(table) {
  return Object.freeze({ name: safeIdentifier(table?.name), rowCount: safeCount(table?.rowCount) });
}

function createLegacyReport(metadata) {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) fail('LEGACY_REPORT_INVALID');
  if (typeof metadata.schemaSignature !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.schemaSignature)) {
    fail('LEGACY_REPORT_INVALID');
  }
  if (!Array.isArray(metadata.tables)) fail('LEGACY_REPORT_INVALID');
  const tables = metadata.tables.map(freezeTable);
  const conflictTables = metadata.likelyConflicts?.tables;
  const unsupportedTables = metadata.unsupportedSchema?.tables;
  const unsupportedColumns = metadata.unsupportedSchema?.columns;
  const unsupportedValues = metadata.unsupportedSchema?.values;
  if (
    !Array.isArray(conflictTables) ||
    !Array.isArray(unsupportedTables) ||
    !Array.isArray(unsupportedColumns) ||
    !Array.isArray(unsupportedValues)
  ) {
    fail('LEGACY_REPORT_INVALID');
  }
  const report = {
    classification,
    schemaSignature: metadata.schemaSignature,
    tables: Object.freeze(tables),
    totalRows: safeCount(metadata.totalRows),
    likelyConflicts: Object.freeze({
      total: safeCount(metadata.likelyConflicts.total),
      tables: Object.freeze(
        conflictTables.map(entry =>
          Object.freeze({ table: safeIdentifier(entry?.table), count: safeCount(entry?.count) })
        )
      ),
    }),
    unsupportedSchema: Object.freeze({
      tables: Object.freeze(unsupportedTables.map(safeIdentifier).sort((left, right) => left.localeCompare(right))),
      columns: Object.freeze(
        unsupportedColumns.map(entry => {
          if (!Array.isArray(entry?.columns)) fail('LEGACY_REPORT_INVALID');
          return Object.freeze({
            table: safeIdentifier(entry.table),
            columns: Object.freeze(entry.columns.map(safeIdentifier).sort((left, right) => left.localeCompare(right))),
          });
        })
      ),
      values: Object.freeze(
        unsupportedValues.map(entry =>
          Object.freeze({
            table: safeIdentifier(entry?.table),
            column: safeIdentifier(entry?.column),
            count: safeCount(entry?.count),
          })
        )
      ),
    }),
    estimatedActions: Object.freeze({
      inspectableRows: safeCount(metadata.estimatedActions?.inspectableRows),
      likelyImports: safeCount(metadata.estimatedActions?.likelyImports),
      reviewRequired: safeCount(metadata.estimatedActions?.reviewRequired),
      importPerformed: metadata.estimatedActions?.importPerformed,
      schemaConversionPerformed: metadata.estimatedActions?.schemaConversionPerformed,
    }),
  };
  if (
    report.estimatedActions.importPerformed !== false ||
    report.estimatedActions.schemaConversionPerformed !== false ||
    report.totalRows !== tables.reduce((total, table) => total + table.rowCount, 0)
  ) {
    fail('LEGACY_REPORT_INVALID');
  }
  return Object.freeze(report);
}

function isContained(parent, candidate) {
  const value = relative(resolve(parent), resolve(candidate));
  return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`));
}

function validateOutputPath(outputPath, repositoryRoot) {
  if (
    typeof outputPath !== 'string' ||
    outputPath.length === 0 ||
    !isAbsolute(outputPath) ||
    resolve(outputPath) !== outputPath ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.legacy-inspection-report\.json$/.test(basename(outputPath)) ||
    typeof repositoryRoot !== 'string' ||
    !isAbsolute(repositoryRoot) ||
    resolve(repositoryRoot) !== repositoryRoot ||
    isContained(repositoryRoot, outputPath)
  ) {
    fail('LEGACY_REPORT_PATH_INVALID');
  }
  const segments = resolve(outputPath)
    .split(sep)
    .map(segment => segment.toLowerCase());
  if (segments.some(segment => forbiddenOutputSegments.has(segment))) fail('LEGACY_REPORT_PATH_INVALID');
  const parent = dirname(outputPath);
  let metadata;
  let canonical;
  try {
    metadata = lstatSync(parent);
    canonical = realpathSync.native(parent);
  } catch {
    fail('LEGACY_REPORT_PATH_INVALID');
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || resolve(canonical) !== resolve(parent)) {
    fail('LEGACY_REPORT_PATH_INVALID');
  }
}

async function writeLegacyReport({ report, outputPath, repositoryRoot, filePermissions } = {}) {
  if (
    filePermissions === null ||
    typeof filePermissions !== 'object' ||
    typeof filePermissions.restrictFile !== 'function'
  ) {
    fail('LEGACY_REPORT_INVALID');
  }
  const normalizedReport = createLegacyReport(report);
  validateOutputPath(outputPath, repositoryRoot);
  let created = false;
  try {
    writeFileSync(outputPath, `${JSON.stringify(normalizedReport, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
      encoding: 'utf8',
    });
    created = true;
    await filePermissions.restrictFile(outputPath);
  } catch (error) {
    if (created) {
      try {
        rmSync(outputPath, { force: true });
      } catch {
        // The stable write failure remains authoritative.
      }
    }
    if (error instanceof LegacyReportError) throw error;
    fail('LEGACY_REPORT_WRITE_FAILED');
  }
  return Object.freeze({ classification });
}

module.exports = {
  LegacyReportError,
  createLegacyReport,
  writeLegacyReport,
};

'use strict';

const {
  BUNDLE_SCHEMA,
  MAX_BYTES,
  MAX_DEPTH,
  MAX_ROWS,
  assertIdentifier,
  assertNotAborted,
  assertNow,
  buildBundle,
  bundleChecksum,
  createId,
  defaultIds,
  exactKeys,
  fail,
  settingContainsSecret,
  stableStringify,
} = require('./bundle');

const strategies = new Set(['fail', 'skip', 'replace']);

function parseBundle(input) {
  let parsed;
  if (Buffer.isBuffer(input) || typeof input === 'string') {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
    if (bytes.length > MAX_BYTES) fail('IMPORT_TOO_LARGE');
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      fail('IMPORT_JSON_INVALID');
    }
  } else {
    parsed = input;
    let bytes;
    try {
      bytes = Buffer.byteLength(stableStringify(input));
    } catch {
      fail('IMPORT_JSON_INVALID');
    }
    if (bytes > MAX_BYTES) fail('IMPORT_TOO_LARGE');
  }
  return parsed;
}

function assertDepth(value, depth = 0, observed = new WeakSet()) {
  if (depth > MAX_DEPTH) fail('IMPORT_TOO_DEEP');
  if (value === null || typeof value !== 'object') return;
  if (observed.has(value)) fail('IMPORT_BUNDLE_INVALID');
  observed.add(value);
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    assertDepth(nested, depth + 1, observed);
  }
  observed.delete(value);
}

function validateShape(bundle, profileId) {
  assertDepth(bundle);
  if (
    !exactKeys(bundle, ['manifest', 'data']) ||
    !exactKeys(bundle.manifest, ['format', 'formatVersion', 'schemaVersion', 'ownerId', 'createdAt', 'checksum']) ||
    !exactKeys(bundle.data, Object.keys(BUNDLE_SCHEMA.tables))
  ) {
    fail('IMPORT_BUNDLE_INVALID');
  }
  const manifest = bundle.manifest;
  if (
    manifest.format !== BUNDLE_SCHEMA.format ||
    manifest.formatVersion !== BUNDLE_SCHEMA.formatVersion ||
    manifest.schemaVersion !== BUNDLE_SCHEMA.schemaVersion
  ) {
    fail('IMPORT_VERSION_UNSUPPORTED');
  }
  if (manifest.ownerId !== profileId || typeof manifest.ownerId !== 'string' || manifest.ownerId.length === 0) {
    fail('IMPORT_OWNER_MISMATCH');
  }
  if (
    !Number.isSafeInteger(manifest.createdAt) ||
    manifest.createdAt < 0 ||
    typeof manifest.checksum !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest.checksum)
  ) {
    fail('IMPORT_BUNDLE_INVALID');
  }
  if (bundleChecksum(bundle.data) !== manifest.checksum) fail('IMPORT_CHECKSUM_INVALID');
}

function validateRows(bundle, profileId) {
  let totalRows = 0;
  const ids = new Map();
  for (const [tableName, declaration] of Object.entries(BUNDLE_SCHEMA.tables)) {
    const rows = bundle.data[tableName];
    if (!Array.isArray(rows)) fail('IMPORT_BUNDLE_INVALID');
    totalRows += rows.length;
    if (totalRows > MAX_ROWS) fail('IMPORT_TOO_MANY_ROWS');
    const tableIds = new Set();
    ids.set(tableName, tableIds);
    for (const row of rows) {
      if (!exactKeys(row, declaration.columns)) fail('IMPORT_BUNDLE_INVALID');
      assertIdentifier(row.id, 'IMPORT_BUNDLE_INVALID');
      if (row.profile_id !== profileId) fail('IMPORT_OWNER_MISMATCH');
      if (tableIds.has(row.id)) fail('IMPORT_DUPLICATE_ID');
      tableIds.add(row.id);
      if (
        Object.values(row).some(
          value =>
            value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean'
        )
      ) {
        fail('IMPORT_BUNDLE_INVALID');
      }
      if (tableName === 'settings' && settingContainsSecret(row)) fail('IMPORT_SECRET_INVALID');
    }
  }
  return { ids, totalRows };
}

function referenceExists({ db, profileId, ids, tableName, id }) {
  if (ids.get(tableName).has(id)) return true;
  const row = db.prepare(`SELECT profile_id FROM "${tableName}" WHERE id = ?`).get(id);
  if (row === undefined) return false;
  if (row.profile_id !== profileId) fail('IMPORT_OWNER_MISMATCH');
  return true;
}

function validateReferences({ db, bundle, profileId, ids }) {
  for (const [tableName, declaration] of Object.entries(BUNDLE_SCHEMA.tables)) {
    for (const row of bundle.data[tableName]) {
      for (const reference of declaration.references) {
        const value = row[reference.column];
        if (reference.optional === true && value === null) continue;
        if (
          typeof value !== 'string' ||
          !referenceExists({
            db,
            profileId,
            ids,
            tableName: reference.table,
            id: value,
          })
        ) {
          fail('IMPORT_REFERENCE_INVALID');
        }
      }
    }
  }
}

function validateBundle({ db, profileId, input }) {
  assertIdentifier(profileId, 'IMPORT_OWNER_INVALID');
  const bundle = parseBundle(input);
  validateShape(bundle, profileId);
  const details = validateRows(bundle, profileId);
  validateReferences({ db, bundle, profileId, ids: details.ids });
  return { bundle, totalRows: details.totalRows };
}

function reportFor({ db, bundle, profileId, totalRows }) {
  const counts = {};
  const conflicts = [];
  for (const [tableName, declaration] of Object.entries(BUNDLE_SCHEMA.tables)) {
    let conflictCount = 0;
    for (const row of bundle.data[tableName]) {
      const existing = db.prepare(`SELECT profile_id FROM "${tableName}" WHERE id = ?`).get(row.id);
      if (existing !== undefined && existing.profile_id !== profileId) fail('IMPORT_OWNER_MISMATCH');
      if (existing !== undefined) {
        conflictCount += 1;
        conflicts.push({ table: tableName, id: row.id, reason: 'id_exists' });
      }
    }
    counts[tableName] = {
      incoming: bundle.data[tableName].length,
      inserts: bundle.data[tableName].length - conflictCount,
      conflicts: conflictCount,
    };
    if (!Array.isArray(declaration.columns)) fail('IMPORT_OPTIONS_INVALID');
  }
  return Object.freeze({
    totalRows,
    counts: Object.freeze(counts),
    conflicts: Object.freeze(conflicts),
  });
}

function begin(db) {
  db.exec('BEGIN IMMEDIATE');
}

function rollbackTransaction(db) {
  try {
    if (db.inTransaction) db.exec('ROLLBACK');
  } catch {
    // The original operation error remains authoritative.
  }
}

function insertRows({ db, bundle, strategy }) {
  for (const [tableName, declaration] of Object.entries(BUNDLE_SCHEMA.tables)) {
    const quoted = declaration.columns.map(column => `"${column}"`);
    const placeholders = declaration.columns.map(() => '?').join(', ');
    const updates = declaration.columns
      .filter(column => column !== 'id')
      .map(column => `"${column}" = excluded."${column}"`)
      .join(', ');
    const suffix = strategy === 'skip' ? 'ON CONFLICT(id) DO NOTHING' : `ON CONFLICT(id) DO UPDATE SET ${updates}`;
    const statement = db.prepare(
      `INSERT INTO "${tableName}"(${quoted.join(', ')})
       VALUES (${placeholders})
       ${suffix}`
    );
    for (const row of bundle.data[tableName]) {
      statement.run(...declaration.columns.map(column => row[column]));
    }
  }
}

function restoreRows({ db, bundle, profileId }) {
  const tableNames = Object.keys(BUNDLE_SCHEMA.tables);
  for (const tableName of [...tableNames].reverse()) {
    const ids = bundle.data[tableName].map(row => row.id);
    if (ids.length === 0) {
      db.prepare(`DELETE FROM "${tableName}" WHERE profile_id = ?`).run(profileId);
      continue;
    }
    const placeholders = ids.map(() => '?').join(', ');
    db.prepare(
      `DELETE FROM "${tableName}"
       WHERE profile_id = ? AND id NOT IN (${placeholders})`
    ).run(profileId, ...ids);
  }
  insertRows({ db, bundle, strategy: 'replace' });
}

function createImportService({ db, backupService, now = Date.now, ids = defaultIds } = {}) {
  if (
    db === null ||
    typeof db !== 'object' ||
    typeof db.prepare !== 'function' ||
    backupService === null ||
    typeof backupService !== 'object' ||
    typeof backupService.createVerified !== 'function' ||
    typeof now !== 'function' ||
    typeof ids !== 'function'
  ) {
    fail('IMPORT_OPTIONS_INVALID');
  }

  function dryRun({ profileId, bundle, signal } = {}) {
    assertNotAborted(signal, 'IMPORT_CANCELLED');
    const validated = validateBundle({ db, profileId, input: bundle });
    assertNotAborted(signal, 'IMPORT_CANCELLED');
    return reportFor({ db, profileId, ...validated });
  }

  function apply({ profileId, bundle, conflictStrategy = 'fail', signal } = {}) {
    if (!strategies.has(conflictStrategy)) fail('IMPORT_BUNDLE_INVALID');
    assertNotAborted(signal, 'IMPORT_CANCELLED');
    const validated = validateBundle({ db, profileId, input: bundle });
    const report = reportFor({ db, profileId, ...validated });
    if (conflictStrategy === 'fail' && report.conflicts.length > 0) fail('IMPORT_CONFLICT');
    const timestamp = assertNow(now, 'IMPORT_OPTIONS_INVALID');
    const destination = buildBundle({ db, profileId, createdAt: timestamp });
    const backup = backupService.createVerified({
      profileId,
      bytes: Buffer.from(stableStringify(destination)),
    });
    if (
      backup === null ||
      typeof backup !== 'object' ||
      backup.verified !== true ||
      typeof backup.reference !== 'string' ||
      typeof backup.checksum !== 'string'
    ) {
      fail('IMPORT_BACKUP_REQUIRED');
    }
    const runId = createId(ids);
    db.prepare(
      `INSERT INTO import_runs(
         id, profile_id, format_version, schema_version, state, source_checksum,
         backup_ref, report_json, started_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`
    ).run(
      runId,
      profileId,
      BUNDLE_SCHEMA.formatVersion,
      BUNDLE_SCHEMA.schemaVersion,
      validated.bundle.manifest.checksum,
      backup.reference,
      stableStringify(report),
      timestamp,
      timestamp,
      timestamp
    );

    try {
      assertNotAborted(signal, 'IMPORT_CANCELLED');
      begin(db);
      insertRows({ db, bundle: validated.bundle, strategy: conflictStrategy });
      assertNotAborted(signal, 'IMPORT_CANCELLED');
      db.exec('COMMIT');
      db.prepare(
        `UPDATE import_runs
         SET state = 'succeeded', finished_at = ?, updated_at = ?
         WHERE id = ? AND profile_id = ? AND state = 'running'`
      ).run(timestamp, timestamp, runId, profileId);
      return Object.freeze({
        runId,
        state: 'succeeded',
        backupRef: backup.reference,
        report,
      });
    } catch (error) {
      rollbackTransaction(db);
      backupService.remove?.(backup.reference);
      const cancelled = error?.code === 'IMPORT_CANCELLED';
      db.prepare(
        `UPDATE import_runs
         SET state = ?, error_code = ?, finished_at = ?, updated_at = ?
         WHERE id = ? AND profile_id = ? AND state = 'running'`
      ).run(
        cancelled ? 'cancelled' : 'failed',
        cancelled ? 'IMPORT_CANCELLED' : 'IMPORT_APPLY_FAILED',
        timestamp,
        timestamp,
        runId,
        profileId
      );
      fail(cancelled ? 'IMPORT_CANCELLED' : 'IMPORT_APPLY_FAILED');
    }
  }

  function rollback({ profileId, runId, signal } = {}) {
    assertIdentifier(profileId, 'IMPORT_OWNER_INVALID');
    assertIdentifier(runId, 'IMPORT_STATE_INVALID');
    assertNotAborted(signal, 'IMPORT_CANCELLED');
    const run = db
      .prepare(
        `SELECT state, backup_ref
         FROM import_runs
         WHERE id = ? AND profile_id = ?`
      )
      .get(runId, profileId);
    if (run === undefined) fail('IMPORT_NOT_FOUND');
    if (run.state !== 'succeeded' || run.backup_ref === null) fail('IMPORT_STATE_INVALID');
    let validated;
    try {
      const bytes = backupService.readVerified({
        profileId,
        reference: run.backup_ref,
      });
      validated = validateBundle({ db, profileId, input: bytes });
      begin(db);
      restoreRows({ db, bundle: validated.bundle, profileId });
      assertNotAborted(signal, 'IMPORT_CANCELLED');
      db.exec('COMMIT');
    } catch (error) {
      rollbackTransaction(db);
      if (error?.code === 'IMPORT_CANCELLED') throw error;
      fail('IMPORT_ROLLBACK_FAILED');
    }
    const timestamp = assertNow(now, 'IMPORT_OPTIONS_INVALID');
    db.prepare(
      `UPDATE import_runs
       SET state = 'rolled_back', finished_at = ?, updated_at = ?
       WHERE id = ? AND profile_id = ? AND state = 'succeeded'`
    ).run(timestamp, timestamp, runId, profileId);
    return Object.freeze({ runId, state: 'rolled_back' });
  }

  function cancel({ profileId, runId } = {}) {
    assertIdentifier(profileId, 'IMPORT_OWNER_INVALID');
    assertIdentifier(runId, 'IMPORT_STATE_INVALID');
    const row = db
      .prepare(`SELECT state, backup_ref FROM import_runs WHERE id = ? AND profile_id = ?`)
      .get(runId, profileId);
    if (row === undefined) fail('IMPORT_NOT_FOUND');
    if (!new Set(['dry_run', 'ready', 'running']).has(row.state)) fail('IMPORT_STATE_INVALID');
    if (row.backup_ref !== null) backupService.remove?.(row.backup_ref);
    const timestamp = assertNow(now, 'IMPORT_OPTIONS_INVALID');
    db.prepare(
      `UPDATE import_runs
       SET state = 'cancelled', error_code = 'IMPORT_CANCELLED',
           finished_at = ?, updated_at = ?
       WHERE id = ? AND profile_id = ?`
    ).run(timestamp, timestamp, runId, profileId);
    return Object.freeze({ runId, state: 'cancelled' });
  }

  return Object.freeze({ apply, cancel, dryRun, rollback });
}

module.exports = { createImportService };

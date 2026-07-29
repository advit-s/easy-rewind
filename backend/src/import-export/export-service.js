'use strict';

const {
  BUNDLE_SCHEMA,
  assertIdentifier,
  assertNotAborted,
  assertNow,
  buildBundle,
  bundleChecksum,
  createId,
  defaultIds,
  fail,
  isAbort,
  sha256,
  stableStringify,
} = require('./bundle');

function validDatabase(db) {
  return db !== null && typeof db === 'object' && typeof db.prepare === 'function';
}

function validArtifactStore(artifactStore) {
  return (
    artifactStore !== null &&
    typeof artifactStore === 'object' &&
    typeof artifactStore.writeAtomic === 'function' &&
    typeof artifactStore.remove === 'function'
  );
}

function safeRemove(artifactStore, reference) {
  try {
    artifactStore.remove(reference);
  } catch {
    // Cleanup failure must not replace the stable operation error.
  }
}

function createExportService({ db, artifactStore, pathAdapter, now = Date.now, ids = defaultIds } = {}) {
  if (
    !validDatabase(db) ||
    !validArtifactStore(artifactStore) ||
    pathAdapter === null ||
    typeof pathAdapter !== 'object' ||
    typeof pathAdapter.exportReference !== 'function' ||
    typeof now !== 'function' ||
    typeof ids !== 'function'
  ) {
    fail('EXPORT_OPTIONS_INVALID');
  }

  function create({ profileId, signal } = {}) {
    assertIdentifier(profileId, 'EXPORT_OWNER_INVALID');
    assertNotAborted(signal, 'EXPORT_CANCELLED');
    if (db.prepare('SELECT 1 FROM profiles WHERE id = ? AND deleted_at IS NULL').get(profileId) === undefined) {
      fail('EXPORT_OWNER_NOT_FOUND');
    }
    const runId = createId(ids);
    const timestamp = assertNow(now);
    const reference = pathAdapter.exportReference({ profileId, id: runId });
    assertIdentifier(reference, 'EXPORT_OPTIONS_INVALID');
    db.prepare(
      `INSERT INTO export_runs(
         id, profile_id, format_version, schema_version, state, artifact_ref,
         item_count, started_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'running', ?, 0, ?, ?, ?)`
    ).run(
      runId,
      profileId,
      BUNDLE_SCHEMA.formatVersion,
      BUNDLE_SCHEMA.schemaVersion,
      reference,
      timestamp,
      timestamp,
      timestamp
    );

    try {
      const bundle = buildBundle({ db, profileId, createdAt: timestamp });
      const bytes = Buffer.from(stableStringify(bundle));
      const checksum = sha256(bytes);
      assertNotAborted(signal, 'EXPORT_CANCELLED');
      artifactStore.writeAtomic(reference, bytes, {
        contentType: 'application/json',
        sensitive: true,
        signal,
      });
      assertNotAborted(signal, 'EXPORT_CANCELLED');
      const itemCount = Object.values(bundle.data).reduce((total, rows) => total + rows.length, 0);
      db.prepare(
        `UPDATE export_runs
         SET state = 'succeeded', checksum = ?, item_count = ?, finished_at = ?, updated_at = ?
         WHERE id = ? AND profile_id = ? AND state = 'running'`
      ).run(checksum, itemCount, timestamp, timestamp, runId, profileId);
      return Object.freeze({
        runId,
        state: 'succeeded',
        artifactRef: reference,
        checksum,
        bundle,
      });
    } catch (error) {
      safeRemove(artifactStore, reference);
      const cancelled = error?.code === 'EXPORT_CANCELLED' || isAbort(error);
      db.prepare(
        `UPDATE export_runs
         SET state = ?, error_code = ?, finished_at = ?, updated_at = ?
         WHERE id = ? AND profile_id = ? AND state = 'running'`
      ).run(
        cancelled ? 'cancelled' : 'failed',
        cancelled ? 'EXPORT_CANCELLED' : 'EXPORT_FAILED',
        timestamp,
        timestamp,
        runId,
        profileId
      );
      fail(cancelled ? 'EXPORT_CANCELLED' : 'EXPORT_FAILED');
    }
  }

  function cancel({ profileId, runId } = {}) {
    assertIdentifier(profileId, 'EXPORT_OWNER_INVALID');
    assertIdentifier(runId, 'EXPORT_STATE_INVALID');
    const run = db
      .prepare(`SELECT state, artifact_ref FROM export_runs WHERE profile_id = ? AND id = ?`)
      .get(profileId, runId);
    if (run === undefined) fail('EXPORT_NOT_FOUND');
    if (run.state !== 'running') fail('EXPORT_STATE_INVALID');
    if (run.artifact_ref !== null) safeRemove(artifactStore, run.artifact_ref);
    const timestamp = assertNow(now);
    db.prepare(
      `UPDATE export_runs
       SET state = 'cancelled', error_code = 'EXPORT_CANCELLED',
           finished_at = ?, updated_at = ?
       WHERE profile_id = ? AND id = ? AND state = 'running'`
    ).run(timestamp, timestamp, profileId, runId);
    return Object.freeze({ runId, state: 'cancelled' });
  }

  return Object.freeze({ cancel, create });
}

module.exports = {
  BUNDLE_SCHEMA,
  bundleChecksum,
  createExportService,
  stableStringify,
};

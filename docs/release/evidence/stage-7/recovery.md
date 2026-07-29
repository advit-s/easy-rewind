# Stage 7 release recovery

## Withdraw or replace an artifact

1. Stop distribution of the affected artifact and publish its exact filename,
   version, architecture, and checksum as withdrawn without including user
   data or secrets.
2. Preserve the build provenance and sanitized failure evidence.
3. Revoke exposed install/device/provider credentials as applicable.
4. Restore the last signed, verified artifact and its immutable checksum
   manifest. Never relabel an unsigned artifact as signed.
5. Rebuild from a clean checkout with pinned toolchains, rerun every required
   gate, and issue a new version. Do not replace bytes beneath an existing
   checksum or release tag.

## Data or schema regression

Stop all writers. Preserve the current runtime database with its matching
WAL/SHM files, then verify the most recent protected destination backup.
Restore to a new protected runtime path and start with listeners/schedulers
disabled. Never restore from or run tests against the sole legacy quarantine
copy.

## Synchronization regression

Stop sync on both replicas without deleting outbox operations, conflicts,
tombstones, or cursors. Preserve both local databases and sidecars. Revoke a
suspect device credential, verify the PC TLS identity, and resume from the last
acknowledged opaque cursor. Use a verified snapshot only after backup, then
replay preserved local operations through the idempotent protocol.

## Client rollback

- Chrome: disable capture, clear only extension state, revoke its install
  credential, load a known-good package, and reauthenticate.
- Dashboard: end the browser session, clear session-only authorization, serve
  the known-good assets, and reauthenticate.
- Android: unregister background work, preserve the local database and queued
  changes, revoke the device if needed, then install the known-good build and
  re-pair explicitly. Clearing app data requires a verified backup and user
  authorization.

## Credential incident

Provider revocation is the first containment action and cannot be replaced by
deleting source, rewriting history, scanning artifacts, or preserving a
quarantine. Republish Git history separately when required and require fresh
clones from collaborators.

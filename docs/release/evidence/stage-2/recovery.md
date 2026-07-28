# Stage 2 recovery and rollback

This procedure is part of the Stage 2 exit gate. It never treats the sole
quarantine backup as a working database or as secure credential storage.
Evidence recorded here contains no database rows, credentials, personal paths,
hostnames, device identifiers, or raw database hashes.

## Non-negotiable source boundary

1. Stop Easy Rewind through the idempotent shared-runtime shutdown path.
2. Verify the already-created quarantine manifest, file sizes, and SHA-256
   hashes without opening its database through SQLite.
3. Create a second, dated recovery copy of the coherent database, matching
   `-wal` and `-shm` files, and settings file.
4. Restrict that recovery copy to the current Windows user and verify its
   manifest before any inspection.
5. Create a separate disposable working copy from the verified recovery copy.
6. Perform inspection, dry run, migration, and tests only against disposable
   or destination copies. Never open or modify the sole quarantine files.

## Backup-first migration

The operator-visible sequence is:

1. Verify the quarantine manifest and hashes.
2. Create and verify the dated recovery copy.
3. Inspect a disposable working copy in read-only mode.
4. Produce a dry-run report containing only schema classification, row counts,
   transforms, skips, conflicts, warnings, required disk, and rollback path.
5. Require explicit confirmation after the dry-run report.
6. Create and verify a destination/runtime backup.
7. Run the canonical import transaction and record the source fingerprint.
8. Verify destination counts, SQLite integrity, schema version, ownership,
   references, revisions, tombstones, and migration-run metadata.
9. Retain rollback metadata outside logs, exports, builds, and release
   evidence.

Application startup may expose only a safe
`legacyMigrationAvailable` status. It must not inspect, convert, or import
legacy data automatically.

## Failure rollback

If planning, confirmation, import, verification, or startup fails:

1. Stop accepting new requests and close schedulers, listeners, jobs, and
   databases through the shared lifecycle.
2. Preserve the failed destination and sidecars as sensitive local diagnostics
   outside Git, logs, tests, builds, and exports.
3. Reverify the pre-migration runtime backup manifest and hashes.
4. Restore that runtime backup to a new path. Do not overwrite or open the sole
   quarantine copy.
5. Start the restored runtime with listeners and schedulers disabled.
6. Run SQLite integrity, schema-history, row-count, ownership, and domain
   invariant checks.
7. Enable loopback service only after the restored runtime is healthy.
8. Record only safe failure classification and fingerprints in sensitive
   operator records. Add a regression test before retrying.

## Rehearsal evidence

| Gate                                                | State      | Evidence                                                                     |
| --------------------------------------------------- | ---------- | ---------------------------------------------------------------------------- |
| Sole quarantine never opened or mutated             | `verified` | Stage 1 disposable-copy rehearsal reverified the preserved set unchanged     |
| Manifest-bound disposable recovery copy             | `verified` | Stage 1 rehearsal verified all four manifest-bound files before safe cleanup |
| Stage 2 synthetic dry-run counts and conflicts      | `verified` | Focused migration tests passed with aggregate-only plan assertions           |
| Interrupted migration restores the runtime backup   | `verified` | Transaction interruption and verified rollback rehearsal passed              |
| Repeated migration does not duplicate imports       | `verified` | Source fingerprint and repeat-safe import assertions passed                  |
| Quarantine source unchanged after Stage 2 rehearsal | `verified` | Disposable-copy workflow and manifest-bound source invariants passed         |

All recovery rows pass. The separate clean-install and provider-revocation
release gates remain recorded in the Stage 2 README.

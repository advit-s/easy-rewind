# Stage 3 recovery

## Task 1 schema recovery

Migration 004 is additive. Before applying it to any non-disposable database,
stop every Easy Rewind writer and create and verify the normal destination
database backup, including matching WAL and SHM state where present.

If migration 004 fails, the migration runner rolls back its immediate
transaction and does not record version 4. Preserve the failure evidence,
verify the pre-migration backup, and restore that verified destination backup
before retrying. Never repair an applied migration by editing migrations 001
through 004 in place.

Downgrading application code after migration 004 is not an automatic schema
downgrade. Restore the verified pre-migration destination backup instead. The
legacy quarantine remains read-only and is never the rollback target.

When migration 004 finds pre-existing reminder deliveries, it preserves each
row and assigns it to an existing owner-matched device. If the owner has no
device, the migration creates one deterministic local Windows target before
rebuilding the delivery table. Conflicting legacy rows that cannot satisfy the
new per-device/channel uniqueness constraint make the transaction fail and
roll back; they are never silently discarded.

## Runtime recovery

1. Disable job acquisition, reminder delivery, the loopback listener, and the
   LAN gateway; allow active bounded transactions to commit or roll back.
2. Preserve the runtime database and matching WAL/SHM files as sensitive
   diagnostics and verify the most recent destination backup.
3. Restore to a new protected runtime path. Never overwrite the sole verified
   backup during diagnosis.
4. Start with listeners, schedulers, and LAN sync disabled. Run SQLite
   integrity, schema, owner, job-lease, reminder-delivery, sync-cursor,
   tombstone, and idempotency checks.
5. Enable loopback, then jobs, then the LAN gateway. Re-pair revoked or
   replaced devices; use snapshot resynchronization only when retained cursor
   history is unavailable.

Import rollback reads and verifies its pre-import backup before restoring rows
in one transaction. Interrupted sync resumes at the last committed opaque
cursor; acknowledged operations are idempotent. LAN sync remains disabled by
default, and disabling it allocates no certificate or listener.

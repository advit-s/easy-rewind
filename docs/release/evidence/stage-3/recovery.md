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

Runtime recovery drills for jobs, imports, synchronization, snapshots, and the
LAN gateway are pending their implementation tasks. Therefore the Stage 3 exit
gate is not yet eligible to pass.

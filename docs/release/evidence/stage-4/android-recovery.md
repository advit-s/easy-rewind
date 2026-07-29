# Stage 4 Android recovery

Use this procedure when Android pairing, local storage, synchronization,
background work, or notifications become inconsistent:

1. Stop foreground synchronization and unregister background work. Preserve the
   visible queued count and terminal status.
2. Stop the app before copying its protected local SQLite database. Preserve
   the database with matching WAL and SHM files together; do not open or
   checkpoint it first.
3. Record checksums for the preserved copy and restrict it to the current
   device/user boundary. Treat the copy as sensitive user data, not as secure
   credential storage.
4. Preserve queued outbox operations before repair. Never clear local data,
   conflicts, tombstones, or the opaque cursor as an automatic retry.
5. Verify that the paired PC is reachable and that its presented TLS
   fingerprint exactly matches the separately protected pinned identity.
6. If the credential is missing, expired, or revoked, stop retrying and re-pair
   through explicit QR scan and PC confirmation. Never fall back to unpinned
   TLS or copy a credential into the database, logs, or evidence.
7. Resume from the last committed opaque cursor. Delete only outbox operations
   explicitly acknowledged by the PC and retain both variants of every
   unresolved conflict.
8. If snapshot recovery is required, first preserve the mobile database and
   queued operations. Apply a verified PC snapshot transactionally, then replay
   preserved local operations through the normal idempotent protocol.
9. Recreate reminder notifications only from durable reminder state and stored
   Android notification IDs. An Android acknowledgement must not acknowledge
   the PC delivery.
10. Validate the repaired source and rerun the development-build acceptance
    scenarios before release.

Uninstalling the app or clearing application storage destroys the only local
copy of unsynchronized work. Those actions require an independently verified
backup and explicit user authorization.

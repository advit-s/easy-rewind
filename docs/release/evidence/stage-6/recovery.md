# Stage 6 recovery

## Startup or packaged-resource failure

1. Quit every Easy Rewind Electron and backend process.
2. Preserve sanitized failure evidence; do not copy authorization values,
   database rows, hostnames, or quarantine paths into logs or reports.
3. Verify that desktop, backend, dashboard, contracts, icon, overlay, and
   preload resources came from the expected repository root in development or
   `process.resourcesPath\app.asar` when packaged.
4. Do not fall back to a system `node.exe`, a repository database, a portable
   executable directory, or an unprotected alternate storage path.
5. Restore the last known-good application artifact and start with listeners
   and schedulers disabled. Enable UI only after ready health succeeds.

## Upgrade or native ABI failure

1. Stop all writers before touching runtime data.
2. Copy the runtime database with matching WAL/SHM files into a protected,
   timestamped destination backup and verify its checksums.
3. Preserve the failing executable separately from user data. Reinstall the
   previous known-good application artifact; never overwrite the runtime
   database with files from an installer or portable directory.
4. Do not edit or reverse an applied migration. If the new schema is
   incompatible with the previous application, restore the verified
   pre-upgrade destination backup to a new protected runtime path.
5. Start with loopback, schedulers, and LAN sync disabled. Verify SQLite
   integrity, migration checksums, and health before re-enabling components.

## IPC, reminder, or window failure

Quit and restart the application to dispose registered handlers and active
requests. Do not acknowledge a reminder merely because a notification was
displayed. If a desktop authorization or device relationship may be exposed,
revoke it and reauthenticate through the supported local boundary.

## Uninstall

Uninstalling application binaries must not silently remove
`%LOCALAPPDATA%\easy-rewind\runtime`. Data removal is a distinct, explicit,
backup-first action. Before authorized removal, stop the app, preserve and
verify the database plus WAL/SHM files, protected settings/secrets, exports,
and rollback metadata. The legacy quarantine remains separate and is never
deleted as part of application uninstall.

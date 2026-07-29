# Easy Rewind

Easy Rewind is a local-first knowledge assistant for Windows, Chrome, the web
dashboard, and Android. The PC and phone each keep a local SQLite database, so
capture, reading, reminders, and review remain available offline. When the
paired PC is reachable, synchronization resumes through the explicit
authenticated device boundary and preserves conflicts instead of silently
overwriting either replica.

One Electron-independent backend owns the canonical PC database, migrations,
domain behavior, jobs, synchronization, import/export, and HTTP contract.
Electron embeds those modules in production and owns only configuration,
Windows adapters, resources, health, UI lifecycle, scheduling policy, and
shutdown. Standalone development and tests use the same backend modules.

## Development prerequisites

- Windows 10 or 11 for protected storage and desktop validation
- Node.js 24.18.0 LTS
- npm 11.6.2

The selected Node version applies to development, CI, standalone execution,
and tests. Packaged Electron uses Electron's embedded Node runtime (Electron
43.2.0), so `better-sqlite3` is rebuilt and smoke-tested against Electron
separately.

Install the pinned workspace:

```powershell
npm ci
```

Run the complete Stage 2 gate:

```powershell
npm run verify:stage2
```

Run the complete Stage 3 gate:

```powershell
npm run verify:stage3
```

Run the automated Stage 4 Chrome checks:

```powershell
npm run test:extension
npm run validate:extension
```

Run the Android, dashboard, and desktop implementation gates:

```powershell
npm run test:mobile
npm run validate:mobile
npm run mobile:typecheck
npm run test:android-release
npm run validate:android-release
npm run test:dashboard
npm run validate:dashboard
node --test desktop/*.test.js
npm run test:desktop-package
npm run validate:desktop-package
```

Build the explicitly unsigned Windows test artifacts:

```powershell
npm run package:windows
```

The commands above do not revoke an external provider credential, sign an
installer, or prove clean-machine/physical-device acceptance. Do not describe
a local build as release-ready unless every automated, manual, and external
release row has its own retained evidence.

## Install and first launch

The current Windows build produces these local test artifacts under `dist\`:

```text
Easy-Rewind-UNSIGNED-Setup-2.0.0-x64.exe
Easy-Rewind-UNSIGNED-Portable-2.0.0-x64.exe
```

They are deliberately marked `UNSIGNED`. For local testing, choose the
per-user installer or portable executable, verify its locally generated
SHA-256 manifest, then start Easy Rewind. Do not distribute either artifact as
a production release until Authenticode verification and the clean-Windows
acceptance matrix pass.

At first launch Electron starts the embedded backend, waits for ready health,
and then creates the tray application. Open **Open Dashboard** from the tray;
double-click the tray icon or use `Ctrl+Shift+Space` / `Alt+Shift+E` for Quick
Search & Capture. The app keeps running in the tray when windows close. Use
**Quit Easy Rewind** so the backend, schedulers, listener, and SQLite close in
order before copying runtime data.

First launch never silently imports a legacy database. If a verified legacy
quarantine exists, the application may report that migration is available.
Keep the only quarantine unchanged, create and verify a second recovery copy,
run the dry-run, review row counts/transforms/skips/conflicts/rollback, and
confirm the exact plan fingerprint before import.

### Dashboard authorization

The dashboard is served by the local backend at `/dashboard`; it does not use a
cloud service. Enter the local installation authorization only into the
session form. It stays in `sessionStorage`, is sent only as a loopback bearer
credential, and disappears when that browser session ends. It is never a
profile ID and must not be placed in URLs, bookmarks, logs, or persistent
browser storage.

### Chrome extension onboarding

1. Run `npm run validate:extension`.
2. In Chrome, open `chrome://extensions`, enable Developer mode, and load the
   validated `extension\` directory for local acceptance.
3. Authenticate through the popup using only a local installation
   authorization. The extension keeps it in session storage, never normal
   extension-local storage.
4. Review privacy settings before enabling capture. Capture is off by default,
   excludes sensitive contexts, never records typed text, and disposes its
   listeners when disabled.

If authorization, cursor, or package state becomes inconsistent, disable
capture, revoke the extension credential, clear extension-only state, load a
known-good validated package, and reauthenticate. Do not reset the PC database.

### Android local-first onboarding

The Expo 57 Android client keeps its own SQLite database and protected pairing
credential. Core capture, edit, delete, search, reminder, flashcard, conflict,
and queued-outbox behavior is designed to remain local when the PC or network
is unavailable.

Pairing is local-network only: scan a short-lived QR challenge, compare/pin the
PC TLS identity, name the device, and explicitly accept it on the PC before a
device credential is issued. There is no cloud relay. Synchronization runs on
open, after local changes, on manual request, and as Android permits
best-effort background work. Only acknowledged outbox operations are removed;
both variants of a conflict remain visible until the user resolves them.

The current retained evidence covers source, SQLite/domain, pairing-protocol,
sync-replay, background-task, UI-binding, type, Expo export, and validated EAS
preview-APK/production-AAB configuration. No APK/AAB or installed
development/release build and no physical-device pairing run has been
retained. Treat signing, QR/TLS pairing, background scheduling, reminders,
offline convergence, and revocation as release blockers until tested on a
physical device.

## Shared-backend architecture

The core application, database, migration, scheduler, and HTTP modules under
`backend/src/` do not import Electron. They are composed only when a host
explicitly starts them.

The same modules support three execution modes:

| Mode                              | Lifecycle owner | Listener and scheduler behavior                                        |
| --------------------------------- | --------------- | ---------------------------------------------------------------------- |
| Electron-embedded production mode | Electron        | Electron injects configuration and Windows adapters, starts, and stops |
| Standalone CLI development mode   | Node CLI        | Loopback listener and scheduler are enabled unless explicitly disabled |
| Injected test mode                | Test harness    | Temporary database is required; listeners and schedulers are disabled  |

Electron owns application startup, shutdown, health integration, storage-path
selection, and scheduling policy. It does not own backend domain logic. Tests
inject temporary paths, clocks, identifiers, adapters, and disabled components
without starting Electron.

### Standalone startup and shutdown

Start the standalone backend from the repository root:

```powershell
npm start
```

The application API binds to `127.0.0.1:3210` by default. Supported standalone
configuration variables are:

```text
EASY_REWIND_STORAGE_ROOT=<exact absolute path>
EASY_REWIND_PORT=<1-65535>
EASY_REWIND_SCHEDULERS_ENABLED=false
```

On Windows the default storage root is
`%LOCALAPPDATA%\easy-rewind\runtime`. An override must remain an exact,
protected local path accepted by the configuration and permission adapters.

Press `Ctrl+C` or send `SIGINT`/`SIGTERM` for graceful shutdown. The lifecycle
stops accepting requests, drains bounded active work, stops schedulers and an
optional LAN gateway, closes listeners, and closes SQLite. Repeated shutdown
requests are safe. Startup failure rolls back already-started components in
reverse order and reports a sanitized error.

### Electron startup and shutdown

```powershell
npm run desktop:dev
```

Electron embeds the same composition root, uses
`%LOCALAPPDATA%\easy-rewind\runtime`, and must inject protected Windows
secret-storage and file-permission adapters. Backend startup fails closed when
those adapters are unavailable. Electron stops the backend before the app
quits.

Native compatibility is checked independently:

```powershell
npm run verify:native
```

That gate requires the pinned Electron binary, rebuilds the staged native
module, and runs an isolated SQLite migration/read/write/checkpoint/close smoke
test inside Electron.

### Test execution

```powershell
npm --workspace backend test
npm run test:contracts
npm run test:migrations
npm run test:lifecycle
```

Test mode requires a unique directory under the operating-system temporary
directory. It rejects repository-contained storage, listeners, schedulers, and
LAN sync. Importing backend modules must not open a database, create a timer, or
start a listener.

## Runtime storage

Paths are derived beneath the selected storage root:

```text
runtime\
├── database\easy-rewind.sqlite3
├── settings\settings.json
├── runtime\state.json
├── secrets\
├── logs\
├── exports\
├── backups\
└── migration-work\
```

The database's matching `-wal` and `-shm` files are live database state, not
disposable cache files. Runtime databases, sidecars, secrets, settings, logs,
exports, backups, and migration work must remain outside Git, builds, tests,
release artifacts, and ordinary logs.

The legacy quarantine is separate:

```text
%LOCALAPPDATA%\easy-rewind\legacy-backup\<timestamp>\
```

It is the preserved recovery source and must never be used as the live runtime
directory.

## Local authentication

The loopback application API does not accept `x-user-id` or an owner supplied
by the request. Authentication establishes the owner context:

- An install credential is a 256-bit bearer secret accepted only over the
  loopback application API.
- A browser exchanges that credential at `POST /v1/session` for a short-lived,
  HttpOnly, SameSite=Strict session. Mutations require the matching
  `X-CSRF-Token` and loopback Origin.
- Mobile/device pairing uses a short-lived, one-use challenge. The PC must give
  explicit confirmation before a device bearer credential is issued.
- Revoked devices and credentials are rejected.

Recoverable secrets are protected by the host adapter. Only versioned keyed
digests are stored in SQLite.

## API contract and compatibility boundary

Versioned Stage 2 endpoints use `/v1`. Current clients may use registered
`/api` compatibility aliases while they are repaired in later stages. Unknown
API versions fail explicitly.

All failures use the stable envelope:

```json
{
  "error": {
    "code": "stable_machine_code",
    "message": "Safe human-readable message",
    "requestId": "opaque-id",
    "details": {}
  }
}
```

Pagination responses use `items`, `nextCursor`, and `hasMore`; cursors are
opaque. Health responses expose readiness, version, schema version, API
version, mode, and `legacyMigrationAvailable` without paths, keys, hostnames,
or row contents. The frozen schemas live in `packages/contracts/schema/` and
the matching API description is `docs/api/openapi.json`.

## Legacy inspection and migration

Easy Rewind never silently imports a legacy database. Startup may only expose
`legacyMigrationAvailable`. Inspection and migration require an existing
timestamped quarantine manifest whose database, matching WAL/SHM files, and
settings checksums verify.

All CLI paths below must be exact absolute paths. Write reports and working
directories outside the repository.

### 1. Read-only inspection

```powershell
node scripts/legacy/inspect-legacy.mjs `
  --manifest C:\absolute\legacy-backup\<timestamp>\manifest.json `
  --output C:\absolute\private-reports\legacy-inspection.json
```

Inspection opens only a new disposable copy. Its output is marked
`SENSITIVE MIGRATION METADATA` and contains schema signatures, safe row
counts, conflicts, unsupported values, and estimated actions—not row content
or credential-like values.

### 2. Dry-run plan

```powershell
node scripts/legacy/migrate-legacy.mjs plan `
  --manifest C:\absolute\legacy-backup\<timestamp>\manifest.json `
  --destination C:\absolute\runtime\database\easy-rewind.sqlite3 `
  --work-root C:\absolute\private-work `
  --recovery-root C:\absolute\private-recovery `
  --rollback-root C:\absolute\private-rollback `
  --output C:\absolute\private-reports\migration-plan.json `
  --available-disk-bytes 10737418240
```

Planning verifies the quarantine, creates a second dated recovery copy, works
from a disposable copy, and reports counts, skips, transforms, conflicts,
warnings, required disk, and rollback path. Review the report before
confirming.

### 3. Explicit migration

Use only the exact fingerprint printed by the reviewed plan:

```powershell
node scripts/legacy/migrate-legacy.mjs run `
  --plan C:\absolute\private-reports\migration-plan.json `
  --confirm <64-character-plan-fingerprint> `
  --destination C:\absolute\runtime\database\easy-rewind.sqlite3 `
  --work-root C:\absolute\private-work
```

Migration is transactional, verifies post-import invariants, records the source
fingerprint, and retains rollback metadata. Repeating the same source is
rejected rather than silently reimported.

### 4. Rollback

Stop the backend, retain the failed runtime database as a private diagnostic
artifact, and restore only from verified rollback metadata:

```powershell
node scripts/legacy/migrate-legacy.mjs rollback `
  --metadata C:\absolute\private-rollback\rollback-metadata.json `
  --destination C:\absolute\runtime\database\easy-rewind.sqlite3
```

Restart first with listeners and schedulers disabled, verify integrity and
schema state, then re-enable loopback operation. Never modify, checkpoint,
delete, or test against the sole preserved quarantine copy.

## Stage 2 / Stage 3 boundary

Stage 2 owns the canonical schema, migrations, backend lifecycle, local
authentication, API and sync contracts, legacy inspection/migration safety,
and Electron native-module verification.

Stage 3 owns truthful domain behavior for items, bookmarks, notes, highlights,
tags, research, reminders, AI jobs, synchronization convergence, and
import/export. Stage 2 compatibility routes may return `not_implemented` until
their injected Stage 3 service exists. Client repair must consume the frozen
contract rather than inventing new owner, pagination, error, or cursor shapes.

## Chrome extension

The Manifest V3 extension uses the frozen loopback contract through one bounded
service-worker API client. Popup and content-script code exchange exact
validated messages and do not store or transmit provider credentials.

Capture is disabled by default. The content script waits for one complete
privacy snapshot before attaching listeners, excludes sensitive contexts,
never captures typed text, and removes its listeners and timers immediately
when capture is disabled. Popup content is rendered with text-only DOM APIs and
protocol-checked links.

The packaged manifest retains only `activeTab`, `alarms`, `contextMenus`,
`notifications`, and `storage`, plus loopback-only host access. Extension
recovery clears extension local/session state and revokes its install
credential; it never deletes the canonical PC database.

Chrome focused, session-authorization, and disposable-package checks are
recorded in the Stage 4 evidence. Stage 4 is not complete until its Git-aware
hygiene gate and separate Android work are complete.

## Conflicts, revocation, and recovery

- **Offline or unavailable PC:** keep editing locally. Do not clear the mobile
  outbox or advance its opaque cursor. Retry when the paired PC is reachable.
- **Conflict:** keep both variants, choose or merge explicitly, and let that
  resolution synchronize as a new operation. Client clocks never decide
  ownership.
- **Lost or replaced phone:** revoke its device credential on the PC. A
  revoked device cannot push, pull, acknowledge, request a snapshot, or
  reconnect; a replacement must complete pairing again.
- **PC runtime recovery:** quit the app, copy the database together with its
  current WAL/SHM files before opening it, restrict and checksum the backup,
  restore to a new protected runtime path, and start with listeners and
  schedulers disabled.
- **Mobile recovery:** stop sync/background work, preserve the local database,
  WAL/SHM, outbox, conflicts, tombstones, and cursor, then re-pair or resume
  from the last acknowledged cursor. Clearing app data can destroy the only
  unsynchronized copy.
- **Legacy migration recovery:** use verified rollback metadata and a
  destination backup. Never open, checkpoint, modify, or test against the sole
  quarantine copy.

Detailed procedures are retained in
`docs/release/evidence/stage-4/android-recovery.md`,
`docs/release/evidence/stage-6/recovery.md`, and
`docs/release/evidence/stage-7/recovery.md`.

## Windows packaging and signing

`npm run package:windows` validates the package boundary, rebuilds the native
module against Electron 43.2.0, and builds per-user NSIS and portable x64
artifacts. The package includes only the desktop host, backend, dashboard, and
contracts. Runtime databases/sidecars, settings, credentials, `.env` files,
logs, exports, migration work, quarantine data, tests, maps, and private keys
are excluded.

For an authorized release:

1. Build from the exact clean, reviewed revision using the pinned toolchain.
2. Inspect the unpacked application and both unsigned artifacts; run secret,
   hygiene, native ABI, package, and malware checks.
3. Build/sign through the protected release job. The builder's guard filename
   still contains `UNSIGNED` while the signature is being evaluated, so it
   cannot be uploaded accidentally.
4. Sign the installer and portable executable with the authorized Authenticode
   certificate, SHA-256 file digest, SHA-256 timestamp digest, and the
   organization's approved RFC 3161 timestamp service. Never pass a
   certificate password on a shared command line or store a PFX in the
   repository.
5. Verify each builder output before copying its unchanged signed bytes to the
   final `SIGNED` release filename:

   ```powershell
   signtool verify /pa /all /v <final-artifact.exe>
   ```

6. Generate SHA-256 checksums from those final signed copies, retain
   signature/timestamp evidence, install and uninstall both artifacts as a
   standard user, and publish only when every release blocker is closed.

Renaming or checksumming is not signing. A successful local build is not
evidence that an artifact is trusted by Windows.

## Repository layout

```text
backend/             Electron-independent backend and canonical migrations
desktop/             Electron lifecycle/configuration and Windows UI
extension/           Chrome Manifest V3 client
frontend/            Dashboard client
mobile/              Expo 57 Android local-first client
packages/contracts/  Runtime-independent API and sync contracts
scripts/             Containment, hygiene, migration, build, and verification tools
docs/api/            Frozen OpenAPI document
docs/release/        Requirements and evidence records
database/setup.sql   Legacy reference only; never used at runtime
```

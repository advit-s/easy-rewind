# Easy Rewind

Easy Rewind is a local-first knowledge assistant for Chrome and Windows. The
Stage 2 foundation provides one canonical SQLite database, a shared backend
lifecycle, local authentication, frozen API contracts, and an explicit
backup-first legacy migration boundary.

Domain behavior for items, research, reminders, AI, synchronization, and
import/export is completed in Stage 3. Until a Stage 3 service is connected,
the compatibility route stays present and returns the stable
`not_implemented` error instead of pretending work succeeded.

## Development prerequisites

- Windows 10 or 11 for protected storage and desktop validation
- Node.js 24.18.0
- npm 11.6.2

The selected Node version applies to development, CI, standalone execution,
and tests. Packaged Electron uses Electron 43.2.0's embedded Node runtime, so
`better-sqlite3` is rebuilt and smoke-tested against Electron separately.

Install the pinned workspace:

```powershell
npm ci
```

Run the complete Stage 2 gate:

```powershell
npm run verify:stage2
```

This command includes requirements, backend, contract, migration, lifecycle,
Electron native-module, production audit, secret, and repository-hygiene
checks. It does not revoke an external provider credential. Do not describe a
clean-install or release result as passing unless that command was run from the
intended clean checkout and its exact result was recorded.

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

## Repository layout

```text
backend/             Electron-independent backend and canonical migrations
desktop/             Electron lifecycle/configuration and Windows UI
extension/           Chrome Manifest V3 client
frontend/            Dashboard client
packages/contracts/  Runtime-independent API and sync contracts
scripts/             Containment, hygiene, migration, build, and verification tools
docs/api/            Frozen OpenAPI document
docs/release/        Requirements and evidence records
database/setup.sql   Legacy reference only; never used at runtime
```

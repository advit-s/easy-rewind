# Easy Rewind Stage 2 Backend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the canonical database, migrations, backend lifecycle,
local authentication, frozen client contract, and safe legacy-migration
boundary on which Stages 3–7 can reliably build.

**Architecture:** A composition root constructs the database, repositories,
services, HTTP application, schedulers, and optional listeners from injected
configuration. Importing a module performs no I/O. Electron and the standalone
CLI call the same lifecycle API; tests inject temporary paths, clocks, ID
generators, disabled schedulers, and disabled listeners. SQLite migrations are
ordered, checksummed, and transactional. Loopback API credentials and LAN
pairing credentials are distinct.

**Tech Stack:** Node.js 24.18.0, npm workspaces, JavaScript modules,
`better-sqlite3`, Node `crypto`, Node `http`, Express, JSON Schema, Node's
built-in test runner, Electron 43, `@electron/rebuild`.

**Depends on:**
`docs/superpowers/specs/2026-07-25-easy-rewind-complete-release-and-android-sync-design.md`

---

## Task 1: Freeze the Stage 2 baseline and evidence records

**Files:**

- Create: `docs/release/requirements/stages-2-7.csv`
- Create: `docs/release/evidence/stage-2/README.md`
- Create: `docs/release/evidence/stage-2/commands.md`
- Modify: `package.json`

- [ ] Add requirement rows for execution modes, schema, auth, errors,
      pagination, cursors, reminders, health, migration, backup, rollback,
      native ABI, and quarantine exclusions. Give every row a stable ID,
      source, verification command, evidence path, status, and blocker.
- [ ] Add a failing `node:test` check that rejects missing Stage 2 requirement
      IDs or evidence paths.
- [ ] Add `test:requirements` and include it in `verify`.
- [ ] Run `npm run test:requirements` and confirm the missing records make it
      fail before adding them.
- [ ] Add the records and rerun until it passes.
- [ ] Record the current Node/npm/Electron/SQLite versions, `npm audit`
      findings, native-rebuild failure, open-handle warning, and external
      credential-revocation blocker in Stage 2 evidence.
- [ ] Commit only the new evidence/matrix/script changes:

```powershell
git add package.json docs/release scripts
git commit -m "test: establish stage 2 evidence gate"
```

## Task 2: Replace Jest with isolated Node tests

**Files:**

- Create: `backend/test/support/test-environment.js`
- Create: `backend/test/support/test-server.js`
- Create: `backend/test/import-safety.test.js`
- Modify: `backend/package.json`
- Modify: `package.json`
- Delete after parity: `backend/jest.config.js`
- Migrate: `backend/tests/**/*.test.js` to `backend/test/**/*.test.js`

- [ ] Write an import-safety test that snapshots active handles, imports each
      backend module, waits one event-loop turn, and asserts that no database,
      timer, or listener was created.
- [ ] Run `npm --workspace backend test -- import-safety.test.js`; confirm the
      existing `server.js` import starts a listener/timers and fails.
- [ ] Add `createTestEnvironment()` that creates a unique directory under the
      operating-system temporary directory and returns paths, fixed clock,
      deterministic ID generator, scheduler-disabled configuration, and
      cleanup.
- [ ] Add `startTestServer(runtime)` that binds only to an ephemeral loopback
      port when a test explicitly requests a listener.
- [ ] Port tests to `node:test`, `node:assert/strict`, and native mocks.
- [ ] Remove `--forceExit`; fail tests when handles remain.
- [ ] Remove Jest and Jest-only transitive packages from manifests and lockfile.
- [ ] Run:

```powershell
npm install
npm --workspace backend test
npm audit --omit=dev
```

- [ ] Confirm each test has a different database path and parallel runs cannot
      access `backend/data/`.
- [ ] Commit:

```powershell
git add package.json package-lock.json backend
git commit -m "test: isolate backend with node test runner"
```

## Task 3: Add explicit configuration and storage paths

**Files:**

- Create: `backend/src/config/config-schema.js`
- Create: `backend/src/config/create-config.js`
- Create: `backend/src/config/create-config.test.js`
- Create: `backend/src/platform/secret-store.js`
- Create: `backend/src/platform/file-permissions.js`
- Create: `backend/src/platform/node-file-permissions.js`

- [ ] Write failing tests for production, standalone, and test configurations.
      Cover missing storage root, relative paths, externally bound loopback API,
      enabled test scheduler, and a LAN gateway without TLS/pairing material.
- [ ] Implement `createConfig(input)` as a pure validator/normalizer. It must
      return immutable absolute paths for database, logs, exports, backups, and
      runtime state.
- [ ] Define interfaces for protected secret storage and restrictive file
      permissions without importing Electron.
- [ ] Make test mode require an injected temporary root and default listeners
      and schedulers to disabled.
- [ ] Make production/standalone loopback default to `127.0.0.1`; reject
      `0.0.0.0` for the application API.
- [ ] Add a separate optional LAN sync configuration with explicit enablement,
      port, TLS identity, allowed subnet policy, and pairing policy.
- [ ] Run:

```powershell
node --test backend/src/config/create-config.test.js
```

- [ ] Commit:

```powershell
git add backend/src/config backend/src/platform
git commit -m "feat: define backend execution configuration"
```

## Task 4: Create the canonical SQLite migration engine

**Files:**

- Create: `backend/src/database/open-database.js`
- Create: `backend/src/database/migration-runner.js`
- Create: `backend/src/database/migration-runner.test.js`
- Create: `backend/src/database/migrations/001_core.sql`
- Create: `backend/src/database/migrations/002_auth_and_devices.sql`
- Create: `backend/src/database/migrations/003_jobs_and_sync.sql`
- Create: `backend/src/database/schema-contract.test.js`
- Archive as reference only: `database/setup.sql`

- [ ] Write failing tests for a new database, repeated migration, interrupted
      migration, checksum mismatch, future schema version, foreign-key
      enforcement, WAL mode, and busy timeout.
- [ ] Implement `openDatabase({ path, readonly, filePermissions })`; do not
      create directories or open the file at module import.
- [ ] Implement ordered migrations with a `schema_migrations` table containing
      version, name, SHA-256 checksum, and applied time.
- [ ] Execute each migration in an immediate transaction and reject modified
      applied migration files.
- [ ] Create canonical tables for profiles, items, bookmarks, notes,
      highlights, tags, item_tags, connections, reminders,
      reminder_deliveries, flashcards, quiz_results, research_jobs, digests,
      jobs, settings, diagnostics, client_credentials, browser_sessions,
      sync_devices, sync_operations, sync_changes, sync_cursors,
      sync_conflicts, and migration_runs.
- [ ] Use text UUIDs for externally synchronized records, UTC millisecond
      timestamps, non-null owner IDs, revision numbers, and nullable
      `deleted_at` tombstones.
- [ ] Add foreign keys, uniqueness constraints, covering indexes, FTS tables,
      and triggers required by search and change capture.
- [ ] Assert the exact tables, columns, indexes, foreign keys, and allowed
      reminder/device/job states in `schema-contract.test.js`.
- [ ] Run:

```powershell
node --test backend/src/database/*.test.js
```

- [ ] Commit:

```powershell
git add backend/src/database database/setup.sql
git commit -m "feat: add canonical transactional database schema"
```

## Task 5: Freeze the API and sync contracts

**Files:**

- Create: `packages/contracts/package.json`
- Create: `packages/contracts/src/index.js`
- Create: `packages/contracts/src/errors.js`
- Create: `packages/contracts/src/pagination.js`
- Create: `packages/contracts/src/reminders.js`
- Create: `packages/contracts/src/health.js`
- Create: `packages/contracts/src/pairing.js`
- Create: `packages/contracts/src/sync.js`
- Create: `packages/contracts/schema/*.json`
- Create: `packages/contracts/test/contracts.test.js`
- Create: `docs/api/openapi.json`
- Modify: `package.json`

- [ ] Add `packages/contracts` to workspaces and make it free of backend,
      Electron, DOM, and React dependencies.
- [ ] Write failing round-trip tests for every request/response fixture and
      tests that reject unknown fields, negative limits, non-opaque cursors,
      invalid reminder transitions, malformed operations, and unstable errors.
- [ ] Define the common error shape:

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

- [ ] Define pagination as `items`, `nextCursor`, and `hasMore`; cursors are
      opaque strings and never client-generated offsets.
- [ ] Define health as `status`, `version`, `schemaVersion`, `apiVersion`,
      `mode`, and component readiness without paths, keys, hostnames, or row
      contents.
- [ ] Define reminder states and transitions explicitly:
      `scheduled`, `snoozed`, `due`, `completed`, `cancelled`, and `failed`.
- [ ] Define pairing challenge, confirmation, credential issue, revocation,
      sync push, sync pull, conflict, and cursor-expired envelopes.
- [ ] Generate or validate `docs/api/openapi.json` from the same schemas and
      store a SHA-256 checksum in Stage 2 evidence.
- [ ] Run:

```powershell
npm --workspace @easy-rewind/contracts test
npm run test:contracts
```

- [ ] Commit:

```powershell
git add package.json package-lock.json packages/contracts docs/api docs/release/evidence/stage-2
git commit -m "feat: freeze local API and sync contracts"
```

## Task 6: Build local authentication and authorization primitives

**Files:**

- Create: `backend/src/auth/install-token-service.js`
- Create: `backend/src/auth/browser-session-service.js`
- Create: `backend/src/auth/pairing-service.js`
- Create: `backend/src/auth/auth-middleware.js`
- Create: `backend/src/auth/auth.test.js`
- Create: `backend/src/http/request-context.js`

- [ ] Write failing tests for missing/invalid bearer tokens, expired browser
      sessions, token rotation, wrong owner, replayed pairing challenges,
      unconfirmed devices, revoked devices, and constant-time token checks.
- [ ] Generate 256-bit random install and device credentials. Store only a
      versioned keyed digest in SQLite; put recoverable local secrets through
      the injected protected secret-store adapter.
- [ ] Accept the install bearer credential only on the loopback application
      API.
- [ ] Exchange it for a short-lived, HttpOnly, SameSite=Strict browser session
      tied to loopback origin and protected by CSRF validation on mutations.
- [ ] Require explicit PC confirmation before issuing a device credential.
- [ ] Store pairing challenges with one-use, short expiry and transactional
      consumption.
- [ ] Add owner/profile context after successful authentication and prohibit
      request-provided owner overrides.
- [ ] Run:

```powershell
node --test backend/src/auth/auth.test.js
```

- [ ] Commit:

```powershell
git add backend/src/auth backend/src/http/request-context.js
git commit -m "feat: secure local clients and device pairing"
```

## Task 7: Extract HTTP composition and lifecycle

**Files:**

- Create: `backend/src/http/create-app.js`
- Create: `backend/src/http/error-handler.js`
- Create: `backend/src/http/health-routes.js`
- Create: `backend/src/lifecycle/create-runtime.js`
- Create: `backend/src/lifecycle/create-runtime.test.js`
- Create: `backend/src/lifecycle/start-standalone.js`
- Create: `backend/src/scheduler/scheduler-controller.js`
- Modify: `backend/server.js`
- Modify: `start-backend.bat`

- [ ] Write failing tests that import all modules without I/O and exercise
      start/stop/start, concurrent stop calls, partial-start rollback, database
      failure, address conflict, scheduler-disabled mode, and listener-disabled
      mode.
- [ ] Implement `createApp(dependencies)` without calling `listen`.
- [ ] Implement `createRuntime(config, adapters)` with:

```js
const runtime = await createRuntime(config, adapters);
await runtime.start();
const health = await runtime.health();
await runtime.stop();
```

- [ ] Make `stop()` idempotently stop request acceptance, drain bounded active
      work, stop schedulers, stop optional LAN gateway, close HTTP listeners,
      and close databases in that order.
- [ ] Roll back already-started components in reverse order when start fails.
- [ ] Start schedulers only through `scheduler-controller.js`; inject clocks
      and timer factories.
- [ ] Make `backend/server.js` a thin standalone executable that handles
      SIGINT/SIGTERM and reports sanitized startup failure.
- [ ] Keep every module under `backend/src/` free of Electron imports.
- [ ] Run:

```powershell
node --test backend/src/lifecycle/create-runtime.test.js backend/test/import-safety.test.js
npm --workspace backend test
```

- [ ] Commit:

```powershell
git add backend/src backend/server.js start-backend.bat
git commit -m "refactor: add explicit backend lifecycle"
```

## Task 8: Add safe read-only legacy inspection

**Files:**

- Create: `backend/src/legacy/discover-legacy.js`
- Create: `backend/src/legacy/inspect-legacy.js`
- Create: `backend/src/legacy/legacy-report.js`
- Create: `backend/src/legacy/inspect-legacy.test.js`
- Create: `scripts/legacy/inspect-legacy.mjs`
- Modify: `.gitignore`
- Modify: `.prettierignore`
- Modify: `.secretlintignore`
- Modify: `scripts/hygiene/check-repository-hygiene.mjs`

- [ ] Write tests proving inspection opens only a disposable copy in read-only
      mode, never checkpoints/deletes a WAL, never writes a database journal,
      never prints row contents, and redacts paths/credential-like values.
- [ ] Detect the configured legacy paths without silently importing them.
- [ ] Require an already-created quarantine manifest and checksum verification
      before offering any inspection.
- [ ] Copy the database plus matching `-wal` and `-shm` to a new temporary
      inspection directory; never inspect the sole quarantine files directly.
- [ ] Report schema signature, table names, safe row counts, conflicts likely
      under the canonical model, unsupported values, and estimated actions.
- [ ] Mark output `SENSITIVE MIGRATION METADATA` and write it only to an
      explicitly selected local path outside release evidence.
- [ ] Extend hygiene checks so
      `%LOCALAPPDATA%\easy-rewind\legacy-backup\`, SQLite sidecars, manifests,
      copied settings, inspection reports, and temp migrations cannot enter
      Git/build/export/test/log paths.
- [ ] Run:

```powershell
node --test backend/src/legacy/inspect-legacy.test.js
npm run hygiene
npm run scan:secrets
```

- [ ] Commit:

```powershell
git add backend/src/legacy scripts/legacy scripts/hygiene .gitignore .prettierignore .secretlintignore
git commit -m "feat: inspect legacy backups without mutation"
```

## Task 9: Add explicit backup-first migration and rollback

**Files:**

- Create: `backend/src/legacy/plan-migration.js`
- Create: `backend/src/legacy/run-migration.js`
- Create: `backend/src/legacy/rollback-migration.js`
- Create: `backend/src/legacy/migration.test.js`
- Create: `backend/test/fixtures/legacy/schema-v1.sql`
- Create: `backend/test/fixtures/legacy/schema-v2.sql`
- Create: `scripts/legacy/migrate-legacy.mjs`

- [ ] Build synthetic fixtures from historical schema definitions only; never
      commit the quarantined database or its derived rows.
- [ ] Write failing tests for dry-run counts, duplicate IDs, normalized URL
      conflicts, invalid timestamps, orphaned rows, unknown columns,
      interrupted migration, repeated migration, rollback, and insufficient
      disk space.
- [ ] Require this sequence: verify quarantine manifest and hashes, create a
      second dated recovery copy, inspect a temporary working copy, present
      dry-run, receive explicit confirmation, migrate transactionally, verify
      counts/invariants, then retain rollback metadata.
- [ ] Never auto-run migration during startup. Startup may only return the
      `legacyMigrationAvailable` health/status flag.
- [ ] Write a migration plan containing row counts, skips, transforms,
      conflicts, warnings, required disk, and rollback path without row
      content.
- [ ] Import through canonical repositories in a transaction and record a
      source fingerprint so the same snapshot cannot be silently reimported.
- [ ] On failure, close databases and restore the pre-migration runtime copy;
      never modify the quarantine source.
- [ ] Run:

```powershell
node --test backend/src/legacy/migration.test.js
```

- [ ] Commit:

```powershell
git add backend/src/legacy backend/test/fixtures/legacy scripts/legacy
git commit -m "feat: add explicit reversible legacy migration"
```

## Task 10: Repair and verify Electron native staging

**Files:**

- Modify: `scripts/build/rebuild-electron-native.mjs`
- Create: `scripts/build/verify-electron-native.mjs`
- Create: `scripts/build/rebuild-electron-native.test.mjs`
- Modify: `package.json`
- Modify: `desktop/package.json`

- [ ] Write a failing staging-layout test that asserts the `--module-dir`
      passed to `@electron/rebuild` contains both `package.json` and
      `node_modules/better-sqlite3`.
- [ ] Fix the current mismatch where `package.json` is written to the staging
      root but `stagingRoot/node_modules` is passed as the module directory.
- [ ] Add an explicit Electron binary installation/verification step for the
      pinned Electron version; fail if `dist/electron.exe` and runtime version
      checks are absent.
- [ ] Rebuild `better-sqlite3` for Electron 43 and execute a smoke script inside
      Electron that opens an isolated temporary database, migrates it, writes,
      reads, checkpoints, and closes it.
- [ ] Keep the staging directory outside source and inspect its manifest for
      database files, sidecars, credentials, quarantine paths, and unexpected
      production dependencies.
- [ ] Run:

```powershell
npm run rebuild:native
npm run verify:native
```

- [ ] Commit:

```powershell
git add scripts/build package.json package-lock.json desktop/package.json
git commit -m "fix: verify Electron SQLite native staging"
```

## Task 11: Integrate compatibility routes and Stage 2 gates

**Files:**

- Modify: `backend/src/routes/*.js`
- Create: `backend/src/http/compatibility-routes.test.js`
- Create: `backend/src/http/contract-routes.test.js`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `docs/release/evidence/stage-2/README.md`
- Modify: `docs/release/evidence/stage-2/commands.md`

- [ ] Add failing contract tests for all existing client-used endpoints,
      authentication, common errors, pagination, ownership, request size,
      content type, health, and unsupported API version.
- [ ] Adapt existing routes to injected repositories/services. Do not redesign
      domain behavior assigned to Stage 3; return explicit `not_implemented`
      for behavior that cannot be made truthful yet.
- [ ] Remove hard-coded `system` profiles, request-provided `x-user-id`, broad
      extension CORS, and credentials accepted in request bodies/settings.
- [ ] Add request IDs, body limits, safe cache headers, strict loopback origin
      policy, and the common error handler.
- [ ] Add scripts:

```json
{
  "test:contracts": "npm --workspace @easy-rewind/contracts test && node --test backend/src/http/contract-routes.test.js",
  "test:migrations": "node --test backend/src/database/*.test.js backend/src/legacy/*.test.js",
  "test:lifecycle": "node --test backend/src/lifecycle/*.test.js backend/test/import-safety.test.js",
  "verify:stage2": "npm run test:requirements && npm --workspace backend test && npm run test:contracts && npm run test:migrations && npm run test:lifecycle && npm run verify:native && npm run audit:production && npm run scan:secrets"
}
```

- [ ] Update operator/developer docs for execution modes, storage paths,
      startup/shutdown, local auth, contract versioning, inspection, migration,
      rollback, and the Stage 2/Stage 3 boundary.
- [ ] Run the full Stage 2 gate from a clean dependency install:

```powershell
npm ci
npm run verify:stage2
```

- [ ] Record exact output, commit, API/schema checksums, audit disposition,
      native ABI result, and rollback rehearsal in Stage 2 evidence.
- [ ] Confirm there are no unresolved release blockers before marking Stage 2
      complete.
- [ ] Commit:

```powershell
git add backend packages/contracts package.json package-lock.json README.md SECURITY.md docs
git commit -m "docs: close stage 2 backend foundation gate"
```

---

## Stage 2 recovery procedure

If a Stage 2 migration or startup fails:

1. Stop the standalone process or Electron host through the idempotent runtime
   shutdown path.
2. Preserve the failing runtime database and sidecars as diagnostic artifacts
   outside Git and logs.
3. Verify the pre-migration runtime backup checksums.
4. Restore that runtime backup to a new path; do not overwrite or open the sole
   quarantine copy.
5. Start with schedulers and listeners disabled, run integrity/schema checks,
   then enable loopback only.
6. Record the failure and restored database fingerprint in sensitive local
   operator records, not release evidence.
7. Do not proceed to Stage 3 until the failure has a regression test and the
   recovery rehearsal passes.

## Stage 2 completion checklist

- [ ] All Task 1–11 commits are present and scoped.
- [ ] `npm ci` and `npm run verify:stage2` pass from a clean checkout.
- [ ] Import-safety reports zero backend-created handles.
- [ ] Temporary-database isolation and parallel test execution pass.
- [ ] Contract and schema checksums are frozen in evidence.
- [ ] Native SQLite loads and operates inside pinned Electron.
- [ ] Legacy inspection/dry-run/rollback pass using synthetic fixtures and a
      disposable backup copy workflow.
- [ ] Gemini credential revocation remains explicitly blocked or externally
      attested; no code or backup is represented as revocation.
- [ ] Stage 2 traceability records link each requirement to passing evidence.
- [ ] Stage 3 detailed planning may begin only after this checklist is fully
      satisfied.

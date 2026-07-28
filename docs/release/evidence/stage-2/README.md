# Stage 2 baseline evidence

This directory freezes the backend-foundation baseline before Stage 2
implementation changes. It does not claim that the Stage 2 exit gate has
passed.

## Safe evidence boundary

These records intentionally omit credentials, credential-shaped values,
database contents, quarantine contents, raw file hashes, personal absolute
paths, hostnames, and device identifiers. The sole quarantine copy must never
be opened or modified; later inspection and migration work must use a verified
disposable copy.

## Toolchain snapshot

| Component      | Baseline version | Evidence                                      |
| -------------- | ---------------- | --------------------------------------------- |
| Node.js        | `24.18.0`        | Pinned runtime used for the baseline run      |
| npm            | `11.6.2`         | Root `packageManager` and pinned runtime      |
| Electron       | `43.2.0`         | Exact desktop development dependency          |
| better-sqlite3 | `13.0.1`         | Exact backend dependency                      |
| bundled SQLite | `3.53.3`         | In-memory `sqlite_version()` query under Node |

The in-memory version query created no repository database and read no
quarantine material.

## Clean inherited test baseline

On 2026-07-25, `npm test` under Node `24.18.0` exited successfully:

| Suite                | Passed | Failed |
| -------------------- | -----: | -----: |
| Workspace validation |     41 |      0 |
| Containment          |     21 |      0 |
| Repository hygiene   |     63 |      0 |
| Legacy backend       |     57 |      0 |

The legacy Jest run still emitted an open-handle diagnostic naming
`TCPSERVERWRAP` and `Timeout`. That warning is reproduced baseline lifecycle
debt; it is not treated as a clean shutdown result.

## Dependency audit finding

The dependency installation used to prepare this Stage 2 worktree reported
`32` high-severity vulnerabilities. This Task 1 evidence freeze did not
remediate or reclassify them. A fresh production audit and documented
disposition remain required before the Stage 2 exit gate can pass. An older
Stage 1 audit result does not override this current installation finding.

## Task 2 isolated backend tests

On 2026-07-25, the backend test runner was migrated from Jest to the built-in
Node.js test runner. The `57` inherited behavior tests (`56` API tests and one
Nodemailer compatibility test) pass with a unique repository-external
database and settings path for every API test. On 2026-07-27, the import probe
was strengthened with thirteen regression fixtures. The complete backend
command passes `85/85`, including import-safety, database-path,
temporary-environment, and loopback ephemeral-server coverage.

Importing `server.js` and all eight production route modules now creates no
listener, scheduler, database, settings file, filesystem write, environment
mutation, exported runtime-config mutation, or residual handle/resource. The
probe covers synchronous, callback, promise, open-for-write, and write-stream
filesystem APIs, then settles the event loop and compares exact baseline
handle identities and all resource types without an allowlist. Reports retain
only sanitized operation, key, module, export, and path-category labels.
Subprocess creation, Worker construction, global and module timer functions,
promise timers, and promise scheduler methods are denied before import; the
subprocess coverage includes exported helpers, `_forkChild`, and direct
CommonJS/ESM `ChildProcess.prototype.spawn` calls. Subprocess commands,
arguments, options, paths, and environments are never reported.
Process-event listener identities are also snapshotted before import; imported
listeners are reported with a fixed label and removed directly without
invocation while filesystem, subprocess, and timer guards remain active.
Server startup, schedulers, settings loading, and database opening remain
explicit actions. The previous Jest `TCPSERVERWRAP` and `Timeout` diagnostic
is therefore resolved for this test scope; this does not claim that the
broader Task 7 lifecycle architecture is complete.

Runtime reset now closes the current database, restores every configuration
field from immutable defaults, clears the cached AI client, and loads only the
selected settings environment. Isolated API tests reset before use and after
cleanup, including an explicitly blank AI credential. Failed listener startup
closes app-local rate-limit timers and the database. App composition and
scheduler startup also transfer timer cleanup ownership incrementally, so a
second allocation failure clears the first created timer before rethrow.
Runtime close is idempotent and still closes app/database resources if server
close reports an error.

The recorded RED evidence is sanitized: production imports originally created
a listener and scheduler resources, attempted settings output, and read
`.env`; the database helper ignored the injected external path; and the
required isolation helpers were absent. The strengthened fixture suite also
first demonstrated that environment/config mutation, asynchronous filesystem
writes, streams, a non-timeout resource, subprocess/Worker creation, and timer
module scheduling escaped the old probe. Separate RED checks reproduced
settings/AI state crossing sequential environments and resource retention
after failed listen/close operations. Additional RED checks showed that direct
CommonJS/ESM `ChildProcess` construction returned a clean probe result while
fixture-owned external sentinels changed, and that second rate-limit and
scheduler allocation failures each left one created timer uncleared. No raw
An additional RED fixture returned a clean report before an imported exit
listener wrote an external sentinel during process termination. No raw
environment values, subprocess commands, arguments, options, personal paths,
listener event names, contents, or hashes are retained.

A pinned Node `24.18.0` lockfile-clean install added `525` packages and audited
`528`. The installed dependency tree is empty for Jest, its package directory
is absent, and no Jest or `@jest` package entry remains in the lockfile.

Removing Jest and its lockfile-only transitive packages reduced the fresh full
audit from the recorded baseline of `32` high-severity findings to `16` high
findings. A fresh production-only audit reports `0` vulnerabilities. The
remaining full-audit findings are development-only transitive dependencies in
the Electron packaging chain, primarily `electron-builder`; they are not
claimed fixed by Task 2.

## Task 3 explicit configuration and protected storage

On 2026-07-28, Task 3 added one Electron-independent configuration contract
for `production`, `standalone`, and `test` execution. The validator requires
an absolute storage root, derives absolute database, settings, runtime-state,
log, export, backup, and migration-work paths, and returns a deeply frozen
configuration without creating directories. Test mode requires an explicitly
injected repository-external operating-system temporary root and rejects
enabled schedulers or listeners.

The application API accepts only the bindable loopback literals `127.0.0.1`
and `::1`. Production requires a nonzero port. Standalone port zero requires
an explicit development flag, while test mode uses a disabled port-zero
listener by default. Optional LAN sync remains disabled unless a valid
nonzero port, distinct TLS identity reference, explicit-confirmation pairing
policy, and private-LAN subnet policy are all provided.

Storage overrides must stay lexically beneath the storage root. Existing path
components are checked without creating directories, and linked or
reparse-point ancestry is rejected. The Windows test creates a real junction,
proves the validator rejects it without a skip, and verifies that the external
target remains untouched.

Protected-secret and restrictive-file-permission interfaces normalize and
validate their inputs, preserve secret values without logging them, and
sanitize adapter failures. The Node file-permission adapter accepts injected
filesystem and locked-target security adapters. Every operation requires an
exact trusted root, rejects linked or reparse-point ancestry, and verifies
that the locked object identity matches the inspected target. POSIX changes
use no-follow file handles, apply `fchmod`, verify `0700` for directories or
`0600` for files with `fstat`, and close the handle on every path. A target
swap regression proves an external file retains mode `0666` and its sentinel
content. The Windows adapter requires a validated SID and a handle-bound
structured ACL adapter. It applies and reads back one protected DACL whose
only ACE grants full control to that SID, with inheritance flags only for
directories; unexpected owners, inherited ACEs, deny ACEs, extra principals,
ambiguous readback, or identity changes fail closed. A command-only Windows
fallback now returns `FILE_PERMISSION_LOCK_UNAVAILABLE` without mutation. No
module under `backend/src` imports Electron.

The sanitized RED runs failed only because the configuration and platform
modules did not yet exist (`0/56` configuration assertions and `0/14`
top-level platform assertions). The manifest-contract RED run passed `5/6`
and failed on the missing root backend-suite script. A later focused RED
regression proved a dangling junction bypassed the initial existence check
(`0/1`); the link inspection now uses `lstat` first and sanitizes inspection
failures. Follow-up RED runs demonstrated that command exit status alone
accepted eight unsafe or ambiguous ACL readbacks (`0/10`), linked ancestry and
path swaps reached mutation (`0/3`), and trusted-root, dangling-link, and
injected-reparse constraints were absent (`0/4`). After implementation, the
focused configuration run passes `57/57`, the focused platform run passes
`48/48` including nested cases, the manifest contract passes `6/6`, and the
complete backend suite passes `190/190` with zero skips.

Node does not expose a native Windows API for applying and reading an ACL
through the same locked file handle. Task 3 therefore defines and verifies
the required `windowsSecurity.withLockedTarget` boundary and refuses to claim
race-safe success from `icacls` alone. Implementing that native helper and
validating its ACL/owner readback on packaged Windows artifacts remains an
explicit Stage 6 platform-integration requirement; Task 3 fixture coverage is
required and has no skip.

Task 3 changed no dependency versions. The last verified Task 2 production
audit remains `0` vulnerabilities, while the last verified Task 2 full
development audit remains `16` high and `0` critical in the Electron
packaging chain. The execution environment declined to send dependency
metadata to the npm registry, so Task 3 does not claim a fresh audit or that
the development-only findings are remediated.

## Native ABI finding

The staging-layout implementation now passes its focused `13/13` tests. The
staging root is the rebuild module directory, contains the generated manifest
and staged dependency, preserves the shared Node binding, checks the exact
Electron version, and inspects the staging tree for forbidden artifacts.

The final `npm run verify:native` run also passed against Electron `43.2.0`.
The Electron-hosted process loaded the staged native module, opened an external
temporary database, migrated it, wrote and read a safe fixture, checkpointed
the WAL, closed the database, and removed the temporary staging tree.

## Task 4 canonical SQLite boundary

Task 4 adds an import-inert database opener and a canonical migration runner
without changing the legacy route helper. The opener accepts only an exact
absolute path whose regular parent already exists, rejects linked ancestry and
targets, configures foreign keys and a bounded busy timeout, uses WAL for
writable databases, uses query-only mode for readonly databases, invokes the
restrictive permission adapter, and makes close idempotent. It never logs a
path or row value.

Three exact-byte SHA-256 migrations define the canonical schema. The runner
accepts only contiguous `NNN_name.sql` files beginning at version one,
requires unique stable versions and names, verifies all applied checksums
before pending work, rejects newer database versions, and applies each pending
migration in an immediate transaction. Concurrent writers either serialize or
receive a stable busy error after the configured timeout, with in-transaction
history revalidation preventing stale application decisions.

The canonical schema contains all required owner-scoped content, reminder,
learning, authentication, job, and sync tables. Externally synchronized domain
rows use text identifiers, integer-millisecond timestamps, revisions, and
tombstones. Foreign keys, state checks, live-row uniqueness, owner-scoped
covering indexes, operation deduplication, and FTS5 item-search triggers are
verified through behavior. Deleted items are absent from search and restored
items are indexed again.

The Task 4 quality pass added composite `(profile_id, id)` parent keys and
composite child references for every owner-scoped relationship. Cross-profile
references now fail even when both profile rows and the referenced parent
exist. Nullable sync references retain their direct `SET NULL` action plus a
composite ownership guard, and deletion tests verify that only the optional
reference is cleared while its owner remains intact. The exact index contract
now freezes every `index_xinfo` key term, collation, direction, auxiliary term,
normalized creation SQL, and partial predicate, with behavior tests covering
live-row rejection and replacement after tombstoning or resolution.

Migration SQL is scanned before any database transaction or schema-history
creation. The SQL-aware scanner ignores strings, comments, quoted identifiers,
and trigger bodies, while rejecting statement-leading transaction-control,
attachment, and detachment statements with one stable safe error. The database
opener restricts the already-validated parent directory before native SQLite
can create the main file or sidecars, then restricts the main file and any
existing WAL/SHM files after configuration. A failed native close remains
retryable and is marked complete only after native close succeeds.

The initial focused RED run failed `0/21` because the opener and migration
runner did not exist. Additional focused RED checks captured future-version
classification, connection-endpoint uniqueness, and lazy native-dependency
loading defects before their fixes. A bounded follow-up RED failed `0/1`
because the exact expectation maps were intentionally empty while all `26`
relational tables were required. The populated contract now freezes every
ordered column, named and automatic index, indexed-column order, uniqueness,
partial-index flag, foreign-key action, migration-metadata primary key, FTS
public column, and FTS shadow table. The PRAGMA audit found no schema mismatch,
so the initial implementation did not change its migration bytes. The later
quality pass intentionally updated the unreleased canonical migration bytes to
add composite ownership constraints and parent keys. Its RED failed `24/26`
focused checks as expected; after implementation, the stable root migration
command passes `88/88` and the complete backend suite passes `278/278`, with
zero skips. Evidence contains no database paths, row content, or raw checksums.

`database/setup.sql` is retained only as a legacy PostgreSQL/Supabase
reference. Canonical runtime migrations never read it, and this task does not
inspect, open, migrate, or quarantine any legacy database.

## Task 5 frozen local API and sync contracts

Task 5 adds the environment-neutral `@easy-rewind/contracts` workspace. Its
public modules import only local modules and Ajv's portable ECMAScript build;
they import no backend, Electron, DOM, React, React Native, or Node-only
runtime API. Canonical JSON Schema 2020-12 files are compiled with Ajv `8.20.0`
in strict mode. Contract objects reject unknown properties, and validators
return deterministic `validation_failed` records containing only a stable
code and safe message, never submitted values or validation paths.

The frozen error response contains exactly `error.code`, `error.message`,
`error.requestId`, and an empty `error.details` object. The stable vocabulary
covers authentication, authorization, validation, conflict, throttling,
versioning, cursor expiry, device revocation, internal failures, and
unimplemented behavior. Pagination is cursor-only, caps pages at `100`, and
requires `nextCursor` to agree with `hasMore`. Health responses expose only
stable versions, mode, component readiness, and optional legacy-migration
availability.

Reminder states are exactly `scheduled`, `snoozed`, `due`, `completed`,
`cancelled`, and `failed`. Completed, cancelled, and failed reminders are
terminal. Pairing contracts separate short-lived one-use challenges, explicit
PC confirmation, credential issue, and revocation. The opaque device
credential is marked `writeOnly` only in the credential-issue response.
Challenge responses also carry a closed QR payload bound to the outer
challenge and expiry. It requires protocol version `1`, an opaque PC
installation identity, a lowercase SHA-256 TLS fingerprint, and an
explicit-port HTTPS sync endpoint restricted to RFC 1918 IPv4, IPv6 unique
local addresses, or `.local` hostnames. Credentials, queries, fragments,
public and link-local addresses, and insecure schemes are rejected. Endpoint
values remain confined to pairing responses and are not retained in health,
logs, or release evidence.

Sync requests use UUID-shaped opaque identifiers, integer UTC milliseconds,
server revisions, stable entity/operation/result/conflict vocabularies,
bounded batches of `100`, opaque cursors, explicit tombstones, and a common
`cursor_expired` error. Each operation includes protocol version `1`, a
positive schema version, and a positive safe-integer per-device sequence.
Every pushed operation must match its enclosing device, operation IDs must be
unique, and device sequences must be strictly increasing in request order.
Accepted and duplicate results require only an authoritative revision;
conflicts require a revision and conflict ID; rejected results require only a
stable error code. Pull pages reject duplicate change IDs while leaving cursor
ordering opaque to clients.

Payloads are JSON objects capped at `64` direct properties, exactly `32,768`
serialized UTF-16 code units, and depth `8`. Size is measured by a
deterministic hook-free traversal of own data properties that accounts for
JSON punctuation and string escaping without invoking inherited `toJSON`
hooks or getters. Prototype-pollution keys, cycles, accessors, unsafe proxies,
non-plain objects, non-JSON values, oversized exact serialization, and
payload-bearing deletes are rejected safely.

The Task 5 contract exposed an unreleased Task 4 mismatch: the database
reminder CHECK omitted `due` and `failed`. A cross-contract RED failed when it
inserted all six exported states. The unreleased `001_core.sql` CHECK was
aligned to the exact six-state vocabulary, the test then passed, and the
separate reminder-delivery vocabulary was not changed.

`docs/api/openapi.json` is a deterministic OpenAPI `3.1.0` projection of the
same canonical definitions. It covers relative health, session, pairing, and
sync paths, omits a `servers` declaration, resolves every schema reference,
and fails contract tests on byte drift. The public contract fingerprints use
sorted schema filenames plus exact bytes for the bundle:

- Schema bundle SHA-256:
  `9c5292808862a88cb1035f6431456e5776442de0086e321769e1b892a815d145`
- OpenAPI SHA-256:
  `c58423ce97f8f2960ccc11e7d2fd828b3360a114ca01861a4c7fce17fbceb450`

No listener, file write, HTTP implementation, authentication implementation,
client change, legacy data access, or raw database hash is part of the
contract package. No external audit was requested or run for Task 5; the last
verified Task 2 audit counts remain unchanged.

## Task 6 local authentication

The Electron-independent backend now implements loopback installation
credentials, protected browser sessions, immutable authenticated request
context, and confirmed Android device pairing. SQLite contains only versioned
keyed digests; the recoverable installation token crosses the injected
protected secret-store boundary, while device credentials are returned once
and are not treated as recoverable local secrets.

The canonical unreleased authentication migration now includes exact
loopback-origin and CSRF binding, profile/device credential ownership, and
one-use pairing-challenge state. Focused authentication tests passed `7/7`,
the combined exact-schema and authentication run passed `45/45`, and the
complete backend suite passed `286/286`, all with zero skips. Pairing service
responses also pass the frozen Task 5 challenge and credential validators.
Task 6 did not start a listener, access legacy data, or run an external audit.

## Task 7 shared backend lifecycle

The Electron-independent shared runtime now supports injected production,
standalone, and test composition. It owns canonical database migration,
listener creation, scheduler and LAN-gateway controllers, bounded request
draining, reverse-order startup rollback, idempotent concurrent shutdown, and
restart after a completed stop. Test mode runs the identical modules with its
listener and scheduler disabled.

The new `/v1/health` route produces the frozen safe response and covers ready,
disabled, degraded, and unavailable component states plus schema version and
legacy-migration availability. Focused lifecycle and import-safety coverage
passed `10/10`; new and compatibility lifecycle tests passed `14/14`; and the
complete backend suite passed `295/295`, all with zero skips. The root
standalone entry point is thin and signal-aware; its legacy route adapter
remains lazy and isolated until Task 11 replaces compatibility routes.

The final pinned-runtime root verification passed with workspace `41/41`,
containment `21/21`, hygiene `63/63`, backend `278/278`, safe legacy runner
`57/57`, requirements `18/18`, and contracts `23/23`. Every suite reported
zero failures and zero skips. Secretlint, the direct hygiene checker, all
workspace lint, repository format checking, extension validation, and the
build syntax checks also passed.

## External release blocker

Gemini provider revocation remains externally unconfirmed. Repository cleanup,
secret scanning, history rewriting, and the preserved quarantine are not
credential revocation. Release remains blocked until provider-side revocation
is confirmed through an authorized external record.

The quarantine is sensitive recovery material, not secure credential storage.
No key value, partial key, replacement key, provider response, or credential
fingerprint belongs in this evidence directory.

## Requirement status vocabulary

- `not-started`: implementation work has not begun.
- `failing`: a reproducible check currently fails.
- `implemented`: implementation exists but required verification is incomplete.
- `verified`: the required executable or authorized manual evidence passes.
- `blocked`: an identified external dependency or authority remains unresolved.

## Stage 2 exit-gate working record

The frozen public contract remains byte-stable:

- Schema bundle SHA-256:
  `9c5292808862a88cb1035f6431456e5776442de0086e321769e1b892a815d145`
- OpenAPI SHA-256:
  `c58423ce97f8f2960ccc11e7d2fd828b3360a114ca01861a4c7fce17fbceb450`

The deterministic generator `--check` and `--hash` commands both passed under
the pinned Node `24.18.0` runtime. The compatibility and frozen-contract HTTP
route run passed `17/17`; the integrated backend suite passed `340/340`; the
migration/schema/legacy gate passed `109/109`; and the lifecycle/import-safety
gate passed `16/16`, all with zero skips. The real Electron native smoke,
Windows DPAPI/ACL smoke, secret scan, Git-aware hygiene, lint, formatting, and
offline production audit also passed.

Evidence structure:

- [commands.md](commands.md) records safe command classifications and counts.
- [traceability.md](traceability.md) links every S2 requirement to evidence.
- [recovery.md](recovery.md) defines backup-first migration and rollback.
- [command-evidence.schema.json](command-evidence.schema.json) defines the
  redacted machine-readable command-evidence envelope.

The schema forbids arbitrary extra fields and raw output retention. Command
evidence must omit personal paths, credentials, database rows, hostnames,
device identifiers, private URLs, and quarantine hashes.

## Current exit decision

**FAIL / BLOCKED.** Local implementation, migration/rollback, composition,
native ABI, Windows protection, hygiene, audit, and recovery checks pass. The
online clean-install aggregate remains blocked because sending dependency and
lockfile metadata to the npm registry was not separately authorized. The
verified Stage 2 implementation checkpoint is `6f7140e`. Gemini provider
revocation remains separately `blocked` and will continue to block release
until externally confirmed.

# Easy Rewind Release Hardening Design

Date: 2026-07-24
Status: Approved architecture; governing design for staged implementation
Scope: Existing Easy Rewind repository and all requested release surfaces

## 1. Purpose

This design turns the existing Easy Rewind project into one installable, locally
hosted Windows product while preserving its intended feature set:

- Chrome Manifest V3 extension
- Node.js/Express local backend
- SQLite storage
- browser dashboard
- Electron Windows tray application
- optional Gemini integration
- bookmarks, notes, highlights, research, reminders, memory search,
  connections, flashcards, quizzes, digests, import, and export

The work repairs and consolidates the current implementation. It does not replace
the product with a reduced demonstration and does not claim Android support.

## 2. Governing decisions

### 2.1 Embedded shared-backend architecture

The backend is a reusable, Electron-independent library. Its application,
configuration, database, migration, scheduler, service, logging, and HTTP
modules must not import Electron APIs.

Electron is an outer lifecycle adapter. It supplies paths, protected
credentials, runtime settings, logging destinations, clock and notification
adapters, starts the shared backend, observes readiness, and closes it during
shutdown. Electron owns product-process lifecycle; it does not own business
logic.

The same backend modules support three execution modes:

1. **Electron-embedded production mode**: Electron creates the backend runtime,
   starts a loopback HTTP listener after successful migration and integrity
   checks, starts schedulers once, and closes schedulers, HTTP, and SQLite in
   order.
2. **Standalone CLI development mode**: a small executable entry point builds
   the same configuration and starts the same runtime without importing
   Electron.
3. **Test mode**: tests inject unique temporary database and data paths, do not
   open a listener unless the test explicitly requests one, use injected clocks
   and service doubles, and leave schedulers disabled by default.

Module import must never open the production database, bind a port, start an
interval, write settings, or contact an external service.

### 2.2 Runtime separation

Development, CI, and standalone execution use the selected Node.js LTS version.
Packaged desktop execution uses Electron's embedded Node runtime. These are
separate compatibility targets.

The canonical dependency graph has one source lockfile. Native dependencies,
especially `better-sqlite3`, are rebuilt for the pinned Electron version during
desktop packaging and verified in the packaged application. The build must
unpack native binaries from ASAR when required. Binaries copied from another
machine, operating system, Node ABI, or Electron ABI are not accepted as build
inputs.

### 2.3 One product version and workspace

The repository has a root npm workspace and a single authoritative product
version. Root scripts orchestrate clean installation, lint, format checking,
unit tests, integration tests, migration tests, extension checks, dashboard
checks, desktop tests, packaging, verification, artifact creation, and secret
scanning. Maintained package manifests may expose the product version but may
not diverge from it.

### 2.4 API contract freeze

Client repairs begin only after stage 2 freezes and tests the local API contract:

- authentication and pairing
- profile identity and authorization
- request validation
- success and error envelopes
- stable error codes and HTTP statuses
- pagination semantics
- opaque synchronization cursors
- idempotency rules
- reminder state transitions
- timestamps
- health and readiness responses
- import/export schema versions

The extension, dashboard, and Electron adapters consume this contract. They do
not compensate for conflicting database schemas or invent client-specific API
semantics.

## 3. Runtime topology

```text
Chrome extension ───────────────┐
                                │ authenticated loopback HTTP
Dashboard served by backend ────┼────> Express API
                                │          │
Electron lifecycle adapter ─────┘          ├── domain services
       │                                   ├── schedulers
       ├── configuration adapters          ├── AI provider boundary
       ├── protected token storage         ├── remote-fetch boundary
       ├── Windows notifications           └── SQLite repositories
       └── startup/shutdown                       │
                                                  └── versioned migrations

Standalone CLI ── configuration/lifecycle adapter ──> same backend modules
Tests ─────────── injected config/temp DB/fakes ─────> same backend modules
```

Only one backend runtime may own a given runtime database at a time. Electron
uses a single-instance lock before starting it. A standalone process fails
clearly if it cannot acquire the database/runtime ownership lock.

## 4. Configuration and storage

Runtime data lives outside the source and installation directories under
Windows local application data. Source, build inputs, packages, logs, tests,
exports, and release archives must not contain real credentials, legacy
settings, personal SQLite data, WAL/SHM files, or quarantine files.

Configuration is constructed explicitly and injected. Precedence and allowed
sources are documented per execution mode. Sensitive values are held only in
the backend runtime and protected platform storage or a user-protected file.
They are redacted from structured logs, API responses, diagnostics, exports,
dashboard markup, and test fixtures.

The local API binds to `127.0.0.1` by default. A cryptographically random
per-install API token is required for every non-public endpoint. The token is
never accepted in a URL. Pairing is an explicit, time-limited, user-mediated
flow. Origins and renderer callers are restricted to the known local
application surfaces.

## 5. Canonical data design

SQLite has one canonical, versioned schema. Migrations run serially in
transactions where SQLite permits, record their version, fail visibly, and are
tested both from an empty database and every supported prior version.

Core rules:

- foreign keys are enabled and verified on every connection
- ISO-8601 UTC is the only stored timestamp convention
- input timestamps with explicit offsets are normalized correctly
- ownership is present and enforced on every user-scoped entity
- constraints express real uniqueness and relationship rules
- indexes correspond to measured application queries
- dependent tags, embeddings, connections, quiz records, and related rows use
  deliberate cascade or restrict behavior
- integrity checks precede readiness and follow risky maintenance operations
- schema errors are never silently swallowed
- backup and restore behavior is tested before destructive migration

Repository methods, not route handlers, own SQL. Domain services own
transactions and state transitions. HTTP handlers validate and translate
requests and responses without embedding schema repair logic.

## 6. Legacy containment and migration boundary

### 6.1 Stage 1 quarantine

Stage 1 performs containment only. Before any process opens or modifies the
legacy database:

1. Resolve and stop all Easy Rewind Electron and backend processes without
   terminating unrelated Node or Electron processes.
2. Identify the exact legacy database and its matching `-wal` and `-shm`
   companions, plus the legacy settings file.
3. Copy the set together to:
   `%LOCALAPPDATA%\easy-rewind\legacy-backup\<timestamp>\`.
4. Disable inherited access and grant the current Windows user exclusive access
   to the quarantine directory and its files; verify the resulting owner and
   ACL.
5. Generate SHA-256 checksums.
6. Write a manifest containing backup time, original absolute path, quarantined
   relative path, byte size, checksum, and sensitivity warning.
7. Verify every copied byte size and checksum against its source.
8. Mark the location as sensitive in documentation and program exclusions.
9. Purge the database, WAL, SHM, and legacy settings from the working tree only
   after successful verification.
10. Add empty runtime-directory placeholders only where a source directory is
    structurally required.

The quarantine location is excluded from Git, builds, releases, exports, logs,
diagnostics, test discovery, fixtures, and ordinary application scans. It is a
recovery copy of sensitive data, not secure credential storage. The exposed
Gemini key must be revoked and replaced independently.

Stage 1 may add read-only inventory and verification tooling. It may not attach
the database to the repaired application, checkpoint the WAL, run schema
conversion, import rows, or mutate the preserved copy.

Git-history purging is a separate, explicit repository operation after the clean
working state and instructions are verified. It must remove the exposed
credential and personal data from all affected refs and explain the
force-push/re-clone coordination required. Key revocation is required even
after history rewriting.

### 6.2 Stage 2 migration

Stage 2 implements legacy migration. The only preserved quarantine copy is
never used as a migration working database.

The application detects a legacy backup and offers an explicit user choice. It
does not import silently. The migration flow:

1. verifies quarantine manifest and checksums
2. makes a new working copy, including the coherent SQLite/WAL/SHM set
3. opens only the working copy with SQLite-aware inspection
4. produces a dry-run report with detected schema, source table counts,
   convertible row counts, skipped rows, conflicts, invalid values, ownership
   decisions, and expected destination changes
5. asks for explicit confirmation
6. creates and verifies a destination backup
7. imports through canonical domain services in a transaction or documented
   resumable batches
8. validates row counts, referential integrity, and invariants
9. commits only after validation
10. restores or rolls back automatically on failure

The report and logs contain identifiers and aggregate counts only where
possible; they do not dump note text, browsing content, credentials, or other
sensitive values. A migration can be safely retried without duplicating
records.

## 7. Backend boundaries

The backend is divided into:

- configuration and dependency construction
- database connection, migrations, repositories, backup, and integrity checks
- domain services for all product features
- authentication, pairing, and authorization
- Express application and transport validation
- scheduler engine with persisted job state and injected clock
- Windows notification adapter supplied by Electron
- optional AI provider adapter
- safe remote-document fetcher
- structured logging and diagnostics
- explicit lifecycle controller

Health is split into liveness and readiness. Readiness remains false until
configuration validation, database connection, migrations, integrity checks,
and scheduler construction succeed. AI being disabled is a truthful capability
state, not an unhealthy backend. Production errors use a stable sanitized
format and do not expose stack traces.

Remote fetching permits only validated HTTP(S) destinations, blocks local and
special-use networks after DNS resolution, validates every redirect, enforces
timeouts and byte limits while streaming, accepts expected content types, uses
a maintained HTML parser, and returns controlled error codes.

The AI boundary validates provider/model combinations, supports key rotation
and clearing, does not echo keys, has deterministic mocks, handles timeouts,
cancellation, quota and malformed output, schema-validates structured results,
limits prompts, and delimits all captured content as untrusted. Disabled or
failed AI never returns fabricated success.

## 8. Client design

### 8.1 Chrome extension

The MV3 service worker is the durable coordination point for authenticated API
requests, pairing, sync cursors, notifications, context menus, and state
recovery. Content scripts have the smallest practical scope and are driven by a
fully resolved settings snapshot before listeners start.

Auto-capture and engagement tracking are opt-in, never record typed text, stop
listeners and timers immediately when disabled, react to settings changes
without reload, and honor allowlists, blocklists, sensitive-page exclusions,
time thresholds, and deduplication. Network calls have timeouts, normalized
errors, bounded retries, and offline states. Sync uses opaque server cursors
rather than client wall-clock time.

### 8.2 Dashboard

The dashboard uses maintainable modules and derives its API origin from the
serving origin unless a validated development override is supplied. It uses the
same authenticated profile and contract as other clients.

Untrusted content is rendered through DOM construction and `textContent`; URLs
are protocol-validated. Inline handlers and unsafe CSP allowances are removed.
Every view has accessible loading, empty, partial, offline, error, and retry
states. Keyboard navigation, focus, contrast, reduced motion, semantic
structure, and narrow-window behavior are part of acceptance testing.

### 8.3 Electron

Electron registers IPC once, exposes a narrow validated preload API, restricts
API paths and methods, validates external URLs, denies unexpected navigation,
popups, permissions, and webviews, and retains context isolation with Node
integration disabled.

It acquires a single-instance lock, prepares protected storage, starts the
backend once, waits for readiness before reporting success, provides the Windows
notification adapter, manages the tray and overlay, and performs ordered
shutdown. Recreating the overlay never re-registers IPC. Uninstall preserves
user data unless the user explicitly requests deletion.

## 9. Seven implementation stages

### Stage 1: Credential containment and workspace normalization

Maps primarily to requested phases 0 and 1.

Deliver:

- verified quarantine and working-tree purge
- nested repository and generated dependency cleanup
- comprehensive ignore and release-exclusion rules
- placeholder-only environment example
- secret scanning
- root workspace, lockfile, pinned toolchain, canonical version, and scripts
- clean-install evidence
- separate Git-history purge procedure
- key-revocation requirement

No legacy schema conversion or import occurs.

### Stage 2: Canonical database, migrations, backend lifecycle, and local authentication

Maps primarily to requested phases 2, 3, and 4.

Deliver:

- canonical SQLite schema and migrations
- repositories and transaction boundaries
- empty, upgrade, downgrade-recovery, integrity, backup, and restore tests
- explicit backend construction and shutdown
- CLI, Electron-embedded, and injected test modes
- stable local API authentication and pairing
- profile scoping
- frozen API, health, pagination, cursor, and reminder-state contracts
- explicit backup-first legacy migration with dry run and rollback

### Stage 3: Domain correctness

Maps primarily to requested phases 5, 6, and 7.

Deliver all supported behaviors for:

- safe remote URL fetching
- AI configuration and provider behavior
- bookmarks, notes, highlights, research, items, memory, connections
- flashcards and quizzes
- reminders and delivery state
- digests and scheduling
- versioned, validated, bounded import and export
- merge, cache, idempotency, pagination, sync, and concurrency semantics

### Stage 4: Chrome extension repair and privacy controls

Maps to requested phase 8.

Deliver:

- minimized and documented permissions
- explicit privacy controls and sensitive-site behavior
- deterministic settings initialization and live updates
- threshold-correct engagement behavior
- authenticated API client, offline handling, and secure host flow
- reliable notification action mapping
- durable cursor sync and service-worker recovery
- idempotent context menus and working omnibox
- maintainable popup modules and automated tests

### Stage 5: Dashboard refactor and security

Maps to requested phase 10.

Deliver:

- modular dashboard client
- authenticated same-origin API behavior
- safe rendering and strict CSP
- complete working controls for all requested views
- profile isolation
- responsive, accessible states
- stored-XSS and hostile-URL tests

### Stage 6: Electron lifecycle, native modules, packaging, and Windows validation

Maps to requested phase 9.

Deliver:

- lifecycle adapter for the Electron-independent backend
- single-instance behavior and ordered shutdown
- secure IPC/preload/navigation
- protected local settings and token handling
- reliable tray, overlay, shortcut, dashboard, and reminder behavior
- complete icon/build assets
- pinned Electron native-module rebuild
- NSIS installer and portable artifact when verified
- installed and packaged Windows smoke evidence

### Stage 7: CI, release artifacts, documentation, and full acceptance testing

Maps to requested phases 11, 12, and 13 and the release acceptance suite.

Deliver:

- isolated, reliable tests without force-exit or open handles
- CI jobs for hygiene, secrets, backend, migrations, extension, dashboard,
  Electron, Windows packaging, smoke tests, and artifacts
- development, migration, security, privacy, troubleshooting, install,
  uninstall, and release documentation
- clean source archive
- installer and any supported portable build
- SHA-256 artifact checksums and release manifest
- real Chrome evidence
- clean Windows packaged-application evidence
- complete requirement-to-evidence matrix
- verification report, changed-file rationale, commands and outputs
- honest remaining-limitations report

## 10. Stage exit gate

Every stage is independently gated. The following must all be true before work
begins on the next stage:

1. The stage's automated tests pass on the supported development runtime.
2. Relevant integration, security, migration, browser, or Windows manual checks
   have recorded evidence.
3. Lint, format, secret, repository-hygiene, and packaging checks relevant to
   the changed surface pass.
4. No unresolved release blocker remains in the completed scope.
5. A tested rollback, restore, or recovery procedure exists.
6. The requirement-to-evidence matrix is updated with commands, output/artifact
   references, and status.
7. Known limitations are recorded and do not contradict a release claim.
8. A clean rerun confirms that the preceding stage remains green.

Failure of an exit gate stops progression. It does not authorize skipping,
weakening, or marking the requirement complete.

## 11. Verification strategy

Implementation follows test-driven repair where practical:

1. capture the defect or contract as a failing test
2. confirm the failure represents the intended behavior
3. make the smallest coherent subsystem change
4. rerun the focused test
5. run the subsystem suite
6. run all earlier stage gates
7. record evidence

Test databases are unique temporary databases created by migrations. Tests
cannot resolve the production or quarantine paths. Schedulers use injected
clocks and notification fakes. Network and AI providers are mocked at service
boundaries. Security suites cover authorization leakage, SSRF variants, stored
XSS, secret redaction, malicious imports, pairing failures, unsafe IPC and URL
inputs, and package-content leakage.

The final acceptance suite covers clean backend installation and restart,
unpacked Chrome usage, all dashboard views, Electron development lifecycle, and
an installed Windows build including native SQLite loading, persistence,
reminders, single-instance behavior, icons, shutdown, uninstall behavior, and
absence of development secrets or personal data.

## 12. Requirement-to-evidence record

The matrix is a maintained artifact rather than a final retrospective. Every
requirement records:

- stable requirement identifier
- source phase and wording summary
- owning stage
- implementation references
- automated test references
- exact verification command
- evidence artifact or output
- rollback/recovery reference
- status: not started, failing, implemented, verified, or blocked
- limitation or blocker, if any

No requirement is marked verified from code inspection alone when executable or
manual acceptance evidence is required.

## 13. Recovery principles

- Never destroy the only copy of user data.
- Never test migration against the only preserved quarantine copy.
- Verify checksums before purging a source.
- Keep backups outside the repository and release pipeline.
- Prefer transactional changes and reversible moves.
- Close listeners, timers, jobs, and SQLite handles before process exit.
- Preserve installed user data during ordinary upgrades and uninstall unless
  the user makes an explicit deletion choice.
- Do not treat history rewriting as credential revocation.
- Do not claim successful recovery until integrity and domain invariants pass.

## 14. Completion definition

The project is complete only when all seven stage gates and the full release
acceptance suite pass, requested artifacts exist, a clean source archive and
verified Windows package contain no credentials or personal data, and the
requirement-to-evidence matrix accounts for every requirement with evidence or
an honestly stated limitation.

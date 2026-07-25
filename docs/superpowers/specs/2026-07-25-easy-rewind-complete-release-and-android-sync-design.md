# Easy Rewind Complete Release and Android Local-Sync Design

Date: 2026-07-25  
Status: Approved design  
Extends: `docs/superpowers/specs/2026-07-24-easy-rewind-release-hardening-design.md`

## 1. Purpose and scope

This specification governs completion of the existing Easy Rewind product through
the approved seven-stage delivery sequence and adds an Android-first mobile client.
It preserves the existing product rather than replacing it with a demonstration.

The completed product consists of:

- an Electron-managed Windows application;
- an Electron-independent Node.js/Express backend;
- a canonical local SQLite database on the PC;
- a Chrome Manifest V3 extension;
- a browser dashboard;
- an Android application with its own local SQLite database;
- optional, backend-only Gemini functionality; and
- bookmarks, notes, highlights, research, reminders, memory search, connections,
  flashcards, quizzes, digests, import, export, and local-network synchronization.

The Android first release is a focused mobile product. It supports bookmarks,
notes, highlights, memory search, reminders, flashcards, offline capture,
conflict resolution, and synchronization. Advanced research administration,
knowledge-graph visualization, bulk import/export, and administrative settings
remain on the PC.

iOS is outside the first release. The design must not claim iOS support or cloud
synchronization.

## 2. Approved product decisions

The following choices are fixed for this release:

1. Android is implemented first using React Native and TypeScript with native
   SQLite support. iOS may be considered after the Android release.
2. PC and Android both remain useful while offline and both keep local data.
3. Synchronization is fully bidirectional.
4. Synchronization occurs only when the paired PC and Android device are on an
   approved local Wi-Fi network.
5. No cloud relay, hosted account, or internet synchronization service is used.
6. The PC hosts the synchronization gateway and must be running for a sync to
   occur.
7. The first release supports one personal owner profile and multiple revocable
   device identities for that owner.
8. Android sync runs on app open, after important local mutations, periodically
   through Android background work on approved Wi-Fi, and through an explicit
   **Sync now** action.
9. Concurrent edits are preserved and presented as conflicts; they are never
   silently overwritten.
10. The embedded shared-backend architecture and seven-stage release sequence
    remain authoritative.

## 3. System architecture

### 3.1 Shared backend

The backend is a reusable Electron-independent library. Core configuration,
database, migration, repository, domain, scheduler, authentication, pairing,
synchronization, logging, AI, remote-fetch, and HTTP modules must not import
Electron.

Electron is the Windows lifecycle adapter. It supplies protected paths and
credentials, Windows notifications, startup and shutdown control, and packaged
runtime configuration. Standalone development and tests construct the same
backend modules with different injected adapters.

The backend supports:

- Electron-embedded production mode;
- standalone CLI development mode; and
- test mode using unique temporary databases, injected clocks and providers,
  disabled listeners by default, and disabled schedulers by default.

Importing a backend module must not open a database, bind a port, start a timer,
write settings, or contact a remote provider.

### 3.2 Network boundaries

The extension, dashboard, and Electron-facing API remains bound to `127.0.0.1`
by default.

Mobile synchronization is a separate, explicitly enabled TLS gateway bound only
to the selected private network interface. It exposes narrowly scoped pairing,
sync health, pull, push, acknowledgement, conflict, and bounded attachment
operations. It does not expose the dashboard, arbitrary backend routes,
administrative diagnostics, AI credentials, imports, exports, profile merging,
or settings mutation to the LAN.

The gateway rejects public, loopback, link-local, unspecified, multicast, and
unexpected interface bindings. Disabling mobile sync closes the listener and
invalidates unfinished pairing challenges without disabling the loopback API.

### 3.3 Local databases

The PC stores the complete canonical product schema. Android stores the
mobile-supported canonical entities plus device, cursor, outbox, inbox,
conflict, and notification-delivery metadata.

The Android schema is not an independently named version of the domain model.
Shared records use the same entity names, field semantics, timestamp rules,
validation constraints, and synchronization identifiers on both platforms.
PC-only entities are omitted deliberately and are not represented by fake or
partial Android records.

## 4. Canonical data and synchronization model

### 4.1 Record identity and revisions

Every synchronized record has:

- a stable globally unique synchronization ID;
- an owner profile ID;
- a monotonic authoritative revision;
- canonical ISO-8601 UTC creation and update timestamps; and
- a tombstone state for synchronized deletion where applicable.

Supported legacy numeric IDs may be retained internally during migration, but
they are never used as cross-device identity.

### 4.2 Device identity and pairing

Each installation creates a protected device identity. The PC creates an
installation-specific TLS identity. Android pairing uses a short-lived QR code
containing:

- the private-network endpoint;
- a one-time pairing challenge;
- the TLS certificate fingerprint; and
- the expected PC installation identity.

Android validates the private-network endpoint, completes the one-time
challenge, pins the TLS identity, and stores its long-lived device credential
using Android Keystore. Windows stores protected pairing and TLS material using
the platform credential adapter supplied to the Electron-independent backend.

Pairing challenges expire, are single-use, and are rate limited. Long-lived
credentials are device-specific. Revoking one device prevents future pushes,
pulls, and acknowledgements from that device without rotating every other
paired device.

### 4.3 Outgoing operations

Each device records local mutations in an append-only outbox. An operation
contains:

- a globally unique idempotency key;
- device identity and device-local sequence;
- entity type and globally unique entity ID;
- operation type;
- base authoritative revision;
- validated requested changes;
- local creation time for diagnostics only; and
- the canonical schema and protocol versions.

Client clocks never determine synchronization order or cursor progression.

The PC validates an uploaded batch, checks authorization and protocol
compatibility, and applies accepted operations in a database transaction. It
assigns authoritative entity revisions and an opaque monotonic sync cursor.
Retried operations return the original acknowledgement and cannot create
duplicate records or state transitions.

### 4.4 Pulls, cursors, and tombstones

Android pulls bounded pages after its last acknowledged opaque cursor. A
successful page returns records or tombstones, the next cursor, a `hasMore`
indicator, and a server timestamp. Android advances the cursor on a successful
empty page.

Deletions produce tombstones. Tombstones remain until every active paired
device has acknowledged a cursor beyond the deletion or until a documented
retention policy has expired for devices explicitly marked inactive. A device
returning after its retained history has expired must perform a verified
snapshot resynchronization instead of receiving an incomplete delta.

### 4.5 Conflict behavior

An operation based on the current authoritative revision applies
automatically. New records with distinct global IDs do not conflict. Duplicate
operations are acknowledged without being applied again.

If an entity has changed since an operation's base revision, the current and
incoming variants are preserved in a conflict record. Neither variant is
silently discarded. PC and Android both expose the conflict and allow the owner
to choose:

- the current value;
- the incoming value; or
- a manually merged value.

Resolving a conflict creates a new canonical revision and a normal sync-log
entry. A delete conflicting with an edit is also explicit and must not silently
erase the edited value.

### 4.6 Scheduling and failure handling

Android attempts synchronization:

- after the app opens;
- after important local changes, using bounded debounce;
- periodically through Android background work constrained to approved Wi-Fi;
  and
- when the owner selects **Sync now**.

Unavailable PCs, changed networks, TLS mismatches, revoked devices, incompatible
protocols, interrupted batches, and validation failures leave unacknowledged
operations queued. Retries use bounded exponential backoff with jitter.

The UI displays the last successful sync, current state, queued-operation count,
conflict count, and a controlled actionable error. It never reports
**Synchronized** while changes remain unacknowledged.

## 5. Backend, API, and domain design

### 5.1 Explicit lifecycle

Configuration, database creation, migrations, repositories, services, Express
application construction, listeners, schedulers, and shutdown are separate
responsibilities.

The runtime starts in this order:

1. validate configuration and protected paths;
2. acquire runtime ownership;
3. open SQLite with foreign keys enabled;
4. run migrations;
5. run integrity and schema checks;
6. construct services and schedulers;
7. construct HTTP applications;
8. bind requested listeners;
9. start enabled schedulers; and
10. report readiness.

Shutdown stops new work, closes the LAN gateway and loopback listener, drains or
cancels bounded work, stops schedulers, waits for active transactions, requests
a passive WAL checkpoint, closes SQLite, and releases runtime ownership.

### 5.2 Frozen API contract

Before extension, dashboard, Electron renderer, or Android feature work, Stage 2
freezes and tests:

- local authentication and pairing;
- profile identity and authorization;
- success and error envelopes;
- stable error codes and HTTP statuses;
- request validation and size limits;
- pagination;
- opaque synchronization cursors;
- idempotency rules;
- reminder and job states;
- timestamps;
- liveness and readiness responses;
- import/export versions; and
- sync protocol and schema compatibility.

Arbitrary `x-user-id` impersonation is removed. Every protected operation is
scoped to the authenticated owner profile.

### 5.3 Domain responsibilities

The backend provides tested behavior for:

- bookmarks, notes, highlights, items, interactions, and memory scores;
- research jobs and secure remote content acquisition;
- connections, knowledge graph, related items, and search;
- flashcards, spaced review, quizzes, and statistics;
- reminder scheduling and per-device delivery states;
- digest generation and provider-confirmed delivery;
- versioned import/export with transactional validation;
- explicit profile migration and merge;
- optional AI generation and embeddings; and
- synchronization and conflict resolution.

SQLite full-text search remains available without AI or internet access.
Configured AI enrichment is a PC-backend capability. AI-disabled and provider
failure states are truthful and never return fabricated success.

### 5.4 Remote content and AI security

All remote URL access uses one hardened fetch service. It accepts only HTTP(S),
rejects credentials and prohibited address ranges, validates DNS results and
every redirect, limits redirects, time, bytes and content types, parses supported
documents with maintained parsers, and returns controlled errors without
internal-network detail.

AI credentials remain backend-only. Provider and model combinations are
validated. Keys can be tested without being echoed, cleared, and rotated.
Requests have cancellation, timeout, quota, authentication, retry, prompt-size,
untrusted-content delimiting, and structured-output validation. Logs redact
credentials and sensitive content.

### 5.5 Reminder ownership

Reminder state and delivery state are separate. Reminder states include pending,
delivered, acknowledged, snoozed, dismissed, and failed. A failed state is
recorded only after a notification attempt returns an error or exhausts its
bounded retry policy. Each notification attempt records the target device and
outcome.

PC and Android do not acknowledge each other's delivery attempts. Repeating and
snoozed reminders schedule exactly once. Restarting either application does not
duplicate an already recorded delivery.

## 6. Legacy migration and recovery

The preserved quarantine is never opened or modified. Migration operates only
on a newly verified working copy of the coherent database, WAL, SHM, and
settings set.

The application detects a valid legacy backup but never imports it silently.
The owner must:

1. start an explicit migration;
2. verify the quarantine manifest and checksums;
3. allow creation of a disposable working copy;
4. review a dry-run report containing schema detection, row counts,
   convertible counts, skipped records, invalid values, ownership decisions,
   conflicts, and expected destination changes;
5. confirm the import;
6. allow a verified destination backup;
7. run the import transaction or documented resumable batches; and
8. review integrity and invariant results.

Failure restores or rolls back the destination and leaves the quarantine
unchanged. A retry does not duplicate imported records.

Database migrations, large imports, snapshot resynchronization, and destructive
maintenance create and verify a backup first. Sync batches and conflict
resolution use transactions. Recovery is not declared successful until SQLite
integrity and domain invariants pass.

## 7. Client design

### 7.1 Chrome extension

Chrome remains Manifest V3. The service worker owns pairing, authenticated API
requests, opaque cursors, notification mapping, context menus, and state
recovery. Content scripts await a complete settings snapshot before attaching
listeners.

Auto-capture is opt-in, never records typed text, excludes browser-internal and
sensitive pages, supports owner allowlists and blocklists, stops listeners and
timers immediately when disabled, and observes configured thresholds.

One API client applies authentication, timeouts, cancellation, response-size
limits, controlled errors, and offline reporting. Failed requests never display
success.

### 7.2 Dashboard

The dashboard is decomposed into focused ES modules for the shell, API/session,
domain views, import/export, settings, and rendering utilities. It derives its
normal origin from the serving backend.

Browser pairing uses a short-lived owner-entered code and then an `HttpOnly`,
`SameSite=Strict` local session cookie. Long-lived credentials are not placed in
URLs or dashboard JavaScript.

Untrusted content is rendered with safe DOM construction and `textContent`.
URLs are protocol-validated. Inline handlers and unsafe CSP allowances are
removed. Every view includes accessible loading, empty, partial, offline, error,
and retry states, plus keyboard, focus, contrast, reduced-motion, semantic, and
narrow-window behavior.

### 7.3 Electron

Electron acquires a single-instance lock, supplies protected storage and Windows
notification adapters, constructs the backend once, waits for true readiness,
and performs ordered shutdown.

IPC handlers are registered once and validate all payloads. The preload surface
is narrow. Node integration remains disabled, context isolation remains enabled,
and unexpected navigation, windows, permissions, webviews, methods, paths, and
external URL protocols are denied.

The packaged application uses Electron's embedded Node runtime. Native SQLite is
rebuilt and verified against the pinned Electron ABI and unpacked from ASAR when
required. The installer does not depend on a separately installed Node.js.

### 7.4 Android

The Android application uses React Native and TypeScript with native SQLite and
platform adapters for Keystore, QR scanning, private-network discovery,
background work, and local notifications.

Primary areas are:

- Home and synchronization status;
- capture bookmark, note, and highlight;
- memory search and item detail;
- reminders;
- flashcards and review;
- conflicts; and
- paired PC, network, privacy, and background-sync settings.

Every supported workflow works against the Android database while the PC is
offline. Records visibly distinguish local-only, queued, synchronized,
conflicted, and failed states.

## 8. Seven-stage delivery integration

### Stage 1: Containment and workspace normalization

Stage 1 remains the existing verified containment and workspace work. The
exposed Gemini key must still be confirmed revoked before a release is declared.

### Stage 2: Canonical database, lifecycle, authentication, and contract

Stage 2 delivers:

- canonical PC and Android-compatible domain identifiers;
- migrations, repositories, integrity, backup, and restore;
- explicit backend lifecycle and execution modes;
- local API authentication and browser/extension pairing;
- TLS device identity and Android pairing contract;
- sync tables, protocol types, cursors, tombstones, and conflict schema;
- frozen API and sync contracts; and
- explicit backup-first legacy migration with dry run and rollback.

### Stage 3: Domain correctness and synchronization engine

Stage 3 delivers:

- all canonical domain services;
- secure URL fetching;
- optional AI provider boundaries;
- persisted schedulers and per-device reminder delivery;
- outbox ingestion, pull log, acknowledgements, idempotency, conflicts,
  revocation, snapshot resynchronization, and retention;
- local-network sync gateway; and
- deterministic backend and protocol tests.

### Stage 4: Chrome and Android clients

Stage 4 repairs the MV3 extension and builds the Android mobile-focused product
against the frozen contracts. Both receive privacy, offline, authentication,
notification, retry, and end-to-end workflow tests.

### Stage 5: Dashboard

Stage 5 decomposes and secures the dashboard, implements every PC-facing
workflow, adds conflict and paired-device management, and completes browser
accessibility and stored-XSS verification.

### Stage 6: Electron and platform packaging

Stage 6 completes Electron lifecycle and security, native-module rebuilding,
Windows installer and portable validation, Android APK and optional
Play-distribution AAB generation, physical/emulated Android checks, and
cross-device local Wi-Fi validation.

### Stage 7: CI, release artifacts, documentation, and acceptance

Stage 7 completes all component CI gates, dependency-vulnerability enforcement,
artifact inspection and checksums, clean source archive, Windows and Android
artifacts, documentation, requirement-to-evidence records, changed-file
rationale, and full release acceptance evidence.

## 9. Verification strategy

Implementation follows test-driven repair where practical:

1. represent the requirement or defect with a failing test;
2. confirm that it fails for the intended reason;
3. implement the smallest coherent change;
4. rerun the focused test;
5. run the subsystem suite;
6. run every earlier stage gate; and
7. record evidence and recovery.

Required automated coverage includes:

- fresh and historical database migrations;
- integrity, backup, restore, and rollback;
- backend construction and shutdown without open handles;
- authentication, profile isolation, CORS, pairing, and revocation;
- SSRF, malicious imports, stored XSS, secret redaction, IPC and URL validation;
- every advertised domain workflow and state transition;
- duplicated, missing, reordered, interrupted, conflicting, deleted, retried,
  revoked, and expired-history synchronization;
- Android repository, offline, UI, background-work, notification, and migration
  behavior;
- extension settings, privacy, network failure, notification, and recovery;
- dashboard safety, accessibility, and responsive states;
- Electron IPC, lifecycle, native SQLite, packaged paths, and shutdown; and
- artifact content, version, secret, database, and checksum validation.

Manual acceptance evidence includes:

- a real Chrome MV3 session;
- the dashboard at desktop and narrow widths;
- Electron development lifecycle;
- a clean Windows packaged installation without system Node.js;
- Android emulator and physical-device workflows where a physical device is
  available; and
- PC/Android pairing, independent offline edits, bidirectional synchronization,
  conflict resolution, restart, revocation, and recovery on local Wi-Fi.

## 10. Release artifacts and documentation

The final release produces:

- a clean source archive without dependencies, credentials, personal data,
  runtime databases, logs, quarantine, or build output;
- a Windows installer;
- a portable Windows build only if its acceptance tests pass;
- an Android APK;
- a Play-distribution AAB when signing and distribution configuration are
  available;
- SHA-256 checksums and a release manifest;
- development, installation, pairing, migration, backup, restore, privacy,
  security, troubleshooting, update, uninstall, and data-deletion guides;
- a complete test report;
- an updated requirement-to-evidence matrix;
- a changed-file rationale; and
- an honest remaining-limitations report.

Documentation explicitly states that mobile sync requires the paired PC to be
running on the same approved Wi-Fi network. It must not claim cloud sync, iOS
support, or completed acceptance tests without evidence.

## 11. Exit gates and completion

Every stage requires:

1. passing automated tests on the supported runtimes;
2. recorded relevant manual evidence;
3. passing lint, format, secret, hygiene, dependency, build, and packaging gates;
4. no unresolved release blocker within completed scope;
5. a tested rollback, backup, restore, or recovery procedure;
6. an updated requirement-to-evidence record; and
7. a clean rerun of all earlier gates.

The existing high-severity dependency findings must be removed, upgraded away,
or otherwise eliminated from the release dependency graph. A passing test suite
does not override the vulnerability gate.

The project is complete only when all seven stages and cross-device acceptance
tests pass, the required source, Windows, and Android artifacts exist and are
verified, the evidence matrix accounts for every requirement, and the exposed
Gemini key revocation has been explicitly confirmed.

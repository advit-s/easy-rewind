# Easy Rewind Stages 2–7 Release Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a secure, working Windows desktop application, Chrome
extension, dashboard, and Android application backed by the same
Electron-independent modules, with offline local databases and explicit
local-Wi-Fi synchronization.

**Architecture:** Electron owns configuration and lifecycle only. The backend
is a set of reusable Node modules that can run embedded, standalone, or under
tests. The PC keeps the canonical full SQLite database. Android keeps a
mobile-focused SQLite replica and synchronizes bidirectionally through a
separate, mutually authenticated LAN gateway while the PC is running. Loopback
application traffic and LAN synchronization are separate trust boundaries.

**Tech Stack:** Node.js 24.18.0, JavaScript modules, SQLite with
`better-sqlite3`, Node's built-in test runner, Electron 43, Chrome Manifest V3,
React dashboard, Expo 57/React Native 0.86, `expo-sqlite`,
`expo-secure-store`, Android WorkManager through `expo-background-task`,
GitHub Actions, Windows packaging.

**Authoritative design:**
`docs/superpowers/specs/2026-07-25-easy-rewind-complete-release-and-android-sync-design.md`

---

## Delivery rules

- [ ] Work on one numbered stage at a time.
- [ ] Start every behavior change with a failing automated test.
- [ ] Keep application, database, migration, scheduler, sync, and HTTP modules
      free of Electron imports.
- [ ] Exercise production, standalone, and injected test modes from identical
      backend modules.
- [ ] Do not modify extension, dashboard, or mobile request code until the
      Stage 2 contract fixtures are frozen.
- [ ] Never use the preserved quarantine copy directly in a migration test.
      Copy it to a temporary location first.
- [ ] Keep `%LOCALAPPDATA%\easy-rewind\legacy-backup\` outside Git, builds,
      exports, logs, fixtures, screenshots, and test discovery.
- [ ] Do not treat a quarantine copy as credential storage. Gemini revocation
      remains an external release gate.
- [ ] End every stage with tests, evidence, blocker review, recovery procedure,
      and updated requirement-to-evidence records.

## Evidence layout

Each stage writes:

```text
docs/release/evidence/stage-<n>/
  README.md
  commands.md
  test-results/
  screenshots/
  manifests/
```

Machine-generated evidence must omit tokens, credentials, database rows,
private URLs, hostnames, and device identifiers. `README.md` records the exact
commit, tool versions, checks run, failures found, and recovery exercise.

---

## Stage 2 — Canonical backend foundation

**Detailed plan:**
`docs/superpowers/plans/2026-07-25-stage-2-backend-foundation.md`

### Outcomes

- [ ] Replace import-time server/database/timer side effects with explicit
      `createRuntime`, `start`, and idempotent `stop` lifecycle functions.
- [ ] Establish one canonical SQLite schema and ordered transactional
      migrations.
- [ ] Freeze OpenAPI/JSON Schema fixtures for auth, errors, pagination,
      cursors, reminder states, health, pairing, and sync envelopes.
- [ ] Add per-install loopback authentication and browser-session exchange.
- [ ] Add the pairing and sync data model without exposing a LAN listener by
      default.
- [ ] Build read-only legacy inspection and explicit backup-first migration
      workflows.
- [ ] Replace Jest with `node:test`, unique temporary databases, injected
      clocks/IDs, disabled listeners, and disabled schedulers.
- [ ] Resolve the native rebuild staging defect and prove the SQLite native
      module against the pinned Electron runtime.

### Exit gate

- [ ] Backend unit, integration, migration, contract, lifecycle, and native
      compatibility tests pass.
- [ ] Production, standalone, and test-mode smoke tests pass.
- [ ] API contract checksum is recorded in Stage 2 evidence.
- [ ] Legacy dry-run and rollback are demonstrated using a disposable copy.
- [ ] No database or listener starts during module import.
- [ ] No unresolved critical/high production vulnerability or unexplained
      failing audit finding remains.
- [ ] Recovery procedure restores the pre-migration database without opening
      the sole quarantine copy.

---

## Stage 3 — Domain correctness and synchronization

### Plan preparation gate

- [ ] Create
      `docs/superpowers/plans/2026-07-25-stage-3-domain-and-sync.md` from the
      frozen Stage 2 contract and schema checksum.
- [ ] Refuse Stage 3 implementation if Stage 2 evidence or recovery rehearsal
      is incomplete.

### Test-first work packages

- [ ] Implement repositories and services for items, bookmarks, notes,
      highlights, tags, connections, search, reminders, flashcards, quizzes,
      research, digests, settings, import, and export.
- [ ] Add ownership checks to every repository query and endpoint.
- [ ] Replace simulated AI success with explicit provider states:
      `not_configured`, `queued`, `completed`, `failed`, and `cancelled`.
- [ ] Add bounded URL fetching with scheme validation, DNS/IP checks,
      redirect revalidation, size/time limits, content-type limits, and HTML
      sanitization.
- [ ] Implement durable jobs with leases, retries, idempotency keys, and
      restart recovery.
- [ ] Implement reminder state transitions and deduplicated delivery records.
- [ ] Implement append-only sync operations, PC-assigned opaque cursors,
      tombstones, idempotency, conflict preservation, and deterministic
      convergence.
- [ ] Add a TLS LAN gateway that is disabled unless explicitly configured and
      accepts only paired, non-revoked devices with certificate pin evidence.
- [ ] Add property/integration tests for replay, duplicated operations,
      reordered batches, interrupted pulls, deletion conflicts, clock skew,
      revoked devices, and cursor expiry.
- [ ] Add redacted diagnostics, bounded logs, safe exports, schema-validated
      imports, atomic restores, and rollback tests.

### Exit gate

- [ ] All domain invariants and authorization tests pass.
- [ ] Two independent replicas converge after randomized offline changes.
- [ ] Sync interruption and retry do not duplicate or lose data.
- [ ] Revocation immediately blocks the device.
- [ ] Import/export round trips pass without secrets or device credentials.
- [ ] AI-disabled operation is fully usable and never reports fake success.
- [ ] SSRF, oversized response, unsafe redirect, and malformed import tests
      pass.
- [ ] Stage 3 evidence, blocker list, recovery procedure, and traceability
      records are complete.

---

## Stage 4 — Chrome extension and Android client

### Plan preparation gate

- [ ] Create
      `docs/superpowers/plans/2026-07-25-stage-4-chrome-extension.md` and
      `docs/superpowers/plans/2026-07-25-stage-4-android-client.md` from the
      frozen contract fixtures.
- [ ] Validate both plans against the Stage 3 sync replay suite before editing
      client request code.

### Chrome extension work packages

- [ ] Split the popup into modules with typed request/response validation.
- [ ] Remove all provider-key storage and transmission from Chrome storage.
- [ ] Make telemetry-like capture opt-in, narrowly scoped, inspectable, and
      erasable.
- [ ] Fix asynchronous settings initialization before content capture begins.
- [ ] Replace unsafe HTML insertion and inline handlers with DOM construction
      and delegated events.
- [ ] Add explicit connection, authentication, offline, retry, conflict, and
      backend-version states.
- [ ] Restrict permissions and host access to the minimum required surface.
- [ ] Add extension unit tests, mocked contract tests, privacy tests, and a
      packaged-extension smoke test in Chrome.

### Android work packages

- [ ] Create `mobile/` as an Expo 57 workspace with Android as the first
      supported platform.
- [ ] Add a mobile schema for items, bookmarks, notes, highlights, reminders,
      flashcards, outbox, inbox, cursors, conflicts, tombstones, and device
      metadata.
- [ ] Store pairing credentials only in Android protected storage; keep
      certificate fingerprints separate from content rows.
- [ ] Implement QR pairing with explicit PC confirmation, short-lived
      challenges, certificate pinning, and device naming/revocation.
- [ ] Implement local-first create/edit/delete/search/reminder/flashcard flows
      that never require connectivity.
- [ ] Implement sync on open, after local changes, on manual request, and
      periodically through Android WorkManager subject to operating-system
      scheduling.
- [ ] Show last successful sync, queued changes, conflicts, unavailable-PC
      state, and retry behavior without implying cloud availability.
- [ ] Keep research graphs, bulk import/export, provider administration, and
      advanced diagnostics PC-only.
- [ ] Add SQLite migration tests, UI tests, pairing tests, sync replay tests,
      background-task tests in a development build, and offline acceptance
      tests.

### Exit gate

- [ ] Extension privacy, permissions, XSS, auth, and packaged smoke tests pass.
- [ ] Android works fully offline for the mobile-focused core.
- [ ] Pairing requires user confirmation and rejects fingerprint mismatch.
- [ ] Android and PC converge after both are edited offline.
- [ ] Conflict and revoked-device experiences are understandable and tested.
- [ ] No key, token, database content, or hostname appears in client logs or
      release artifacts.
- [ ] Stage 4 evidence, recovery instructions, and traceability are complete.

---

## Stage 5 — Dashboard refactor and security

### Plan preparation gate

- [ ] Create
      `docs/superpowers/plans/2026-07-25-stage-5-dashboard.md` against frozen
      contract fixtures and Stage 3 domain behavior.

### Test-first work packages

- [ ] Replace the monolithic inline dashboard with a React application split
      into route, feature, data, and presentation modules.
- [ ] Use the browser-session exchange; remove arbitrary local-storage user
      identity.
- [ ] Add schema-validated API hooks with cancellation, retries, pagination,
      and explicit error states.
- [ ] Implement accessible keyboard navigation, focus handling, responsive
      layout, loading/empty/error/offline states, and reduced-motion support.
- [ ] Replace `innerHTML` and inline handlers with safe React rendering.
- [ ] Add reminder, conflict, device, import/export, settings, and diagnostics
      screens with confirmation for destructive actions.
- [ ] Add component, route, contract, accessibility, security, and browser
      end-to-end tests.

### Exit gate

- [ ] Dashboard passes unit, integration, accessibility, XSS, auth, and browser
      end-to-end tests.
- [ ] Unsupported backend versions fail safely with a clear upgrade message.
- [ ] Responsive acceptance passes at desktop, tablet, and narrow widths.
- [ ] Destructive settings, import, restore, and device revocation require
      explicit confirmation and provide recovery guidance.
- [ ] Stage 5 evidence and traceability are complete.

---

## Stage 6 — Electron lifecycle, native modules, packaging, Windows

### Plan preparation gate

- [ ] Create
      `docs/superpowers/plans/2026-07-25-stage-6-electron-windows.md` from the
      proven lifecycle APIs and dashboard production build.

### Test-first work packages

- [ ] Embed the backend runtime directly in Electron; do not spawn system
      `node.exe`.
- [ ] Pass storage paths, ports, scheduler policy, and secret-store adapters
      from Electron without importing Electron in backend modules.
- [ ] Await backend health before opening application windows.
- [ ] Stop schedulers, LAN gateway, loopback server, jobs, and databases
      idempotently on quit, restart, update, and crash recovery.
- [ ] Centralize IPC registration and validate every payload and sender.
- [ ] Restrict navigation, external URLs, permissions, window creation, CSP,
      preload exposure, and deep links.
- [ ] Repair the native rebuild staging layout, install/verify the pinned
      Electron binary, and rebuild `better-sqlite3` against Electron 43.
- [ ] Add real icons, product metadata, installer/uninstaller behavior,
      portable data policy, update policy, code-signing hooks, and artifact
      checksums.
- [ ] Test paths with spaces/non-ASCII characters, standard-user install,
      upgrade, uninstall, sleep/resume, no-network startup, multiple launch,
      firewall denial, and abrupt termination on Windows.

### Exit gate

- [ ] Packaged application starts without a system Node installation.
- [ ] Native ABI check passes inside the packaged Electron runtime.
- [ ] Install, upgrade, launch, quit, restart, sleep/resume, and uninstall
      acceptance tests pass on supported Windows versions.
- [ ] User data survives upgrades and is removed only by an explicit,
      separately confirmed data-removal action.
- [ ] Installer and unpacked artifacts contain no databases, keys, tokens,
      logs, quarantine paths, or test fixtures.
- [ ] Unsigned artifacts are unmistakably marked non-release; signed release
      procedure is documented and rehearsed when a certificate is available.
- [ ] Stage 6 evidence and recovery procedure are complete.

---

## Stage 7 — CI, release artifacts, documentation, acceptance

### Plan preparation gate

- [ ] Create
      `docs/superpowers/plans/2026-07-25-stage-7-release.md` from the exact
      Stage 6 build and test commands.

### Test-first work packages

- [ ] Add CI jobs for formatting, linting, secret scan, audit, unit,
      integration, migration, contract, sync convergence, extension, dashboard,
      mobile, Electron ABI, packaging, and artifact inspection.
- [ ] Pin Node/npm/Java/Android/Electron toolchains and cache only
      reproducible dependency directories.
- [ ] Upload redacted machine-readable test results, checksums, SBOM,
      provenance, installers, extension packages, and Android artifacts.
- [ ] Block release when the external Gemini credential-revocation attestation
      is absent.
- [ ] Document install, onboarding, pairing, offline behavior, synchronization,
      privacy, backup, restore, migration, conflict resolution, device
      revocation, troubleshooting, development, testing, and release.
- [ ] Execute the full requirements acceptance matrix on clean Windows and
      Android environments.
- [ ] Perform a clean-room install from release artifacts, pair a phone,
      create conflicting offline edits, converge, revoke the phone, restore a
      backup, and uninstall.

### Final release gate

- [ ] Every required CI check passes from a clean checkout.
- [ ] Production dependency audit has no unresolved release-blocking finding.
- [ ] Secret/history scans pass across the complete reachable history and all
      release artifacts.
- [ ] Gemini key revocation is externally confirmed and recorded without
      storing the key.
- [ ] All Stage 1–7 requirement-to-evidence records are linked and reviewed.
- [ ] No unresolved release blocker remains.
- [ ] Rollback procedures for migration, sync, upgrade, and release are
      rehearsed.
- [ ] Windows installer, Chrome extension, and Android artifact are versioned,
      checksummed, documented, and ready for user acceptance.

---

## Required verification commands

Commands may gain stage-specific flags, but their stable release entry points
must be:

```powershell
npm ci
npm run format:check
npm run lint
npm run test
npm run test:contracts
npm run test:migrations
npm run test:sync
npm run test:extension
npm run test:dashboard
npm run test:mobile
npm run test:electron
npm run audit:production
npm run scan:secrets
npm run package:windows
npm run package:extension
npm run package:android
npm run inspect:artifacts
npm run verify
```

`npm run verify` is the final aggregate and must fail on a skipped required
suite, missing artifact, missing evidence manifest, or unresolved release
blocker.

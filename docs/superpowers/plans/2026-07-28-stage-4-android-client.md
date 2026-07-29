# Stage 4 Android Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an Android-first Expo client that remains fully usable offline and converges with the PC through the frozen paired-device sync protocol when local connectivity returns.

**Architecture:** UI features write only to a local SQLite repository and append deterministic outbox operations in the same transaction. A sync coordinator authenticates to the paired PC, pins its TLS fingerprint, pushes the outbox, pulls opaque-cursor pages, preserves conflicts, and schedules retries without implying cloud availability. Keystore, QR scanning, notifications, network state, and background scheduling are injected platform ports so the domain and replay tests run under Node.

**Tech Stack:** Expo 57, React Native, TypeScript, Expo Router, native SQLite, Android Keystore-backed secure storage, WorkManager-backed background tasks, Node test runner for protocol/domain code.

---

## File and ownership map

```text
mobile/app/                         Expo Router screens
mobile/src/db/                      ordered SQLite migrations and repositories
mobile/src/domain/                  offline item/reminder/flashcard operations
mobile/src/pairing/                 QR, confirmation, credential, TLS pin state
mobile/src/sync/                    outbox, inbox, cursor, conflict coordinator
mobile/src/platform/                injected secure-store/network/task/notice ports
mobile/src/ui/                      status models and accessible primitives
mobile/test/                        migrations, offline, pairing, replay, UI-state tests
```

### Task 1: Create the Expo workspace and inert module boundary

**Files:**

- Create: `mobile/package.json`
- Create: `mobile/app.json`
- Create: `mobile/tsconfig.json`
- Create: `mobile/babel.config.js`
- Create: `mobile/metro.config.js`
- Create: `mobile/app/_layout.tsx`
- Create: `mobile/app/index.tsx`
- Create: `mobile/src/platform/ports.ts`
- Create: `mobile/test/import-safety.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write a failing import-safety test**

Import every domain/database/sync module with platform ports replaced by
throwing fakes. Assert imports create no database, listener, timer, network
request, secure-store access, or notification.

- [ ] **Step 2: Verify RED**

```powershell
node --test mobile/test/import-safety.test.mjs
```

- [ ] **Step 3: Add the Expo 57 Android workspace**

Keep iOS/web unsupported in the release scripts. Define explicit ports:
`SecureCredentialStore`, `PinnedTransport`, `BackgroundScheduler`,
`NotificationPort`, `NetworkStatus`, and `Clock`.

- [ ] **Step 4: Verify GREEN**

Run the import test and TypeScript no-emit check.

### Task 2: Implement ordered mobile SQLite migrations

**Files:**

- Create: `mobile/src/db/migrations.ts`
- Create: `mobile/src/db/open-database.ts`
- Create: `mobile/src/db/schema.ts`
- Create: `mobile/test/migrations.test.mjs`

- [ ] **Step 1: Write failing schema tests**

Freeze tables for items, bookmarks, notes, highlights, tags, item-tags,
reminders, flashcards, outbox, inbox acknowledgements, cursor, conflicts,
tombstones, device metadata, and migrations. Require profile ownership,
revision, integer UTC timestamps, and stable indexes.

- [ ] **Step 2: Verify RED**

```powershell
node --test mobile/test/migrations.test.mjs
```

- [ ] **Step 3: Implement checksummed transactional migrations**

Open only an injected database path. Reject migration checksum drift, gaps, a
database newer than the client, and failed migrations without partial schema.

- [ ] **Step 4: Verify GREEN**

Run migration tests twice against a disposable database and require no-op
reapplication.

### Task 3: Implement offline repositories and transactional outbox

**Files:**

- Create: `mobile/src/db/repository.ts`
- Create: `mobile/src/domain/content-service.ts`
- Create: `mobile/src/domain/reminder-service.ts`
- Create: `mobile/src/domain/flashcard-service.ts`
- Create: `mobile/test/offline-domain.test.mjs`

- [ ] **Step 1: Write failing offline tests**

With network ports throwing, cover create/edit/delete/search for mobile-scoped
content, reminders, and flashcards. Assert each mutation and its outbox
operation commit together with one monotonic device sequence and stable
operation ID.

- [ ] **Step 2: Verify RED**

```powershell
node --test mobile/test/offline-domain.test.mjs
```

- [ ] **Step 3: Implement**

Expose owner-scoped services whose returned state is one of `local_only`,
`queued`, `synchronized`, `conflicted`, or `failed`. Deletes create tombstones;
client clocks never allocate PC revisions.

- [ ] **Step 4: Verify GREEN**

Run the focused test offline with zero skips.

### Task 4: Implement confirmed pairing and protected identity

**Files:**

- Create: `mobile/src/pairing/pairing-service.ts`
- Create: `mobile/src/pairing/qr-payload.ts`
- Create: `mobile/src/pairing/tls-pin.ts`
- Create: `mobile/test/pairing.test.mjs`

- [ ] **Step 1: Write failing tests**

Cover exact QR fields, protocol version, expiry, one-use challenge, explicit
PC confirmation, device name, credential only in `SecureCredentialStore`,
fingerprint separate from content rows, mismatch rejection, cancellation, and
revoked credentials.

- [ ] **Step 2: Verify RED**

```powershell
node --test mobile/test/pairing.test.mjs
```

- [ ] **Step 3: Implement state machine**

Use `idle -> scanned -> awaiting_confirmation -> issuing -> paired`, with
terminal `expired`, `rejected`, and `failed` states. Never fall back to
un-pinned TLS.

- [ ] **Step 4: Verify GREEN**

Run the focused test with zero skips.

### Task 5: Implement deterministic push, pull, and conflict storage

**Files:**

- Create: `mobile/src/sync/protocol.ts`
- Create: `mobile/src/sync/sync-coordinator.ts`
- Create: `mobile/src/sync/replay.ts`
- Create: `mobile/test/sync-replay.test.mjs`

- [ ] **Step 1: Write failing replay tests**

Reuse the PC fixtures for duplicates, reordering, interruption, clock skew,
tombstones, stale edits, snapshot fallback, revocation, and conflict
resolution. Assert two replicas converge after receiving the same accepted PC
change log.

- [ ] **Step 2: Verify RED**

```powershell
node --test mobile/test/sync-replay.test.mjs backend/src/sync/convergence.test.js
```

- [ ] **Step 3: Implement coordinator**

Push at most 100 ordered operations; delete only acknowledged outbox rows.
Pull opaque cursor pages transactionally; store change IDs before application.
On interruption, resume from the last committed cursor. Store both conflict
variants and require explicit resolution.

- [ ] **Step 4: Verify GREEN**

Run the shared replay command with zero skips.

### Task 6: Add foreground and Android background scheduling

**Files:**

- Create: `mobile/src/sync/sync-triggers.ts`
- Create: `mobile/src/platform/expo-background-scheduler.ts`
- Create: `mobile/test/background-sync.test.mjs`

- [ ] **Step 1: Write failing trigger tests**

Cover app open, committed local mutation, manual request, network return, and
periodic Android task. Coalesce concurrent requests, apply exponential bounded
retry with jitter from an injected source, and stop on revocation or
fingerprint mismatch.

- [ ] **Step 2: Verify RED**

```powershell
node --test mobile/test/background-sync.test.mjs
```

- [ ] **Step 3: Implement**

Background work is best-effort WorkManager scheduling; UI truthfully shows
last success and queued work instead of promising exact execution time.

- [ ] **Step 4: Verify GREEN**

Run the focused suite using a development-build adapter fake.

### Task 7: Build the approved mobile-focused screens

**Files:**

- Create: `mobile/app/(tabs)/_layout.tsx`
- Create: `mobile/app/(tabs)/index.tsx`
- Create: `mobile/app/(tabs)/search.tsx`
- Create: `mobile/app/(tabs)/reminders.tsx`
- Create: `mobile/app/(tabs)/review.tsx`
- Create: `mobile/app/capture.tsx`
- Create: `mobile/app/item/[id].tsx`
- Create: `mobile/app/conflicts.tsx`
- Create: `mobile/app/settings.tsx`
- Create: `mobile/src/ui/sync-status.ts`
- Create: `mobile/test/ui-states.test.mjs`

- [ ] **Step 1: Write failing state-model tests**

Require accessible loading, empty, offline, queued, synchronized, conflicted,
revoked, incompatible, and retry states. Assert every action writes locally
before requesting sync.

- [ ] **Step 2: Verify RED**

```powershell
node --test mobile/test/ui-states.test.mjs
```

- [ ] **Step 3: Implement screens**

Primary tabs are Home, Search, Reminders, and Review. Capture, item detail,
conflicts, paired-PC/network/privacy/background settings are routes. Research
graphs, bulk import/export, provider administration, and advanced diagnostics
remain PC-only.

- [ ] **Step 4: Verify GREEN**

Run UI-state tests and TypeScript checking with zero errors.

### Task 8: Add notifications, Android validation, evidence, and recovery

**Files:**

- Create: `mobile/src/platform/expo-notifications.ts`
- Create: `mobile/test/notifications.test.mjs`
- Create: `scripts/validation/validate-mobile.mjs`
- Create: `docs/release/evidence/stage-4/android-commands.md`
- Create: `docs/release/evidence/stage-4/android-recovery.md`
- Modify: `docs/release/requirements/stages-2-7.csv`
- Modify: `package.json`

- [ ] **Step 1: Test per-device reminder behavior**

Require local scheduling IDs, idempotent updates, cancellation, and the rule
that acknowledging Android never acknowledges the PC delivery.

- [ ] **Step 2: Add stable commands**

```json
{
  "test:mobile": "node --test mobile/test/*.test.mjs",
  "validate:mobile": "node scripts/validation/validate-mobile.mjs"
}
```

- [ ] **Step 3: Run the Android client gate**

```powershell
npm run test:mobile
npm run validate:mobile
npm run scan:secrets
npm run check:hygiene
```

- [ ] **Step 4: Record recovery**

Stop sync, preserve the protected mobile database, verify PC reachability and
the pinned identity, repair credentials only through re-pairing, and use a PC
snapshot only after preserving queued local operations. Never clear local data
as an automatic retry.

- [ ] **Step 5: Commit the implementation checkpoint**

Stage only explicit `mobile`, validation, documentation, and package files.

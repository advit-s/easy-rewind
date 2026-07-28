# Stage 3 Domain Correctness and Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Stage 2 compatibility placeholders with owner-scoped domain
behavior, durable work, secure remote acquisition, truthful optional AI, and a
deterministic bidirectional synchronization engine.

**Architecture:** Feature slices expose repository and service factories over
an injected canonical SQLite handle. HTTP routes depend only on those services;
Electron remains outside backend modules. Domain mutations and synchronization
share one transaction boundary so every accepted change receives a new
authoritative revision and append-only cursor. The LAN gateway is a distinct,
disabled-by-default TLS trust boundary.

**Tech Stack:** Node.js 24.18.0 LTS, CommonJS backend modules, `better-sqlite3`,
Express, Node's built-in test runner, frozen JSON Schemas/OpenAPI, injected
clocks/IDs/fetch/TLS adapters.

---

## Stage entry record

- Stage 2 implementation is merged into `main` at `f2073bd`.
- The main-folder post-merge test command passes.
- Schema bundle checksum:
  `9c5292808862a88cb1035f6431456e5776442de0086e321769e1b892a815d145`.
- OpenAPI checksum:
  `c58423ce97f8f2960ccc11e7d2fd828b3360a114ca01861a4c7fce17fbceb450`.
- The online `npm ci` release check remains blocked until registry metadata
  disclosure is explicitly authorized. Stage 3 work does not convert that
  blocked result into a pass.
- Gemini provider revocation remains an external release blocker.

## File and ownership map

```text
backend/src/domain/
  domain-error.js              stable safe domain failures
  repository-utils.js          owner scope, JSON, cursors, revisions
  content/                     items, bookmarks, notes, highlights, tags
  graph/                       connections and graph projections
  learning/                    flashcards, quiz results, digests
  reminders/                   reminder state and per-device deliveries
  research/                    research orchestration
  settings/                    validated non-secret preferences
backend/src/jobs/              durable leases, retries, recovery
backend/src/remote/            URL policy, DNS/redirect validation, fetch
backend/src/ai/                provider registry and truthful job states
backend/src/import-export/     versioned safe bundles and atomic restore
backend/src/sync/              operations, changes, cursors, conflicts
backend/src/lan/               opt-in mutually authenticated TLS gateway
backend/src/routes/            authenticated Stage 3 HTTP adapters
backend/src/database/
  migrations/004_stage3.sql    additive Stage 3 tables/constraints
packages/contracts/            frozen contract additions with fixtures
docs/release/evidence/stage-3/ redacted commands, recovery, traceability
```

Internal timestamps remain integer UTC milliseconds as frozen by the canonical
schema. HTTP and synchronization adapters serialize them as the exact
contracted timestamp representation. Client clocks are diagnostic only and
never assign revisions or cursors.

### Task 1: Freeze Stage 3 schema additions and requirement evidence

**Files:**

- Create: `backend/src/database/migrations/004_stage3.sql`
- Modify: `backend/src/database/schema-contract.fixture.js`
- Modify: `backend/src/database/schema-contract.test.js`
- Create: `backend/src/database/stage3-schema.test.js`
- Modify: `docs/release/requirements/stages-2-7.csv`
- Create: `docs/release/evidence/stage-3/README.md`
- Create: `docs/release/evidence/stage-3/commands.md`
- Create: `docs/release/evidence/stage-3/recovery.md`
- Create: `docs/release/evidence/stage-3/traceability.md`

- [ ] **Step 1: Write failing schema tests**

Assert exact columns, constraints, indexes, and foreign keys for:

```js
const stage3Tables = [
  'interactions',
  'memory_scores',
  'sync_device_sequences',
  'sync_acknowledgements',
  'sync_snapshots',
  'import_runs',
  'export_runs',
  'provider_configurations',
];
```

Also assert additive columns required for operation type, device sequence,
protocol/schema version, lease expiry, idempotency, tombstone retention, and
conflict-resolution change IDs.

- [ ] **Step 2: Verify RED**

Run:

```powershell
node --test backend/src/database/stage3-schema.test.js
```

Expected: FAIL because migration `004_stage3.sql` and its tables do not exist.

- [ ] **Step 3: Add the transactional additive migration**

Use owner foreign keys, globally unique text IDs, integer UTC milliseconds,
revision checks, tombstones where synchronized, unique device sequence and
idempotency keys, and indexes matching every planned query. Do not alter the
bytes of migrations `001` through `003`.

- [ ] **Step 4: Update the exact schema fixture and Stage 3 ledger**

Add explicit S3 requirement rows for domain ownership, jobs, reminders, fetch,
AI truthfulness, import/export, sync convergence, revocation, and LAN security.
Evidence files start as `not-started`; do not claim passing commands.

- [ ] **Step 5: Verify GREEN and regression**

```powershell
node --test backend/src/database/*.test.js
npm run test:requirements
```

Expected: all database and requirement tests pass with zero skips.

- [ ] **Step 6: Commit**

```powershell
git add backend/src/database docs/release
git commit -m "feat: freeze stage 3 schema and evidence"
```

### Task 2: Add owner-scoped repository primitives

**Files:**

- Create: `backend/src/domain/domain-error.js`
- Create: `backend/src/domain/repository-utils.js`
- Create: `backend/src/domain/repository-utils.test.js`

- [ ] **Step 1: Write failing primitive tests**

Cover exact owner predicates, stable not-found/conflict errors, strict JSON
parsing, bounded cursor pagination, injected IDs/clocks, transaction reuse, and
revision allocation:

```js
const repository = createRepositoryUtils({ db, ids, now });
const page = repository.page({
  profileId,
  table: 'items',
  cursor: undefined,
  limit: 25,
});
assert.deepEqual(Object.keys(page), ['items', 'nextCursor', 'hasMore']);
```

Reject arbitrary table/column names and ensure safe errors contain no input
values.

- [ ] **Step 2: Verify RED**

```powershell
node --test backend/src/domain/repository-utils.test.js
```

Expected: FAIL because the repository utility does not exist.

- [ ] **Step 3: Implement minimal primitives**

Export:

```js
createRepositoryUtils({ db, ids, now });
encodeCursor({ updatedAt, id });
decodeCursor(cursor);
DomainError;
```

Keep SQL identifiers in frozen internal maps. Every query receives
`profile_id = ?`; callers cannot supply ownership through payloads.

- [ ] **Step 4: Verify GREEN**

```powershell
node --test backend/src/domain/repository-utils.test.js
```

- [ ] **Step 5: Commit**

```powershell
git add backend/src/domain
git commit -m "feat: add owner scoped repository primitives"
```

### Task 3: Implement content, tags, graph, and full-text search

**Files:**

- Create: `backend/src/domain/content/content-repository.js`
- Create: `backend/src/domain/content/content-service.js`
- Create: `backend/src/domain/content/content.test.js`
- Create: `backend/src/domain/graph/graph-repository.js`
- Create: `backend/src/domain/graph/graph-service.js`
- Create: `backend/src/domain/graph/graph.test.js`
- Create: `backend/src/routes/content-routes.js`
- Create: `backend/src/routes/content-routes.test.js`

- [ ] **Step 1: Write failing content and authorization tests**

Cover create/read/update/tombstone for items, bookmarks, notes, highlights,
tags, item-tags, and connections. Test normalized URL/tag conflicts,
cross-profile IDs, stale revisions, cursor pages, archived/deleted rows, FTS
updates, graph direction, and deterministic related-item ordering.

- [ ] **Step 2: Verify RED**

```powershell
node --test backend/src/domain/content/content.test.js backend/src/domain/graph/graph.test.js
```

- [ ] **Step 3: Implement repositories and services**

Factories accept only injected dependencies:

```js
createContentRepository({ db, repositoryUtils });
createContentService({ repository, syncRecorder });
createGraphRepository({ db, repositoryUtils });
createGraphService({ repository });
```

Each mutation validates the current authoritative revision, writes a
tombstone instead of hard-deleting synchronized rows, and calls
`syncRecorder.recordChange()` inside the same transaction.

- [ ] **Step 4: Add authenticated routes**

Map `/v1/items`, bookmarks, notes, highlights, tags, connections, search, and
knowledge graph. Derive `profileId` only from immutable request context and
return the frozen pagination/error envelopes.

- [ ] **Step 5: Verify GREEN**

```powershell
node --test backend/src/domain/content/*.test.js backend/src/domain/graph/*.test.js backend/src/routes/content-routes.test.js
```

- [ ] **Step 6: Commit**

```powershell
git add backend/src/domain/content backend/src/domain/graph backend/src/routes
git commit -m "feat: implement owner scoped content and graph"
```

### Task 4: Implement learning, digests, and statistics

**Files:**

- Create: `backend/src/domain/learning/learning-repository.js`
- Create: `backend/src/domain/learning/spaced-repetition.js`
- Create: `backend/src/domain/learning/learning-service.js`
- Create: `backend/src/domain/learning/learning.test.js`
- Create: `backend/src/routes/learning-routes.js`
- Create: `backend/src/routes/learning-routes.test.js`

- [ ] **Step 1: Write failing tests**

Cover flashcard lifecycle, deterministic spaced-review calculations, invalid
quality values, due ordering, quiz result invariants, aggregate statistics,
digest periods, owner isolation, tombstones, and repeated review idempotency.

- [ ] **Step 2: Verify RED**

```powershell
node --test backend/src/domain/learning/learning.test.js
```

- [ ] **Step 3: Implement minimal deterministic services**

```js
calculateNextReview({ quality, intervalDays, easeFactor, reviewedAt });
createLearningRepository({ db, repositoryUtils });
createLearningService({ repository, syncRecorder, now });
```

Do not use wall-clock time or random IDs without injected adapters.

- [ ] **Step 4: Add authenticated learning routes and verify**

```powershell
node --test backend/src/domain/learning/*.test.js backend/src/routes/learning-routes.test.js
```

- [ ] **Step 5: Commit**

```powershell
git add backend/src/domain/learning backend/src/routes/learning-routes*
git commit -m "feat: implement learning and digest workflows"
```

### Task 5: Implement reminders and durable delivery

**Files:**

- Create: `backend/src/domain/reminders/reminder-state.js`
- Create: `backend/src/domain/reminders/reminder-repository.js`
- Create: `backend/src/domain/reminders/reminder-service.js`
- Create: `backend/src/domain/reminders/reminder-worker.js`
- Create: `backend/src/domain/reminders/reminders.test.js`
- Create: `backend/src/routes/reminder-routes.js`
- Create: `backend/src/routes/reminder-routes.test.js`

- [ ] **Step 1: Write failing state and delivery tests**

Cover every frozen transition, snooze/repeat scheduling, device-specific
delivery rows, delivery idempotency, bounded retries, restart recovery, and the
rule that `failed` follows a real exhausted attempt.

- [ ] **Step 2: Verify RED**

```powershell
node --test backend/src/domain/reminders/reminders.test.js
```

- [ ] **Step 3: Implement state/repository/service/worker**

```js
transitionReminder({ current, action, now, snoozeUntil });
createReminderService({ repository, jobs, syncRecorder, now, ids });
createReminderWorker({ repository, notifier, leases, now });
```

Delivery acknowledgement changes only the target delivery row. A PC delivery
never acknowledges an Android delivery.

- [ ] **Step 4: Add routes and verify**

```powershell
node --test backend/src/domain/reminders/*.test.js backend/src/routes/reminder-routes.test.js
```

- [ ] **Step 5: Commit**

```powershell
git add backend/src/domain/reminders backend/src/routes/reminder-routes*
git commit -m "feat: add durable reminder delivery"
```

### Task 6: Add durable jobs with leases and restart recovery

**Files:**

- Create: `backend/src/jobs/job-repository.js`
- Create: `backend/src/jobs/job-runner.js`
- Create: `backend/src/jobs/job-runner.test.js`
- Modify: `backend/src/scheduler/scheduler-controller.js`
- Modify: `backend/src/scheduler/scheduler-controller.test.js`

- [ ] **Step 1: Write failing job tests**

Cover unique idempotency keys, atomic lease acquisition, lease expiry,
heartbeat, bounded retry/backoff, cancellation, stale-worker completion
rejection, and restart recovery.

- [ ] **Step 2: Verify RED**

```powershell
node --test backend/src/jobs/job-runner.test.js
```

- [ ] **Step 3: Implement repository and runner**

```js
createJobRepository({ db, now, ids });
createJobRunner({ repository, handlers, workerId, now, schedule });
```

Handlers receive an abort signal and idempotency context. Completion updates
must include the active lease token.

- [ ] **Step 4: Integrate with the injected scheduler and verify**

```powershell
node --test backend/src/jobs/*.test.js backend/src/scheduler/*.test.js
```

- [ ] **Step 5: Commit**

```powershell
git add backend/src/jobs backend/src/scheduler
git commit -m "feat: add durable leased jobs"
```

### Task 7: Add the hardened remote fetch boundary

**Files:**

- Create: `backend/src/remote/url-policy.js`
- Create: `backend/src/remote/remote-fetch.js`
- Create: `backend/src/remote/html-sanitizer.js`
- Create: `backend/src/remote/remote-fetch.test.js`

- [ ] **Step 1: Write failing SSRF and bounds tests**

Test schemes, embedded credentials, loopback/private/link-local/multicast IPs,
IPv4 variants, IPv6, DNS rebinding, every redirect, redirect loops, response
timeouts, byte limits, content types, compressed limits, malformed HTML, and
safe error redaction.

- [ ] **Step 2: Verify RED**

```powershell
node --test backend/src/remote/remote-fetch.test.js
```

- [ ] **Step 3: Implement injected DNS/fetch/clock policy**

```js
createRemoteFetcher({
  lookup,
  request,
  now,
  maxRedirects,
  maxBytes,
  timeoutMs,
  allowedContentTypes,
});
```

Resolve and validate all addresses before connecting, pin the selected address
for that request, validate redirect targets from scratch, and never return
internal address details.

- [ ] **Step 4: Verify GREEN**

```powershell
node --test backend/src/remote/*.test.js
```

- [ ] **Step 5: Commit**

```powershell
git add backend/src/remote
git commit -m "feat: harden remote content acquisition"
```

### Task 8: Implement truthful research and optional AI

**Files:**

- Create: `backend/src/ai/provider-registry.js`
- Create: `backend/src/ai/ai-service.js`
- Create: `backend/src/ai/ai-service.test.js`
- Create: `backend/src/domain/research/research-repository.js`
- Create: `backend/src/domain/research/research-service.js`
- Create: `backend/src/domain/research/research.test.js`
- Create: `backend/src/routes/research-routes.js`
- Create: `backend/src/routes/research-routes.test.js`

- [ ] **Step 1: Write failing provider-state and research tests**

Cover `not_configured`, `queued`, `completed`, `failed`, and `cancelled`;
provider/model allowlists; protected key get/test/clear/rotate without echo;
timeouts, aborts, quota/auth failures, structured-output validation, prompt
bounds, untrusted-content delimiters, and AI-disabled research.

- [ ] **Step 2: Verify RED**

```powershell
node --test backend/src/ai/ai-service.test.js backend/src/domain/research/research.test.js
```

- [ ] **Step 3: Implement provider and research services**

```js
createProviderRegistry({ secretStore, providers });
createAiService({ registry, jobs, now });
createResearchService({ repository, jobs, remoteFetcher, aiService, now });
```

Queueing returns `queued`; missing configuration returns `not_configured`;
provider failure returns `failed`. Never fabricate summaries or success.

- [ ] **Step 4: Add authenticated routes and verify**

```powershell
node --test backend/src/ai/*.test.js backend/src/domain/research/*.test.js backend/src/routes/research-routes.test.js
```

- [ ] **Step 5: Commit**

```powershell
git add backend/src/ai backend/src/domain/research backend/src/routes/research-routes*
git commit -m "feat: add truthful research and AI jobs"
```

### Task 9: Add versioned import, export, backup, and restore

**Files:**

- Create: `backend/src/import-export/export-service.js`
- Create: `backend/src/import-export/import-service.js`
- Create: `backend/src/import-export/backup-service.js`
- Create: `backend/src/import-export/import-export.test.js`
- Create: `backend/src/routes/import-export-routes.js`
- Create: `backend/src/routes/import-export-routes.test.js`

- [ ] **Step 1: Write failing bundle and recovery tests**

Cover exact format/schema versions, owner scoping, secret/device exclusion,
size/depth/count bounds, unknown fields, malformed JSON, duplicate IDs,
cross-owner references, dry-run, destination backup verification, transaction
rollback, atomic restore, and round-trip equality.

- [ ] **Step 2: Verify RED**

```powershell
node --test backend/src/import-export/import-export.test.js
```

- [ ] **Step 3: Implement safe services**

```js
createExportService({ db, schemas, now });
createImportService({ db, schemas, backupService, now, ids });
createBackupService({ filesystem, filePermissions, now, ids });
```

Exports contain no credentials, protected secret references, diagnostics,
device credentials, or machine paths. Imports never execute SQL supplied by a
bundle.

- [ ] **Step 4: Add routes and verify**

```powershell
node --test backend/src/import-export/*.test.js backend/src/routes/import-export-routes.test.js
```

- [ ] **Step 5: Commit**

```powershell
git add backend/src/import-export backend/src/routes/import-export-routes*
git commit -m "feat: add safe versioned import and export"
```

### Task 10: Implement append-only synchronization and conflicts

**Files:**

- Create: `backend/src/sync/entity-registry.js`
- Create: `backend/src/sync/sync-repository.js`
- Create: `backend/src/sync/sync-service.js`
- Create: `backend/src/sync/conflict-service.js`
- Create: `backend/src/sync/snapshot-service.js`
- Create: `backend/src/sync/sync.test.js`
- Create: `backend/src/sync/convergence.test.js`
- Create: `backend/src/routes/sync-routes.js`
- Modify: `backend/src/routes/contract-routes.js`
- Create: `backend/src/routes/sync-routes.test.js`

- [ ] **Step 1: Write failing protocol tests**

Cover strictly increasing per-device sequence, operation idempotency, base
revision checks, duplicate/reordered/interrupted batches, authoritative
revisions, opaque cursor pages including empty pages, tombstones,
acknowledgements, revoked devices, expired cursors, snapshot resync, and all
three conflict resolutions.

- [ ] **Step 2: Write randomized convergence tests**

Generate independent replica histories containing create/update/delete,
duplicate deliveries, reorderings, clock skew, interrupted pulls, and
delete/edit conflicts. Assert both replicas converge after applying the same
accepted PC change log and explicit resolutions.

- [ ] **Step 3: Verify RED**

```powershell
node --test backend/src/sync/sync.test.js backend/src/sync/convergence.test.js
```

- [ ] **Step 4: Implement transactional push/pull**

```js
createSyncService({
  db,
  entityRegistry,
  repository,
  conflicts,
  snapshots,
  now,
  ids,
});
```

Apply one validated batch in an immediate transaction. Replays return stored
acknowledgements. Allocate sequence/cursor only on the PC. Preserve both
variants on stale base revisions. Conflict resolution writes a new canonical
revision and normal sync change.

- [ ] **Step 5: Replace Stage 2 sync placeholders and verify**

```powershell
npm run test:contracts
node --test backend/src/sync/*.test.js backend/src/routes/sync-routes.test.js
```

- [ ] **Step 6: Commit**

```powershell
git add backend/src/sync backend/src/routes packages/contracts
git commit -m "feat: implement deterministic synchronization"
```

### Task 11: Add the opt-in mutually authenticated LAN gateway

**Files:**

- Create: `backend/src/lan/tls-identity-service.js`
- Create: `backend/src/lan/lan-gateway.js`
- Create: `backend/src/lan/lan-gateway.test.js`
- Modify: `backend/src/lifecycle/composition-root.js`
- Modify: `backend/src/lifecycle/create-runtime.js`
- Modify: `backend/src/lifecycle/create-runtime.test.js`

- [ ] **Step 1: Write failing gateway tests**

Cover disabled-by-default behavior, private-subnet binding, distinct TLS
identity/credential, certificate fingerprint, paired-device authentication,
revocation, request/body/time bounds, incompatible protocol, graceful drain,
and zero LAN handles in test mode.

- [ ] **Step 2: Verify RED**

```powershell
node --test backend/src/lan/lan-gateway.test.js
```

- [ ] **Step 3: Implement the injected TLS gateway**

```js
createLanGateway({
  config,
  tlsAdapter,
  pairingService,
  syncService,
  requestTracker,
});
```

The backend module accepts TLS material through adapters and never imports
Electron. It exposes only pairing and sync paths. Loopback cookies/install
bearers are invalid on this boundary.

- [ ] **Step 4: Wire lifecycle and verify**

```powershell
node --test backend/src/lan/*.test.js backend/src/lifecycle/*.test.js
```

- [ ] **Step 5: Commit**

```powershell
git add backend/src/lan backend/src/lifecycle
git commit -m "feat: add opt in local sync gateway"
```

### Task 12: Compose Stage 3 services, replace compatibility behavior, and close the gate

**Files:**

- Modify: `backend/src/lifecycle/composition-root.js`
- Modify: `backend/src/http/create-app.js`
- Modify: `backend/src/routes/compatibility-routes.js`
- Create: `backend/src/routes/stage3-routes.test.js`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `docs/release/evidence/stage-3/README.md`
- Modify: `docs/release/evidence/stage-3/commands.md`
- Modify: `docs/release/evidence/stage-3/recovery.md`
- Modify: `docs/release/evidence/stage-3/traceability.md`
- Modify: `docs/release/requirements/stages-2-7.csv`

- [ ] **Step 1: Write failing composition and advertised-route tests**

Assert identical production/standalone/test service composition, import
inertness, no unresolved `not_implemented` for Stage 3 domain routes, immutable
owner context, and truthful AI/sync/job/reminder health.

- [ ] **Step 2: Verify RED**

```powershell
node --test backend/src/routes/stage3-routes.test.js backend/test/import-safety.test.js
```

- [ ] **Step 3: Wire repositories/services/routes**

Construct all services from the same canonical database, protected secret
store, injected scheduler, remote fetch adapter, and optional LAN adapter.
Test mode disables listeners/workers but exposes the same modules.

- [ ] **Step 4: Add stable Stage 3 commands**

```json
{
  "test:domain": "node --test backend/src/domain/**/*.test.js",
  "test:jobs": "node --test backend/src/jobs/*.test.js",
  "test:remote": "node --test backend/src/remote/*.test.js",
  "test:sync": "node --test backend/src/sync/*.test.js backend/src/lan/*.test.js",
  "test:import-export": "node --test backend/src/import-export/*.test.js",
  "verify:stage3": "npm run test:domain && npm run test:jobs && npm run test:remote && npm run test:import-export && npm run test:sync && npm --workspace backend test && npm run test:contracts && npm run scan:secrets && npm run check:hygiene"
}
```

- [ ] **Step 5: Run the full Stage 3 gate**

```powershell
npm run verify:stage3
```

Expected: all domain, authorization, job, reminder, SSRF, import/export, sync
convergence, revocation, lifecycle, contract, secret, and hygiene tests pass
with zero skipped required suites.

- [ ] **Step 6: Record evidence and recovery**

Record exact safe aggregate counts, schema/contract checksums, randomized
convergence seeds, import/restore rehearsal, sync interruption recovery, and
LAN disabled/default proof. Store no raw rows, tokens, device IDs, hostnames,
private URLs, or machine paths.

- [ ] **Step 7: Run earlier-stage regression**

```powershell
npm test
npm run verify:native
```

The separately blocked online clean install and Gemini revocation remain
blocked unless independently completed.

- [ ] **Step 8: Commit**

```powershell
git add backend packages/contracts package.json package-lock.json README.md SECURITY.md docs
git commit -m "feat: complete stage 3 domain and synchronization"
```

## Stage 3 recovery procedure

1. Stop the scheduler, LAN gateway, loopback listener, and job acquisition.
2. Allow active bounded transactions to finish or roll back.
3. Preserve the runtime database and sidecars as sensitive local diagnostics.
4. Verify the most recent pre-import/pre-snapshot backup.
5. Restore to a new protected runtime path; never overwrite the only verified
   backup during diagnosis.
6. Start with listeners, jobs, and schedulers disabled.
7. Run SQLite integrity, schema, ownership, cursor, lease, reminder-delivery,
   tombstone, and idempotency invariants.
8. Enable loopback, then workers, then the LAN gateway.
9. Re-pair or snapshot-resynchronize only devices whose retained cursor history
   is unavailable.
10. Add a regression test and safe evidence entry before retrying the failed
    operation.

## Stage 3 completion gate

- [ ] Every domain query is owner-scoped.
- [ ] AI-disabled operation is complete and truthful.
- [ ] Durable jobs recover without duplicate completion.
- [ ] Reminder attempts and device acknowledgements remain distinct.
- [ ] SSRF and response-bound tests pass.
- [ ] Import/export round trips omit secrets and credentials.
- [ ] Duplicate, reordered, interrupted, revoked, and expired sync cases pass.
- [ ] Two randomized replicas converge after explicit conflict resolution.
- [ ] The LAN gateway remains disabled unless explicitly configured.
- [ ] Stage 3 evidence and requirement traceability are complete.

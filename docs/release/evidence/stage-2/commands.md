# Stage 2 baseline commands

Commands were run from the repository root under the pinned Node `24.18.0`
runtime. The machine-local runtime wrapper is intentionally omitted because
release evidence must not contain personal absolute paths.

## Executed baseline checks

| Repository command                                    | Exit | Result                                                                                          |
| ----------------------------------------------------- | ---: | ----------------------------------------------------------------------------------------------- |
| `npm test`                                            |    0 | Workspace `41/41`; containment `21/21`; hygiene `63/63`; legacy backend `57/57`                 |
| `npm run test:requirements` before records            |    1 | Expected RED: the Stage 2 requirements CSV was missing; the root script contract already passed |
| `npm run test:requirements` after records             |    0 | GREEN: all `3/3` requirements-ledger tests passed                                               |
| `npm run test:requirements` after validator hardening |    0 | GREEN: all `18/18` parser, global-invariant, link, ledger, and script tests passed              |
| In-memory SQLite version query                        |    0 | Node `24.18.0`; npm `11.6.2`; Electron `43.2.0`; better-sqlite3 `13.0.1`; SQLite `3.53.3`       |

## Task 2 isolated-test commands

| Repository command                                                                                                                                                 | Exit | Result                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---: | -------------------------------------------------------------------- |
| `npm --workspace backend test`                                                                                                                                     |    0 | Node test runner `85/85`; inherited API/mail coverage `57/57`        |
| `node --test scripts/testing/run-legacy-backend-tests.test.mjs`                                                                                                    |    0 | Safe disposable-copy runner contract `9/9`                           |
| `node scripts/testing/run-legacy-backend-tests.mjs`                                                                                                                |    0 | Disposable backend copy; isolated runtime; inherited tests `57/57`   |
| `node --test backend/test/import-safety.test.js backend/test/import-safety-probe.test.js backend/test/runtime-state.test.js backend/test/server-lifecycle.test.js` |    0 | Probe/import, runtime reset, and lifecycle cleanup `21/21`           |
| `npm ci`                                                                                                                                                           |    0 | Lockfile-clean install: `525` packages added; `528` audited          |
| `npm ls jest --all`                                                                                                                                                |    1 | Expected empty dependency tree; no installed Jest package            |
| `npm audit --omit=dev`                                                                                                                                             |    0 | Production dependencies: `0` vulnerabilities                         |
| `npm audit`                                                                                                                                                        |    1 | Full tree: `16` high, `0` critical; Electron packaging chain remains |

All commands in this section used Node `24.18.0`. The failed full audit is
retained as a truthful advisory finding; no forced audit fix or broad
dependency upgrade was performed.

The current Node test runs in this section emitted no open-handle warning. The
version query used only an in-memory database.

## Task 2 RED-to-GREEN evidence

The original Task 2 RED runs were intentionally failing and are recorded here
without raw paths, environment values, credentials, file contents, or hashes:

| RED check                        | Exit | Sanitized observed failure                                                                                      |
| -------------------------------- | ---: | --------------------------------------------------------------------------------------------------------------- |
| Production import-safety         |    1 | Import created one listener, two scheduler resources, attempted a settings write, and read `.env`               |
| Injected database-path contract  |    1 | Helpers selected the fixed repository database instead of the unique external test path                         |
| Isolated support-helper contract |    1 | Required test-environment and ephemeral-server helper modules/exports did not exist                             |
| Strengthened probe fixture suite |    1 | Environment/config, callback, promise, stream, and non-timeout resource fixtures escaped detection              |
| Process/timer/worker isolation   |    1 | Subprocess entry points, timer-module schedulers, promise schedulers, and Worker construction escaped detection |
| Direct constructor isolation     |    1 | CommonJS/ESM direct `ChildProcess` launches returned clean while fixture-owned external targets changed         |
| Process-listener cleanup         |    1 | An imported exit listener wrote an external sentinel after the probe restored its write guards                  |
| Sequential runtime environments  |    1 | A missing settings file inherited the previous model, review interval, and initialized AI client                |
| Failed listen and close cleanup  |    1 | An occupied port left app timers/database open; close rejection skipped app/database cleanup                    |
| Partial startup allocation       |    1 | Second rate-limit and scheduler allocations each left one created timer uncleared                               |

After implementation, the focused Node test command passes `21/21`: thirteen
probe regression fixtures, one production-module import check, two sequential
runtime-state checks, and five startup/listener/runtime-close lifecycle checks.
The probe compares exact baseline handle identities and the complete
resource-type multiset after event-loop settling; it uses no resource-type
allowlist. Denied subprocess reports retain only fixed operation labels, never
commands, arguments, options, paths, or environment values.
Imported process listeners are likewise reported only as `process.listener`;
listener event names, callback identities, targets, and captured values are
not serialized.

## Task 3 configuration and platform commands

All Task 3 commands used Node `24.18.0`. RED output is summarized without
absolute paths, credentials, storage contents, certificate material, or
command output from platform adapters.

| Repository command                                                          |    Exit | Result                                                                                                       |
| --------------------------------------------------------------------------- | ------: | ------------------------------------------------------------------------------------------------------------ |
| `node --test backend/src/config/create-config.test.js` before modules       |       1 | Expected RED: `0/56`; the configuration module did not exist                                                 |
| `node --test backend/src/platform/*.test.js` before modules                 |       1 | Expected RED: `0/14` top-level tests; the platform modules did not exist                                     |
| `node --test scripts/validation/workspace-contract.test.mjs` before scripts |       1 | Expected RED: `5/6`; the root backend-suite script was missing                                               |
| Focused dangling-junction regression before fix                             |       1 | Expected RED: `0/1`; a dangling link was treated as an absent component                                      |
| Focused structured-ACL readback regressions before fix                      |       1 | Expected RED: `0/10`; unsafe and ambiguous Windows ACL readbacks were accepted                               |
| Focused linked-ancestor and target-swap regressions before fix              |       1 | Expected RED: `0/3`; mutation remained reachable after linked ancestry or path replacement                   |
| Focused trusted-root, dangling-link, and reparse regressions before fix     |       1 | Expected RED: `0/4`; trusted containment and injected reparse metadata were not enforced                     |
| `node --test backend/src/config/create-config.test.js`                      |       0 | GREEN: configuration contract `57/57`; zero skips                                                            |
| `node --test backend/src/platform/*.test.js`                                |       0 | GREEN: platform contracts and locked-target adapter cases `48/48`; zero skips                                |
| `node --test scripts/validation/workspace-contract.test.mjs`                |       0 | GREEN: workspace and backend test-script contract `6/6`                                                      |
| `npm --workspace backend test`                                              |       0 | Complete backend suite `190/190`; inherited `85/85` preserved; zero skips                                    |
| `npm run verify`                                                            |       0 | Full repository gate passed, including Secretlint, hygiene, lint, format, all tests, build, and requirements |
| `npm audit --omit=dev`                                                      | not run | Environment declined external metadata submission; Task 2 result remains `0`                                 |
| `npm audit`                                                                 | not run | Environment declined external metadata submission; Task 2 result remains `16` high and `0` critical          |

## Historical Jest baseline

The earlier Stage 1 Jest baseline emitted the known `TCPSERVERWRAP` and
`Timeout` open-handle diagnostic. That historical warning does not describe
the current Task 2 Node test runner.

## Task 4 canonical migration commands

All Task 4 commands used Node `24.18.0`. Results retain only test counts and
stable error classifications; they omit database paths, row content, and raw
migration checksums.

| Repository command                                                 | Exit | Result                                                                                                         |
| ------------------------------------------------------------------ | ---: | -------------------------------------------------------------------------------------------------------------- |
| `node --test backend/src/database/*.test.js` before implementation |    1 | Expected RED: `0/21`; the opener and migration-runner modules did not exist                                    |
| Focused non-contiguous future-version regression before fix        |    1 | Expected RED: `0/1`; corrupt future history returned the history error instead of the safe newer-version error |
| Focused connection-endpoint uniqueness contract before index       |    1 | Expected RED: `0/1`; the live endpoint uniqueness index was absent                                             |
| Focused lazy native-dependency import regression before fix        |    1 | Expected RED: `0/1`; importing the opener loaded the native database dependency                                |
| Focused exact relational contract before map population            |    1 | Expected RED: `0/1`; all `26` relational tables were required while the exact expectation maps were empty      |
| Focused Task 4 quality regressions before fixes                    |    1 | Expected RED: `24/26` failed across ownership, transaction escape, permissions, sidecars, close, and indexes   |
| `npm run test:migrations`                                          |    0 | GREEN: canonical opener, runner, exact schema, concurrency, and FTS contracts `88/88`; zero skips              |
| `npm --workspace backend test`                                     |    0 | Complete backend suite `278/278`; inherited `190/190` preserved; zero skips                                    |
| `npm run lint`                                                     |    0 | Backend lint completed with zero warnings                                                                      |
| `npm run format:check`                                             |    0 | All configured files matched repository formatting                                                             |
| `npm run verify`                                                   |    0 | Full root gate passed under Node `24.18.0`, including Secretlint, hygiene, tests, build, and requirements      |
| `npm audit --omit=dev`                                             |  n/a | Not run without destination-specific external approval; last verified Task 2 production result remains `0`     |

The migration runner hashes the exact SQL bytes with SHA-256, validates every
applied version, name, and checksum before applying pending work, and
revalidates inside each `BEGIN IMMEDIATE` transaction. A real two-connection
busy-timeout test returns the stable `MIGRATION_BUSY` error without creating a
migration table or row. Failed SQL leaves the failed migration's schema and
history row absent, while prior committed migrations remain intact.

The opener is import-inert and loads the native SQLite dependency only when
called. Writable databases enforce foreign keys, WAL, the configured busy
timeout, parent-directory restriction before native open, main-file and
existing WAL/SHM restriction after configuration, and retryable idempotent
close.
Readonly databases require an existing safe target, enable query-only mode,
and reject writes. Exact absolute paths, existing regular parents, and
unlinked ancestry/targets are enforced without creating directories.

The canonical three-migration schema exposes the required tables, owner
relationships, UTC integer-millisecond timestamps, revisions, tombstones,
state checks, deduplication and covering indexes, and FTS5 item search.
Composite owner/parent foreign keys reject all tested cross-profile
relationships, including nullable sync references whose parent deletion still
clears only the optional reference. Transaction-control and attachment
statements are rejected before any migration SQL executes, while comments,
strings, quoted identifiers, and trigger bodies remain valid.
The exact contract freezes ordered columns for all `27` relational tables,
every named and SQLite-generated automatic index with ordered columns and
uniqueness, every `index_xinfo` key/collation/direction term, normalized index
creation SQL and partial predicate, every foreign-key action, and the migration
metadata primary key.
FTS coverage separately freezes the public virtual-table columns and five
internal shadow tables. The PRAGMA audit found no SQL mismatch, so no migration
bytes changed during the initial exact-contract audit. The later quality pass
intentionally updated the unreleased canonical migration bytes for composite
ownership constraints and parent keys. Behavior tests cover insert, content
update, tombstone exclusion, restore, and delete synchronization.
`database/setup.sql` is documented as a legacy PostgreSQL/Supabase reference
and is not a runtime migration source.

## Task 5 frozen-contract commands

All GREEN commands in this section use the pinned Node `24.18.0` runtime.
Machine-local runtime and cache paths are omitted. Results contain only test
counts, stable failure classifications, and public-contract checksums.

| Repository command                                                       | Exit | Result                                                                                                               |
| ------------------------------------------------------------------------ | ---: | -------------------------------------------------------------------------------------------------------------------- |
| `npm --workspace @easy-rewind/contracts test` before package             |    1 | Expected RED: the contracts workspace did not exist                                                                  |
| `node --test packages/contracts/test/*.test.js` before implementation    |    1 | Expected RED: `1/19` passed; public modules, canonical schemas, generator, and independence validator were absent    |
| `node --test packages/contracts/test/contracts.test.js` after validators |    1 | Intermediate GREEN `14/17`; only the missing deterministic OpenAPI generator kept three drift tests RED              |
| Root workspace-contract test before manifest wiring                      |    1 | Expected RED: `4/6`; contracts workspace and root `test:contracts` script were absent                                |
| Cross-contract reminder-state test before schema alignment               |    1 | Expected RED: `4/6`; database CHECK rejected exported `due` and `failed` states while unrelated state checks passed  |
| Cross-contract reminder-state test after schema alignment                |    0 | GREEN: all six exported reminder states accepted, unknown state rejected, and other exact vocabularies passed `6/6`  |
| Prototype-polluted reminder transition before safety guard               |    1 | Expected RED: the custom transition validator accepted a non-JSON prototype                                          |
| Prototype-polluted reminder transition after safety guard                |    0 | GREEN: the shared safe-value inspection rejects non-JSON prototypes                                                  |
| First complete root gate after workspace wiring                          |    1 | Integration RED: requirements passed `17/18`; its frozen root verify string omitted the contracts suffix             |
| Bounded pairing and sync semantics before implementation                 |    1 | Expected RED: `13/20` passed; seven cases exposed the specified payload, QR, sequencing, result, and pull gaps       |
| Hook and link-local regressions before hardening                         |    1 | Expected RED: focused `0/2`; link-local endpoints passed and inherited `toJSON` bypassed the payload bound           |
| Hook-free measurement and endpoint-scope regressions after hardening     |    0 | GREEN: focused pairing, exact-bound, hook, and unsafe-payload coverage passed `4/4`; the hook call count stayed zero |
| `npm run test:contracts`                                                 |    0 | GREEN: strict schemas, bounded pairing/sync semantics, OpenAPI drift, and independence passed `23/23`; zero skips    |
| `npm run test:migrations`                                                |    0 | GREEN: canonical migration and exact schema contracts passed `88/88`; zero skips                                     |
| `npm --workspace backend test`                                           |    0 | GREEN: complete backend suite passed `278/278`; zero skips                                                           |
| `node --test scripts/validation/workspace-contract.test.mjs`             |    0 | GREEN: workspace, exact dependency pins, scripts, and isolation contract passed `6/6`                                |
| OpenAPI generator `--check`                                              |    0 | Generated and committed OpenAPI bytes matched exactly                                                                |
| `npm run verify`                                                         |    0 | Full root gate passed all suites with zero failures and zero skips                                                   |

The deterministic public fingerprints are:

- Schema bundle SHA-256:
  `9c5292808862a88cb1035f6431456e5776442de0086e321769e1b892a815d145`
- OpenAPI SHA-256:
  `c58423ce97f8f2960ccc11e7d2fd828b3360a114ca01861a4c7fce17fbceb450`

Task 5 did not run an external npm audit. The last verified Task 2 production
result remains `0` vulnerabilities, and the last verified full development
result remains `16` high and `0` critical.

## Stage 2 requirement commands

These are the stable commands recorded in the requirements ledger. `pending`
means the command or its Stage 2 implementation does not exist yet; this file
does not claim a passing result.

| Scope                         | Command                                            | Baseline state                                          |
| ----------------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| Requirements ledger           | `npm run test:requirements`                        | `18/18` passed                                          |
| Lifecycle and execution modes | `npm run test:lifecycle`                           | `10/10` passed; zero skips                              |
| Canonical schema/migrations   | `npm run test:migrations`                          | `88/88` passed; zero skips                              |
| Frozen API contracts          | `npm run test:contracts`                           | `23/23` passed; zero skips                              |
| Authentication                | `node --test backend/src/auth/auth.test.js`        | `7/7` passed; zero skips                                |
| Legacy migration/rollback     | `node --test backend/src/legacy/migration.test.js` | pending                                                 |
| Native Electron ABI           | `npm --workspace desktop run rebuild:native`       | failing                                                 |
| Quarantine exclusions         | `npm run check:hygiene`                            | Stage 1 implementation exists; Stage 2 coverage pending |
| Secret scan                   | `npm run scan:secrets`                             | passed                                                  |

## Task 6 local-authentication commands

All commands used the pinned Node `24.18.0` runtime. Task 6 added no listener
or Electron dependency.

| Repository command                                                                       | Exit | Result                                                                                                                                         |
| ---------------------------------------------------------------------------------------- | ---: | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --test backend/src/auth/auth.test.js` before implementation                        |    1 | Expected RED: all seven tests failed because the authentication, session, pairing, and middleware modules were absent                          |
| `node --test backend/src/auth/auth.test.js` after implementation                         |    0 | GREEN: install-token, rotation, browser-session, CSRF, pairing, revocation, constant-time, and owner-context coverage passed `7/7`; zero skips |
| `node --test backend/src/database/schema-contract.test.js backend/src/auth/auth.test.js` |    0 | GREEN: authentication and the expanded exact schema contract passed `45/45`; zero skips                                                        |
| `npm --workspace backend test`                                                           |    0 | GREEN: complete backend suite passed `286/286`; zero skips                                                                                     |
| `npm --workspace backend run lint`                                                       |    0 | GREEN: backend ESLint completed with zero warnings                                                                                             |

SQLite stores only versioned keyed HMAC-SHA-256 digests for installation,
browser-session, CSRF, pairing-challenge, and device credentials. The
recoverable installation token is stored only through the injected protected
secret-store reference. Installation bearer credentials are loopback-only.
Browser sessions are bound to an exact loopback origin, expire after a bounded
TTL, use HttpOnly SameSite=Strict cookies, and require a separate CSRF token
for mutation methods.

Android pairing creates a pending device and an expiring challenge without
activating it. The desktop profile owner must explicitly confirm the
challenge; credential issuance transactionally consumes it once, activates
the device, and returns a 256-bit device bearer only once. Revocation changes
both device and credential state. Service responses pass the frozen pairing
contract validators. Request middleware derives immutable profile ownership
from authenticated context and rejects body, query, path, or legacy header
owner overrides.

## Task 7 shared-lifecycle commands

All commands used the pinned Node `24.18.0` runtime. The lifecycle and HTTP
modules remain Electron-independent and import-inert.

| Repository command                                                                            | Exit | Result                                                                                                                         |
| --------------------------------------------------------------------------------------------- | ---: | ------------------------------------------------------------------------------------------------------------------------------ |
| `node --test backend/src/lifecycle/create-runtime.test.js` before implementation              |    1 | Expected RED: all seven initial cases failed because runtime, application, listener, health, and scheduler modules were absent |
| `node --test backend/src/lifecycle/create-runtime.test.js backend/test/import-safety.test.js` |    0 | GREEN: lifecycle, contract-valid health, scheduler, standalone signals, and inert imports passed `10/10`; zero skips           |
| Lifecycle tests plus `backend/test/server-lifecycle.test.js`                                  |    0 | GREEN: new shared lifecycle and retained compatibility-lifecycle coverage passed `14/14`; zero skips                           |
| `npm --workspace backend run lint`                                                            |    0 | GREEN: backend ESLint completed with zero warnings                                                                             |
| `npm --workspace backend test`                                                                |    0 | GREEN: complete backend suite passed `295/295`; zero skips                                                                     |

`createRuntime(config, adapters)` now owns database opening and migration,
application composition, optional loopback listening, scheduler startup, and
optional LAN-gateway startup. Test mode uses the same runtime with listeners
and schedulers disabled. Stop first rejects new requests, drains bounded
in-flight work, then stops schedulers and LAN work before closing the HTTP
listener, application resources, and database. Concurrent stops share one
promise; completed runtimes can start again; failed starts roll back created
resources in reverse order while preserving the startup error.

The `/v1/health` implementation matches the frozen contract and reports only
version, schema/API versions, execution mode, component readiness, and the
legacy-migration-available flag. Component error text, storage paths, host
details, keys, and row data are discarded. The standalone signal owner uses
the shared lifecycle, while the thin root entry point keeps a lazy legacy
route adapter until Task 11 replaces those routes.

## Known native-rebuild diagnostic

The failing production script places the staging manifest one directory above
the value passed as `--module-dir`. A diagnostic with the manifest copied into
that module directory rebuilt `better-sqlite3` successfully. The production
script remains unchanged and failing in this baseline.

## Recovery boundary

If later Stage 2 migration work fails, close all runtime resources, verify the
pre-migration runtime backup, restore it to a new path, and rerun integrity
checks with listeners and schedulers disabled. Never open, overwrite, restore
onto, or mutate the sole quarantine copy.

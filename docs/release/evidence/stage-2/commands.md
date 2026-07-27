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

| Repository command                                                          |    Exit | Result                                                                                              |
| --------------------------------------------------------------------------- | ------: | --------------------------------------------------------------------------------------------------- |
| `node --test backend/src/config/create-config.test.js` before modules       |       1 | Expected RED: `0/56`; the configuration module did not exist                                        |
| `node --test backend/src/platform/*.test.js` before modules                 |       1 | Expected RED: `0/14` top-level tests; the platform modules did not exist                            |
| `node --test scripts/validation/workspace-contract.test.mjs` before scripts |       1 | Expected RED: `5/6`; the root backend-suite script was missing                                      |
| Focused dangling-junction regression before fix                             |       1 | Expected RED: `0/1`; a dangling link was treated as an absent component                             |
| `node --test backend/src/config/create-config.test.js`                      |       0 | GREEN: configuration contract `57/57`; zero skips                                                   |
| `node --test backend/src/platform/*.test.js`                                |       0 | GREEN: platform contracts and adapter cases `31/31`; zero skips                                     |
| `node --test scripts/validation/workspace-contract.test.mjs`                |       0 | GREEN: workspace and backend test-script contract `6/6`                                             |
| `npm --workspace backend test`                                              |       0 | Complete backend suite `173/173`; inherited `85/85` preserved; zero skips                           |
| `npm audit --omit=dev`                                                      | not run | Environment declined external metadata submission; Task 2 result remains `0`                        |
| `npm audit`                                                                 | not run | Environment declined external metadata submission; Task 2 result remains `16` high and `0` critical |

## Historical Jest baseline

The earlier Stage 1 Jest baseline emitted the known `TCPSERVERWRAP` and
`Timeout` open-handle diagnostic. That historical warning does not describe
the current Task 2 Node test runner.

## Stage 2 requirement commands

These are the stable commands recorded in the requirements ledger. `pending`
means the command or its Stage 2 implementation does not exist yet; this file
does not claim a passing result.

| Scope                         | Command                                            | Baseline state                                          |
| ----------------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| Requirements ledger           | `npm run test:requirements`                        | `18/18` passed                                          |
| Lifecycle and execution modes | `npm run test:lifecycle`                           | pending                                                 |
| Canonical schema/migrations   | `npm run test:migrations`                          | pending                                                 |
| Frozen API contracts          | `npm run test:contracts`                           | pending                                                 |
| Authentication                | `node --test backend/src/auth/auth.test.js`        | pending                                                 |
| Legacy migration/rollback     | `node --test backend/src/legacy/migration.test.js` | pending                                                 |
| Native Electron ABI           | `npm --workspace desktop run rebuild:native`       | failing                                                 |
| Quarantine exclusions         | `npm run check:hygiene`                            | Stage 1 implementation exists; Stage 2 coverage pending |
| Secret scan                   | `npm run scan:secrets`                             | passed                                                  |

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

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

The successful legacy backend tests emitted the known `TCPSERVERWRAP` and
`Timeout` open-handle warning. The version query used only an in-memory
database.

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

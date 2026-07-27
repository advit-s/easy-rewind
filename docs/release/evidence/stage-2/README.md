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

## Native ABI finding

The real Electron native rebuild is currently failing. The staging script
writes its generated `package.json` at the staging root but invokes
`@electron/rebuild` with the staging `node_modules` directory as
`--module-dir`. A bounded diagnostic copied the generated manifest into that
module directory and then rebuilt `better-sqlite3` successfully. That
diagnostic narrows the staging-layout defect; it does not count as the final
script fix or Electron ABI acceptance evidence.

## External release blocker

Gemini provider revocation remains externally unconfirmed. Repository cleanup,
secret scanning, history rewriting, and the preserved quarantine are not
credential revocation. Release remains blocked until provider-side revocation
is confirmed through an authorized external record.

## Requirement status vocabulary

- `not-started`: implementation work has not begun.
- `failing`: a reproducible check currently fails.
- `implemented`: implementation exists but required verification is incomplete.
- `verified`: the required executable or authorized manual evidence passes.
- `blocked`: an identified external dependency or authority remains unresolved.

## Baseline decision

Stage 2 is open. The requirements ledger records unimplemented work as
`not-started`, the native ABI defect as `failing`, and external credential
revocation as `blocked`. Later tasks must replace those states only with
matching executable or authorized manual evidence.

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

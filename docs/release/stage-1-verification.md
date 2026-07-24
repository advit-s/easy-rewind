# Stage 1 Verification Report

| Field | Value |
| --- | --- |
| Date | 2026-07-24 |
| Operator | Codex local containment run; Windows account intentionally not recorded |
| Repository commit | Containment tooling reviewed at `a646b27eb0449f8fc2d3f43191895c9e39acbc0b` |
| Node | `v24.13.0` observed; Stage 1 runtime selection remains pending |
| npm | `11.6.2` observed; Stage 1 workspace normalization remains pending |

## Safe reporting

Never paste credentials/key values, `.env`, settings, database, or manifest contents, personal records, or raw secret-scan excerpts into this report. Exact sanitized commands with environment-relative arguments are permitted; unsanitized command lines containing secrets or personal paths are prohibited. Record exit codes/counts, redacted or environment-relative paths (for example, `%LOCALAPPDATA%\easy-rewind\legacy-backup\<timestamp>`), commit/artifact references, and private incident-record references only.

## Safety preflight

- [x] Exact repository root recorded privately and passed to the reviewed tooling.
- [x] Matching Easy Rewind processes identified/stopped: confirmed `0`, unresolved `0`, port-5000 listeners `0`, stopped `0`; the same zero counts were reverified.
- [x] No unrelated Node/Electron process stopped.
- [x] SQLite database not opened by Stage 1 tooling.

The first live invocation failed closed with zero quarantine artifacts, no pointer, and all four sources preserved. The path-policy root cause was diagnosed, covered by regression tests, fixed, and independently reviewed before the single authorized retry documented below.

## Quarantine evidence

| Field | Value |
| --- | --- |
| Quarantine directory | `%LOCALAPPDATA%\easy-rewind\legacy-backup\20260724T120608217Z` |
| Manifest path | `%LOCALAPPDATA%\easy-rewind\legacy-backup\20260724T120608217Z\manifest.json`; the private `%TEMP%` pointer contains only this path |
| Backup UTC | Validated UTC value retained in the protected manifest |
| Source file count | Exactly 4 copied and independently verified |
| Owner | Current Windows user SID; identity value intentionally not recorded |
| Inheritance disabled | Verified on the timestamp directory, four copied files, and manifest (`6/6`) |
| Unexpected ACL entries | `0`; every verified object grants access only to the current user |

| Source | Hash/size result | Safe evidence reference |
| --- | --- | --- |
| DB | Size and SHA-256 match held-source manifest record and quarantine copy | Live containment aggregate: `4/4` |
| WAL | Size and SHA-256 match held-source manifest record and quarantine copy | Live containment aggregate: `4/4` |
| SHM | Size and SHA-256 match held-source manifest record and quarantine copy | Live containment aggregate: `4/4` |
| Settings | Size and SHA-256 match held-source manifest record and quarantine copy | Live containment aggregate: `4/4` |

The manifest was independently validated as UTF-8 without BOM, `sensitive=true`, `sqliteOpened=false`, with the required warning, UTC backup time, exact four-file set, and direct-child quarantine containment. After the producing process exited, all five backup artifacts survived; all four copied files were rehashed successfully before purge.

## Purge evidence

| Forbidden target | Complete | Result | Safe evidence reference |
| --- | --- | --- | --- |
| `backend/data/easy-rewind.db` | - [x] | Manifest-bound purge; absence verified | Live containment aggregate: `4/4` absent |
| `backend/data/easy-rewind.db-wal` | - [x] | Manifest-bound purge; absence verified | Live containment aggregate: `4/4` absent |
| `backend/data/easy-rewind.db-shm` | - [x] | Manifest-bound purge; absence verified | Live containment aggregate: `4/4` absent |
| `backend/data/settings.json` | - [x] | Manifest-bound purge; absence verified | Live containment aggregate: `4/4` absent |
| `backend/.env` | - [ ] |  |  |
| `backend/.git` | - [ ] |  |  |
| Generated `node_modules` before install | - [ ] |  |  |
| `tmp_test.js` | - [ ] |  |  |

The purge reported exactly four removals. Post-purge verification found all four manifest-bound originals absent while all five quarantine artifacts remained present; all four backup hashes still matched the protected manifest and the pointer remained valid.

## Workspace evidence

| Command | Exit | Evidence summary |
| --- | --- | --- |
| `node --version` |  |  |
| `npm --version` |  |  |
| `npm ci` |  |  |
| `npm run scan:secrets` |  |  |
| `npm run check:hygiene` |  |  |
| `npm run lint` |  |  |
| `npm run format:check` |  |  |
| `npm test` |  |  |
| `npm run verify` |  |  |

## Recovery rehearsal

- [ ] A disposable copy was created without opening the preserved copy through SQLite.
- [ ] All four hashes were verified in the disposable copy.
- [ ] The disposable copy was removed safely.
- [ ] The preserved quarantine was reverified unchanged afterward.
- [ ] Neither copy was opened through SQLite.
- [ ] Recovery was documented.

## External actions

| Action | Complete | Status (`pending`/`blocked`/`verified`) | Verified UTC | Operator/reference | Safe evidence |
| --- | --- | --- | --- | --- | --- |
| Exposed Gemini key revoked | - [ ] | `pending` |  |  | Private incident-record reference only; the key itself is never recorded |
| Replacement key not stored in repository or quarantine | - [ ] | `pending` |  |  | Private incident-record reference only; the key itself is never recorded |
| Git-history rewrite performed separately | - [ ] | `pending` |  |  | Commit/artifact or private incident-record reference only |

The rewrite is separate. `scheduled` is not `verified`. The Complete checkbox must remain unchecked unless Status is `verified` and Verified UTC, operator/private reference, and safe evidence are all populated. Blank, `pending`, `blocked`, unchecked, contradictory, or incompletely evidenced rows force the Stage 1 decision to **FAIL**; only checked + `verified` + complete evidence permits **PASS**.

## Exit gate

| Field | Value |
| --- | --- |
| Tests | Containment suite `21/21` passed immediately before the live retry; complete Stage 1 verification remains pending |
| Verification evidence | Live quarantine, ACL, manifest, coherent hash/size, purge, survival, and post-purge checks passed |
| Release blockers in Stage 1 scope | Workspace hygiene/normalization, recovery rehearsal, key revocation, and separate Git-history purge remain unresolved |
| Rollback/recovery | The only preserved quarantine remains intact; recovery rehearsal must use a disposable copy and is pending |
| Requirement matrix updated | Task 4 containment rows updated below; remaining Stage 1 rows are not promoted |
| Decision PASS/FAIL | **FAIL** — Task 4 passed, but the Stage 1 exit gate is not yet satisfied |

Before a requirement-matrix row can be marked `verified`, record stable report section, repository commit, and artifact references for its evidence and recovery.

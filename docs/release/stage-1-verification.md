# Stage 1 Verification Report

| Field | Value |
| --- | --- |
| Date |  |
| Operator |  |
| Repository commit |  |
| Node |  |
| npm |  |

## Safe reporting

Never paste credentials/key values, `.env`, settings, database, or manifest contents, personal records, or raw secret-scan excerpts into this report. Exact sanitized commands with environment-relative arguments are permitted; unsanitized command lines containing secrets or personal paths are prohibited. Record exit codes/counts, redacted or environment-relative paths (for example, `%LOCALAPPDATA%\easy-rewind\legacy-backup\<timestamp>`), commit/artifact references, and private incident-record references only.

## Safety preflight

- [ ] Exact repository root recorded.
- [ ] Matching Easy Rewind processes identified/stopped.
- [ ] No unrelated Node/Electron process stopped.
- [ ] SQLite database not opened by Stage 1 tooling.

## Quarantine evidence

| Field | Value |
| --- | --- |
| Quarantine directory |  |
| Manifest path |  |
| Backup UTC |  |
| Source file count | Exactly 4 required |
| Owner |  |
| Inheritance disabled |  |
| Unexpected ACL entries |  |

| Source | Hash/size result | Safe evidence reference |
| --- | --- | --- |
| DB |  |  |
| WAL |  |  |
| SHM |  |  |
| Settings |  |  |

## Purge evidence

| Forbidden target | Complete | Result | Safe evidence reference |
| --- | --- | --- | --- |
| `backend/data/easy-rewind.db` | - [ ] |  |  |
| `backend/data/easy-rewind.db-wal` | - [ ] |  |  |
| `backend/data/easy-rewind.db-shm` | - [ ] |  |  |
| `backend/data/settings.json` | - [ ] |  |  |
| `backend/.env` | - [ ] |  |  |
| `backend/.git` | - [ ] |  |  |
| Generated `node_modules` before install | - [ ] |  |  |
| `tmp_test.js` | - [ ] |  |  |

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
| Tests |  |
| Verification evidence |  |
| Release blockers in Stage 1 scope |  |
| Rollback/recovery |  |
| Requirement matrix updated |  |
| Decision PASS/FAIL |  |

Before a requirement-matrix row can be marked `verified`, record stable report section, repository commit, and artifact references for its evidence and recovery.

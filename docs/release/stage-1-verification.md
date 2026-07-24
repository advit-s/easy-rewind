# Stage 1 Verification Report

| Field | Value |
| --- | --- |
| Date |  |
| Operator |  |
| Repository commit |  |
| Node |  |
| npm |  |

## Safe reporting

Never paste credentials/key values, `.env`, settings, database, or manifest contents, personal records, raw secret-scan excerpts, or raw command lines into this report. Record exit codes/counts, redacted or environment-relative paths (for example, `%LOCALAPPDATA%\\easy-rewind\\legacy-backup\\<timestamp>`), commit/artifact references, and private incident-record references only.

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

| Forbidden target | Result | Safe evidence reference |
| --- | --- | --- |
| DB |  |  |
| WAL |  |  |
| SHM |  |  |
| Settings |  |  |
| Real `.env` |  |  |
| Nested `backend/.git` |  |  |
| Generated `node_modules` before clean install |  |  |
| Obsolete temporary script |  |  |

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

| Action | Status (`pending`/`blocked`/`verified`) | Verified UTC | Operator/reference | Safe evidence |
| --- | --- | --- | --- | --- |
| Gemini key revocation and protected-channel replacement |  |  |  | Private incident-record reference only; the key itself is never recorded |
| Git-history remediation |  |  |  | Commit/artifact or private incident-record reference only |

`scheduled` is not `verified`. Pending or blocked Gemini revocation or Git-history remediation forces the Stage 1 decision to **FAIL**.

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

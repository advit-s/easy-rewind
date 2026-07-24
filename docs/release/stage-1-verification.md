# Stage 1 Verification Report

| Field | Value |
| --- | --- |
| Date |  |
| Operator |  |
| Repository commit |  |
| Node |  |
| npm |  |

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
| Source file count |  |
| Hash/size verification |  |
| Owner |  |
| Inheritance disabled |  |
| Unexpected ACL entries |  |

## Purge evidence

- [ ] Legacy DB/WAL/SHM/settings/real `.env` absent.
- [ ] Nested `backend/.git` absent.
- [ ] Repository `node_modules` absent before clean install.
- [ ] Obsolete temporary script absent.

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

- [ ] Manifest reverifies.
- [ ] Separate disposable copy can be created without opening preserved copy.
- [ ] Only preserved copy unmodified.
- [ ] Recovery documented.

## External actions

- [ ] Exposed Gemini key revoked.
- [ ] Replacement not stored in repository/quarantine.
- [ ] Git-history rewrite scheduled/performed separately.

## Exit gate

| Field | Value |
| --- | --- |
| Tests |  |
| Verification evidence |  |
| Release blockers in Stage 1 scope |  |
| Rollback/recovery |  |
| Requirement matrix updated |  |
| Decision PASS/FAIL |  |

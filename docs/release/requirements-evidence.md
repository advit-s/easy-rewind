# Easy Rewind Requirement-to-Evidence Matrix

Statuses:

- `not-started` = no implementation work begun.
- `failing` = requirement represented by a reproducible failing check/test.
- `implemented` = code/docs exist but required verification is incomplete.
- `verified` = required executable/manual evidence passes and recovery is recorded.
- `blocked` = cannot proceed due to named unresolved dependency/authority/external action.

| ID | Requirement | Stage | Status | Implementation | Test/command | Evidence | Recovery |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S1-01 | Stop only Easy Rewind backend/Electron processes before backup | Stage 1 | not-started | `scripts/legacy/quarantine-legacy.ps1` | `npm run test:containment` | Stage 1 report | Relaunch only after purge |
| S1-02 | Copy DB/WAL/SHM/settings together before opening SQLite | Stage 1 | not-started | containment script | fixture and live manifest checks | quarantine manifest | Preserve quarantine |
| S1-03 | Restrict quarantine to current Windows user | Stage 1 | not-started | containment script | ACL assertion and `Get-Acl` | Stage 1 report | Abort before purge |
| S1-04 | Record UTC backup time, source paths, sizes, SHA-256 | Stage 1 | not-started | containment script | manifest assertions | `manifest.json` | Abort on mismatch; preserve the failed destination/manifest as evidence or discard the invalid destination safely as appropriate, then repeat the complete coherent copy into a new timestamp without mutating or regenerating the old manifest |
| S1-05 | Exclude sensitive/runtime data from Git, builds, exports, logs, tests | Stage 1 | not-started | ignores and hygiene checker | `npm run check:hygiene` | Stage 1 report | Restore ignore rules |
| S1-06 | Purge DB/WAL/SHM/settings and real `.env` from worktree | Stage 1 | not-started | purge script and exact removal | source absence assertions | Stage 1 report | Recover data only through a disposable verified quarantine copy; recreate non-secret configuration from `.env.example` and provision a replacement key through the protected channel—never imply that `.env` is in quarantine |
| S1-07 | Remove nested Git repository and generated dependencies | Stage 1 | not-started | exact cleanup commands | hygiene checker | Stage 1 report | Reinstall with `npm ci` |
| S1-08 | Add placeholder-only `.env.example` | Stage 1 | not-started | `backend/.env.example` | Secretlint | Stage 1 report | Recreate from tracked example |
| S1-09 | Select Node LTS, engines, exact dependency pins, one lockfile | Stage 1 | not-started | workspace manifests | `npm ci` and version checks | Stage 1 report | Revert manifests/lock together |
| S1-10 | Root scripts install, develop, lint, format, unit/integration test, validate extension, build, package Windows, verify, and scan | Stage 1 | not-started | root `package.json` | `npm run verify` | Stage 1 report | Run component commands directly |
| S1-11 | Add CI secret scanning and repository hygiene | Stage 1 | not-started | `.github/workflows/ci.yml` | workflow lint/readback | CI run URL | Revert CI separately |
| S1-12 | Document Git-history purge separately | Stage 1 | not-started | history guide | command review | Stage 1 report | Mirror backup before rewrite |
| S1-13 | Require Gemini key revocation and replacement | Stage 1 | not-started | credential response guide | manual confirmation | private incident-record reference | Revoke again if uncertain |
| S1-14 | Never migrate or import during Stage 1 | Stage 1 | not-started | design and containment boundary | source inspection | Stage 1 report | Stop and discard working copy |

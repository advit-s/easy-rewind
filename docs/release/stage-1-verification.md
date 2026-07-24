# Stage 1 Verification Report

| Field             | Value                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date              | 2026-07-25                                                                                                                                                                                                                                                                                                                                           |
| Operator          | Codex local containment run; Windows account intentionally not recorded                                                                                                                                                                                                                                                                              |
| Repository commit | Containment tooling reviewed at `a646b27eb0449f8fc2d3f43191895c9e39acbc0b`; Task 5 hygiene at `33dd03b6fb6554b7696bc5ca7c7b3ecbd2806fa9`; Task 6 workspace work at `ea2edcb`, `d814d06`, `9a7bb8e`, and `0d3fa59`; Task 7 CI/security work from `979e935` through `15a346e`; rewritten refs normalized at `6ea8a0eb33c8fa9e0505a91031d951acd2f4131b` |
| Node              | Portable `v24.18.0` verified for development, CI, and standalone execution; packaged Electron runtime validation remains Stage 6                                                                                                                                                                                                                     |
| npm               | Portable `11.6.2` verified; exact package-manager and engine contract enforced                                                                                                                                                                                                                                                                       |

## Safe reporting

Never paste credentials/key values, `.env`, settings, database, or manifest contents, personal records, or raw secret-scan excerpts into this report. Exact sanitized commands with environment-relative arguments are permitted; unsanitized command lines containing secrets or personal paths are prohibited. Record exit codes/counts, redacted or environment-relative paths (for example, `%LOCALAPPDATA%\easy-rewind\legacy-backup\<timestamp>`), commit/artifact references, and private incident-record references only.

## Safety preflight

- [x] Exact repository root recorded privately and passed to the reviewed tooling.
- [x] Matching Easy Rewind processes identified/stopped: confirmed `0`, unresolved `0`, port-5000 listeners `0`, stopped `0`; the same zero counts were reverified.
- [x] No unrelated Node/Electron process stopped.
- [x] SQLite database not opened by Stage 1 tooling.

The first live invocation failed closed with zero quarantine artifacts, no pointer, and all four sources preserved. The path-policy root cause was diagnosed, covered by regression tests, fixed, and independently reviewed before the single authorized retry documented below.

## Quarantine evidence

| Field                  | Value                                                                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quarantine directory   | `%LOCALAPPDATA%\easy-rewind\legacy-backup\20260724T120608217Z`                                                                                                                         |
| Manifest path          | `%LOCALAPPDATA%\easy-rewind\legacy-backup\20260724T120608217Z\manifest.json`; the transient private `%TEMP%` pointer was removed only after this exact path was recorded in the report |
| Backup UTC             | Validated UTC value retained in the protected manifest                                                                                                                                 |
| Source file count      | Exactly 4 copied and independently verified                                                                                                                                            |
| Owner                  | Current Windows user SID; identity value intentionally not recorded                                                                                                                    |
| Inheritance disabled   | Verified on the timestamp directory, four copied files, and manifest (`6/6`)                                                                                                           |
| Unexpected ACL entries | `0`; every verified object grants access only to the current user                                                                                                                      |

| Source   | Hash/size result                                                       | Safe evidence reference           |
| -------- | ---------------------------------------------------------------------- | --------------------------------- |
| DB       | Size and SHA-256 match held-source manifest record and quarantine copy | Live containment aggregate: `4/4` |
| WAL      | Size and SHA-256 match held-source manifest record and quarantine copy | Live containment aggregate: `4/4` |
| SHM      | Size and SHA-256 match held-source manifest record and quarantine copy | Live containment aggregate: `4/4` |
| Settings | Size and SHA-256 match held-source manifest record and quarantine copy | Live containment aggregate: `4/4` |

The manifest was independently validated as UTF-8 without BOM, `sensitive=true`, `sqliteOpened=false`, with the required warning, UTC backup time, exact four-file set, and direct-child quarantine containment. After the producing process exited, all five backup artifacts survived; all four copied files were rehashed successfully before purge.

## Purge evidence

| Forbidden target                        | Complete | Result                                                                          | Safe evidence reference                                 |
| --------------------------------------- | -------- | ------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `backend/data/easy-rewind.db`           | - [x]    | Manifest-bound purge; absence verified                                          | Live containment aggregate: `4/4` absent                |
| `backend/data/easy-rewind.db-wal`       | - [x]    | Manifest-bound purge; absence verified                                          | Live containment aggregate: `4/4` absent                |
| `backend/data/easy-rewind.db-shm`       | - [x]    | Manifest-bound purge; absence verified                                          | Live containment aggregate: `4/4` absent                |
| `backend/data/settings.json`            | - [x]    | Manifest-bound purge; absence verified                                          | Live containment aggregate: `4/4` absent                |
| `backend/.env`                          | - [x]    | Exact approved cleanup; existed before and absence verified after               | Task 5 exact pre/post path check                        |
| `backend/.git`                          | - [x]    | Exact approved cleanup; existed before and absence verified after               | Task 5 exact pre/post path check; root `.git` preserved |
| Generated `node_modules` before install | - [x]    | Exact `backend/node_modules` cleanup; existed before and absence verified after | Task 5 exact pre/post path check                        |
| `tmp_test.js`                           | - [x]    | Exact approved cleanup; existed before and absence verified after               | Task 5 exact pre/post path check                        |

The manifest-bound purge reported exactly four removals. Post-purge verification found all four manifest-bound originals absent while all five quarantine artifacts remained present; all four backup hashes still matched the protected manifest and the pointer remained valid. The later exact Task 5 cleanup found each of its four approved targets present before removal and absent afterward. It preserved the root `.git`, the quarantine, and the pointer. In the reviewed feature branch, `backend/data/.gitkeep` is the only tracked path below `backend/data`.

## Workspace evidence

| Command                                                      | Exit | Evidence summary                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --version`                                             | `0`  | Verified portable runtime returned `v24.18.0`                                                                                                                                                                                                   |
| `npm --version`                                              | `0`  | Verified portable runtime returned `11.6.2`                                                                                                                                                                                                     |
| `npm ci`                                                     | `0`  | Bounded removal of only the resolved root `node_modules` followed by a clean install added `831` packages, audited `834`, and reported `0` vulnerabilities                                                                                      |
| `npm ls --depth=0`                                           | `0`  | Dependency tree was clean; exact workspace pins included Nodemailer `9.0.3`                                                                                                                                                                     |
| `npm ls --all`                                               | `0`  | Complete dependency tree inspection passed after the clean install                                                                                                                                                                              |
| `npm audit --audit-level=high`                               | `0`  | Authorized online audit after the Nodemailer upgrade reported `0` vulnerabilities                                                                                                                                                               |
| Node-ABI `better-sqlite3` load smoke test                    | `0`  | Native module loaded under Node `24.18.0`; this is not Electron-ABI evidence                                                                                                                                                                    |
| `npm run scan:secrets`                                       | `0`  | Secretlint passed without recording raw scan output                                                                                                                                                                                             |
| `npm run check:hygiene`                                      | `0`  | Root hygiene command passed                                                                                                                                                                                                                     |
| `node --test scripts/hygiene/check-repository.test.mjs`      | `0`  | `63/63` passed, `0` failed, `0` skipped at `33dd03b`; spec and quality reviews passed                                                                                                                                                           |
| `node scripts/hygiene/check-repository.mjs`                  | `0`  | Git-mode repository hygiene check passed                                                                                                                                                                                                        |
| `node scripts/hygiene/check-repository.mjs --filesystem`     | `0`  | Filesystem-mode repository hygiene check passed without following linked directories                                                                                                                                                            |
| `git check-ignore --quiet -- docs/release/new-evidence.md`   | `1`  | Expected unignored result; release evidence remains eligible for tracking                                                                                                                                                                       |
| `git check-ignore --quiet -- release/artifact.zip`           | `0`  | Expected ignored result for repository-root release output                                                                                                                                                                                      |
| `npm run test:workspace`                                     | `0`  | `41/41` passed, including the Task 7 CI/security contract, staged Electron native-rebuild nonmutation/failure-cleanup tests, backend Electron-independence checks, isolated legacy-runner checks, extension validation, and workspace contracts |
| `node --test scripts/validation/stage1-ci-security.test.mjs` | `0`  | `14/14` passed; no remote CI execution or external provider action is inferred                                                                                                                                                                  |
| `npm run test:containment`                                   | `0`  | `21/21` passed                                                                                                                                                                                                                                  |
| `npm run test:hygiene`                                       | `0`  | `63/63` passed                                                                                                                                                                                                                                  |
| `npm run test:backend:legacy-safe`                           | `0`  | `57/57` passed; the existing Jest server/timer open-handle warning is recorded as Stage 2 lifecycle debt                                                                                                                                        |
| `npm run validate:extension`                                 | `0`  | Baseline validation passed for `11` extension references                                                                                                                                                                                        |
| `npm run lint`                                               | `0`  | Backend ESLint passed with `0` warnings under `--max-warnings=0`                                                                                                                                                                                |
| `npm run build`                                              | `0`  | Extension validation and backend/desktop syntax checks passed                                                                                                                                                                                   |
| `npm run format:check`                                       | `0`  | All configured files matched Prettier style                                                                                                                                                                                                     |
| `npm test`                                                   | `0`  | Unit/integration component suites passed with the counts recorded above                                                                                                                                                                         |
| `npm run verify`                                             | `0`  | Fresh aggregate gate passed: Secretlint, hygiene, lint, format, all recorded test suites, extension validation, and build                                                                                                                       |
| `git diff --check`                                           | `0`  | No whitespace errors before the evidence update                                                                                                                                                                                                 |
| `npm run package:windows`                                    |      | Real Electron native rebuild, packaging, and Windows validation are deferred to Stage 6                                                                                                                                                         |

Task 6 was implemented across `ea2edcb`, `d814d06`, `9a7bb8e`, and `0d3fa59`. Its final quality review reported no findings and readiness `yes`. The staged Electron rebuild tests prove that the shared Node binding is not mutated and that failed staging is cleaned; they do not substitute for rebuilding and loading `better-sqlite3` against Electron `43.2.0` or producing a Windows package in Stage 6.

## Recovery rehearsal

- [x] A disposable copy was created in a new repository-external temporary directory without opening the preserved copy through SQLite.
- [x] All four manifest-bound hashes were verified in the disposable copy (`4/4`).
- [x] The disposable directory was resolved beneath the Windows temporary root and removed safely; absence was verified.
- [x] The preserved quarantine was reverified unchanged afterward (`4/4` size/SHA-256 matches, protected ACL, `0` unexpected ACL entries).
- [x] Neither copy was opened through SQLite.
- [x] Recovery is documented here without file contents, hash values, or personal paths.

## Git-history remediation evidence

The history rewrite was performed as a separate, local-only action with
`git-filter-repo 2.47.0 --sensitive-data-removal`. Exact path-history checks
before the rewrite found `0` env, `3` database, `2` WAL, `2` SHM, and `2`
settings hits. After the rewrite, every live-ref path check and every
reachable-object check for those targets returned `0`.

| Ref                       | Pre-rewrite commit                         | Rewritten commit                                     |
| ------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| `main`                    | `154004087239f3028deab7ceee5116b0fb2cd894` | `7ddfa6f99466a512ee775d26bc964f7bc116094b`           |
| `codex/release-hardening` | `773f3949bb9cf49b4aab3b88ffe433a77a5b0c55` | `28989282ee3440359b1b4dc39986ce130dc5ae5f`           |
| line-ending normalization | not applicable                             | `6ea8a0eb33c8fa9e0505a91031d951acd2f4131b` (current) |

The pre-rewrite commit IDs above are evidence labels only and are no longer
reachable in the live repository. The rewritten refs and complete local
verification gate passed before the contaminated rollback/diagnostic incident
was permanently purged: workspace/security `41/41`, containment `21/21`,
hygiene `63/63`, backend `57/57`, Secretlint, lint, format, extension
validation, and build. `git fsck --full` then passed after the permanent purge.

The preserved quarantine was then reverified independently: all `4/4`
manifest-bound files matched their recorded sizes and SHA-256 hashes, and all
`6/6` protected ACL objects remained restricted as required. The live
repository has `0` remotes. Therefore no remote push, hosting-provider cache,
pull-request-ref, or LFS cleanup is claimed. Those provider actions, plus a
verified private vulnerability reporting contact, are not applicable to this
local-only Stage 1 repository and become explicit Stage 7 pre-publication
release blockers before any future remote publication.

## External actions

| Action                                                 | Complete | Status                                | Verified UTC               | Operator/reference            | Safe evidence                                                                                                   |
| ------------------------------------------------------ | -------- | ------------------------------------- | -------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Exposed Gemini key revoked                             | - [ ]    | `blocked`                             |                            |                               | Provider revocation reference is still required; the key itself is never recorded                               |
| Replacement key not stored in repository or quarantine | - [x]    | `verified`                            | `2026-07-24T22:11:32.228Z` | Local post-rewrite recheck    | No replacement was provisioned; current secret scan passed. The quarantine is not treated as secure key storage |
| Git-history rewrite performed separately               | - [x]    | `verified`                            | `2026-07-24T22:11:32.228Z` | Local history-remediation run | Exact ref mappings and zero-hit checks are recorded above                                                       |
| Provider-side history/cache/PR/LFS cleanup confirmed   | - [ ]    | `not-applicable` (local-only Stage 1) |                            | Live remote count `0`         | Stage 7 pre-publication blocker before any future remote publication                                            |
| Private vulnerability reporting/contact verified       | - [ ]    | `not-applicable` (local-only Stage 1) |                            | Local-only repository         | Stage 7 pre-publication blocker before any future remote publication                                            |

The rewrite is separate and verified locally; `scheduled` is not `verified`.
An applicable action may be checked complete only when its status, verified
UTC, operator/reference, and safe evidence are all populated. A
`not-applicable` row is outside the local Stage 1 gate but remains binding at
the stated later boundary. The blocked Gemini revocation row therefore keeps
the Stage 1 decision at **FAIL**.

## Exit gate

| Field                             | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests                             | Containment `21/21`, workspace/security `41/41`, hygiene `63/63`, and backend `57/57` passed; the known backend server/timer `TCPSERVERWRAP`/`Timeout` open handle remains explicitly recorded as Stage 2 lifecycle debt                                                                                                                                                                                                                                                                                                                                                                     |
| Verification evidence             | Live quarantine, protected ACL, manifest, coherent hash/size, purge, survival, exact Task 5 cleanup, normalized portable toolchain, bounded clean dependency reinstall, complete dependency tree, zero-vulnerability audit, Node-ABI native load, zero-warning lint, format, Task 7 CI/security contract, extension validation, Secretlint, hygiene, aggregate verify, build, disposable recovery, local Git-history remediation with zero post-rewrite hits, full fsck, and post-recovery/post-rewrite quarantine verification all passed locally; no remote CI/provider action is inferred |
| Release blockers in Stage 1 scope | Gemini provider revocation lacks provider confirmation. Real Electron native rebuild/package validation remains a Stage 6 obligation. Provider-side cache/PR/LFS cleanup and a verified private reporting contact are explicit Stage 7 pre-publication blockers, not applicable to this local-only Stage 1 repository with `0` remotes                                                                                                                                                                                                                                                       |
| Rollback/recovery                 | The only preserved quarantine remains intact and access-restricted; the rehearsal treated it as read-only, a disposable `4/4` hash-verified recovery copy was safely removed, and the quarantine passed the required post-recovery verification                                                                                                                                                                                                                                                                                                                                              |
| Requirement matrix updated        | S1-01 through S1-12 and S1-14 have implementation and local evidence; S1-12 includes the verified local-only history rewrite; S1-13 remains `blocked` only by unverified Gemini provider revocation                                                                                                                                                                                                                                                                                                                                                                                          |
| Decision PASS/FAIL                | **FAIL** — all applicable local Stage 1 checks, recovery rehearsal, replacement-absence checks, and Git-history remediation pass, but Gemini provider revocation remains unverified                                                                                                                                                                                                                                                                                                                                                                                                          |

Before a requirement-matrix row can be marked `verified`, record stable report section, repository commit, and artifact references for its evidence and recovery.

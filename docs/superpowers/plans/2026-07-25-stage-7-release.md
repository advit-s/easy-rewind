# Stage 7: CI, release artifacts, documentation, and acceptance

## Objective

Turn the implemented Windows, Chrome, dashboard, backend, and Android sources
into reproducible, inspectable release candidates. CI must fail closed when a
required suite is skipped, an artifact is missing, sensitive material is
detected, or a release blocker has not been resolved.

## Entry gate

- Stage 6 automated desktop, backend, native ABI, package validation, and
  Windows build commands pass.
- The generated Windows artifacts retain `UNSIGNED` in their filenames until
  Authenticode verification succeeds.
- Stage 1 provider-key revocation remains blocked unless a provider-side
  attestation exists; a local scan cannot clear it.

## Work packages

1. Pin Node.js 24.18.0, npm 11.6.2, Electron 43.2.0, Java, Android/Expo, and
   action revisions. Cache only reproducible dependency directories.
2. Run formatting, lint, audit, secret and hygiene scans, containment,
   database/migration, contracts, lifecycle, domain, jobs, remote fetch,
   import/export, sync, Chrome, dashboard, mobile, desktop, native ABI, and
   packaging gates.
3. Build Windows NSIS and portable artifacts, a disposable Chrome extension
   package, and Android artifacts. Inspect every archive/unpacked tree for
   credentials, runtime data, quarantine paths, tests, maps, and build
   contamination.
4. Generate SHA-256 manifests and retain redacted test/evidence summaries.
   Never upload databases, WAL/SHM files, logs, pairing credentials, hostnames,
   personal content, migration reports, or quarantine manifests.
5. Document installation, onboarding, dashboard/Chrome authorization, Android
   pairing, local-first offline behavior, synchronization, conflicts,
   revocation, backup, restore, migration, troubleshooting, signing, and
   release rollback.
6. On clean Windows and a physical Android device, install the artifacts,
   pair explicitly, make offline edits on both replicas, reconnect, preserve
   conflicts, converge, revoke the phone, exercise backup/restore, and
   uninstall without silently deleting user data.

Normal CI is split into `quality`, `backend`, `clients`,
`electron-package`, and dependent `artifact-checksums` jobs in
`.github/workflows/stage7-ci.yml`. It uploads only short-retention,
explicitly non-release client inputs and unsigned Windows packages. The
manual `.github/workflows/release-gate.yml` fails closed unless the exact
commit, provider-revocation reference/attestation digest, and signing secrets
exist; Windows candidates must report a valid Authenticode signature and the
release inspector rejects `UNSIGNED` filenames.

## Verification

```powershell
npm ci
npm run format:check
npm run lint
npm run scan:secrets
npm run check:hygiene
npm test
npm run test:contracts
npm run test:migrations
npm run test:lifecycle
npm run test:domain
npm run test:jobs
npm run test:remote
npm run test:import-export
npm run test:sync
npm run test:extension
npm run test:dashboard
npm run test:mobile
npm run test:android-release
npm run validate:android-release
npm run test:desktop-package
npm run verify:native
npm run package:windows
```

Only commands that exist in the checked-out package manifest may be recorded
as executed. A future aggregate release command must fail on missing evidence
or unresolved blockers rather than silently skipping them.

## Release blockers that automation cannot clear

- Provider-confirmed revocation of the exposed Gemini credential.
- Authenticode signing and signature verification with an authorized
  certificate.
- Clean Windows install, upgrade, restart, sleep/resume, uninstall, and
  standard-user acceptance.
- Chrome loaded-package browser acceptance.
- Dashboard real-browser accessibility and responsive acceptance.
- Android development/release build installation and physical-device pairing,
  TLS-pin, offline convergence, conflict, background scheduling, reminder, and
  revocation acceptance.

## Final gate

The release is ready only when every required automated and manual row is
`verified`, artifacts are signed and checksummed, full reachable Git history
and all artifacts scan cleanly, rollback procedures have been rehearsed, and
no release blocker remains. Until then, generated files are test artifacts,
not a production release.

## Rollback

Withdraw the affected artifact without deleting user data. Restore the last
signed, verified application artifact and its immutable checksum manifest.
For schema or migration failure, use the verified destination backup and
Stage 2 rollback metadata. For sync failure, preserve both replicas and queued
operations, resume from the last acknowledged opaque cursor, and use snapshot
recovery only after backup. Revoke affected install/device credentials before
re-pairing.

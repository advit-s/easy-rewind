# Stage 6 evidence

This directory records redacted Stage 6 Electron, native-module, packaging,
and Windows evidence. Automated implementation gates have passed:

- desktop lifecycle, IPC, resource-path, reminder, overlay, and platform tests:
  `67/67`, zero failures and zero skips;
- complete Electron-independent backend suite: `570/570`, zero failures and
  zero skips;
- embedded lifecycle smoke with real Windows current-user ACL enforcement and
  SQLite startup/shutdown: pass;
- desktop package validation tests: `21/21`, including packaged ASAR-root
  resolution;
- isolated native rebuild and SQLite smoke test against Electron `43.2.0`:
  pass;
- a freshly rebuilt unpacked packaged executable using isolated
  `%LOCALAPPDATA%`: reached `/v1/health` with status `ok`, created the protected
  runtime SQLite database, and stopped; and
- per-user NSIS and portable Windows artifacts: built with `UNSIGNED` in both
  filenames.

These are automated build results, not a signed release attestation. No
retained evidence proves a standard-user clean install, upgrade, sleep/resume,
abrupt termination, firewall denial, multiple launch, uninstall, or absence of
a system Node installation on a clean Windows machine. The unpacked executable
smoke is not an installer or upgrade/uninstall test. Those acceptance rows,
Authenticode signing, physical-device acceptance, and provider-side Gemini
credential revocation remain release blockers.

All evidence is aggregate. It excludes credentials, database contents,
hostnames, Windows user names, machine identifiers, runtime paths, quarantine
manifests, and personal data.

# Stage 6: Electron lifecycle, native modules, packaging, and Windows

## Objective

Ship one Windows desktop host for the Electron-independent backend. Electron
owns configuration, resource and storage paths, startup, health, UI lifecycle,
scheduling policy, and shutdown. It must not duplicate domain behavior or
spawn a system `node.exe`.

The development Node.js pin applies to development, CI, tests, and standalone
execution. Packaged execution uses Electron 43.2.0 and therefore requires a
separate `better-sqlite3` 13.0.1 rebuild and runtime smoke test.

## Entry gate

- The frozen database, authentication, error, pagination, synchronization,
  reminder, and health contracts pass.
- Stage 3 domain services pass without Electron.
- The dashboard production assets are fixed and served through the backend's
  exact allowlist.
- The sole legacy quarantine remains outside the repository and runtime.

## Work packages

1. Resolve development resources from the repository and packaged resources
   from `process.resourcesPath\app.asar`. Reject links, missing resources, and
   paths outside the resource root, including paths containing spaces and
   non-ASCII characters.
2. Derive the protected runtime beneath
   `%LOCALAPPDATA%\easy-rewind\runtime`; never put user data beside the
   executable, in `app.asar`, or in portable artifact directories.
3. Start the shared backend composition in-process, inject Electron/Windows
   adapters, wait for ready health, and only then create the tray, overlay, and
   dashboard entry points.
4. Register IPC once. Validate sender, channel, method, path, payload size,
   response size, timeout, safe external URL, and notification action. Keep
   the preload bridge narrow and immutable.
5. Make shutdown idempotently stop reminder delivery, schedulers, optional LAN
   sync, loopback HTTP, active work, and SQLite before Electron exits.
6. Remove legacy owner headers, raw local HTTP calls, provider-key settings,
   inline overlay code, unsafe HTML rendering, unrestricted navigation, and
   acknowledgement-on-display behavior.
7. Rebuild the native module from an isolated staging tree against Electron
   43.2.0. Verify migration, write, read, checkpoint, and close inside that
   runtime.
8. Package only the desktop host, backend, dashboard, and contracts. Exclude
   tests, source maps, databases and sidecars, settings, secrets, logs,
   exports, quarantine, migration work, private keys, and `.env` files.
9. Produce per-user NSIS and portable Windows artifacts with real icons.
   Until Authenticode signing succeeds, artifact names must include
   `UNSIGNED` and must not be called release-ready.

## Verification

```powershell
node --test desktop/*.test.js
npm --workspace backend test
npm run test:desktop-package
npm run validate:desktop-package
npm run verify:native
npm run package:windows
```

Inspect both the unpacked application and generated installers before
retention. Automated source and package checks do not replace clean Windows
install, upgrade, uninstall, sleep/resume, abrupt termination, no-network,
firewall-denial, multiple-launch, or standard-user acceptance.

## Exit gate

- Desktop tests and the full backend suite pass with zero skips.
- Package configuration and unpacked ASAR-root inspection pass.
- `better-sqlite3` loads and completes the isolated Electron smoke test.
- NSIS and portable artifacts build and are unmistakably unsigned.
- No database, sidecar, credential, setting, quarantine, log, export, test
  fixture, source map, or private key is present in either artifact.
- Windows lifecycle acceptance, signing, and provider-revocation checks are
  either evidenced as passing or remain explicit release blockers.
- [Stage 6 recovery](../../release/evidence/stage-6/recovery.md) is current.

## Rollback

Stop the app before copying runtime state. Preserve the database with matching
WAL/SHM files, verify a protected backup, then restore the previous
application version without downgrading the schema in place. Start with
listeners and schedulers disabled, verify health and SQLite integrity, and
reenable components in order. Never use the legacy quarantine as a live
runtime or upgrade rollback.

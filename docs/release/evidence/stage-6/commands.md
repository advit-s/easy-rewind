# Stage 6 command evidence

| Scope                               | Command                                                                                                                                       | State                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Desktop lifecycle and surface tests | `node --test desktop/*.test.js`                                                                                                               | `PASS` - `67/67`, zero failures and zero skips                                    |
| Shared backend regression           | `npm --workspace backend test`                                                                                                                | `PASS` - `570/570`, zero failures and zero skips                                  |
| Real Windows embedded lifecycle     | Embedded lifecycle smoke with Windows protected adapters and isolated runtime                                                                 | `PASS` - current-user ACL enforcement, SQLite startup, health, and shutdown       |
| Package validator tests             | `npm run test:desktop-package`                                                                                                                | `PASS` - `21/21`, including ASAR-root resource correction                         |
| Package source validation           | `npm run validate:desktop-package`                                                                                                            | `PASS`                                                                            |
| Electron native ABI                 | `npm run verify:native`                                                                                                                       | `PASS` - `better-sqlite3` `13.0.1` rebuilt and exercised inside Electron `43.2.0` |
| Windows artifacts                   | `npm run package:windows`                                                                                                                     | `PASS` - NSIS and portable x64 artifacts built with `UNSIGNED` names              |
| Unpacked packaged executable smoke  | Fresh `dist\win-unpacked\Easy Rewind.exe` with isolated `%LOCALAPPDATA%`                                                                      | `PASS` - `/v1/health` returned status `ok`; protected runtime SQLite was created  |
| Clean Windows lifecycle acceptance  | Install, launch, no-system-Node, multiple launch, offline, firewall denial, sleep/resume, abrupt termination, restart, upgrade, and uninstall | `BLOCKED` - no retained clean-machine run                                         |
| Authenticode                        | Sign and verify both artifacts                                                                                                                | `BLOCKED` - no authorized certificate/signature evidence                          |
| Provider credential response        | Provider-side Gemini revocation attestation                                                                                                   | `BLOCKED` - external revocation remains unconfirmed                               |

The generated local artifacts are:

```text
Easy-Rewind-UNSIGNED-Setup-2.0.0-x64.exe
Easy-Rewind-UNSIGNED-Portable-2.0.0-x64.exe
```

They are test artifacts. Their names intentionally prevent them from being
mistaken for signed production releases. Do not publish them as release-ready
until clean-machine acceptance, artifact inspection/checksums, Authenticode
verification, and external credential revocation are complete.

The unpacked executable smoke proves the rebuilt package can start its embedded
backend in the current Windows environment, reach ready health, create the
protected runtime database beneath an isolated LocalAppData root, and stop. It
does not prove the NSIS installer, portable first-run policy, upgrade,
uninstall, standard-user clean-machine behavior, or Authenticode trust.

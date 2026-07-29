# Security Policy

Easy Rewind stores browsing-derived and user-authored data locally. Treat
runtime databases, WAL/SHM files, settings, protected-secret ciphertext, logs,
exports, diagnostics, migration copies, reports, rollback metadata, and
quarantine backups as sensitive personal data.

## Reporting a vulnerability

When GitHub private vulnerability reporting is enabled, open the repository's
**Security** tab, choose **Report a vulnerability**, and submit the report
there. If it is unavailable, use an existing private contact channel already
published by the repository owner and request a private incident channel. Do not open a
public issue. Include file paths and commit identifiers, not secret
values or personal record contents.

A private reporting channel is a release prerequisite. Do not invent or infer
an email address.

## Local security boundary

The application API is loopback-only. It must not bind to `0.0.0.0`, trust
`x-user-id`, accept owner overrides, or reuse its credential for LAN sync.
Cross-origin access is limited to recognized loopback origins. Request bodies,
media types, errors, cache behavior, and API versions are bounded explicitly.

The install bearer credential is accepted only on loopback. Browser sessions
are short-lived, HttpOnly, SameSite=Strict, Origin-bound, and require CSRF
validation for mutations. Device pairing requires a short-lived one-use
challenge and explicit confirmation on the PC before credential issue.
Revocation disables the device credential.

LAN sync is a separate, opt-in boundary. Enabling it requires a TLS identity,
explicit-confirmation pairing policy, private-subnet policy, and a distinct
device credential. Stage 2 freezes that contract; Stage 3 implements truthful
synchronization behavior.

## Chrome extension security

The extension must never store a provider key or provider credential in local
or session state. Local-install authorization may exist only in
`chrome.storage.session`, must be validated before use, and is cleared from the
masked popup form before submission settles. Authenticated requests are
permitted only through the bounded service-worker API client, with
authorization kept out of persistent local state, URLs, logs, errors,
notifications, and returned messages.

Capture is opt-in and waits for a complete privacy snapshot before installing
listeners. Sensitive contexts, typed text, and disallowed pages are excluded.
Disabling capture immediately disposes every capture listener and timer.
Untrusted page and backend content is rendered as text; executable HTML and
unsafe link protocols are rejected.

If the extension is compromised or inconsistent, disable capture, clear only
extension local/session state, revoke the extension install credential, reload
a validated known-good package, and reauthenticate. Resume only from
acknowledged opaque cursors. Never delete or reset the canonical PC database as
part of extension recovery.

## Dashboard security

The dashboard is a local backend asset, not a separately trusted cloud origin.
Its exact HTML, stylesheet, and browser modules are served with a local-only
Content Security Policy, `no-store`, framing denial, MIME sniffing denial, and
an explicit asset allowlist. Unknown files, traversal attempts, and symlink
escapes fail closed.

Installation authorization may exist only for the active browser session and
must not be used as an owner identifier. It is sent only to the loopback API,
never placed in a URL, persistent storage, exported file, error, or log.
Untrusted item, conflict, graph, import, and diagnostic values are constructed
with text/attribute DOM APIs; executable HTML and unsafe link schemes are
rejected.

To recover a compromised dashboard session, end the session, clear
session-only authorization, revoke the affected local credential when
necessary, restore the known-good dashboard assets, and reauthenticate. Do not
delete or replace the canonical database.

## Android and device synchronization security

Android keeps content and queued changes in its local SQLite database. Device
bearer credentials belong only in Android protected storage; the pinned PC TLS
identity is stored separately from content rows. Credentials, certificate
material, hostnames, database rows, and user content must not appear in logs,
notifications, evidence, analytics, or release artifacts.

Pairing is explicit and local-network only:

1. The PC creates a short-lived, one-use challenge.
2. The phone scans the bounded, versioned QR payload.
3. The user compares and pins the PC TLS identity.
4. The PC displays the device request and requires explicit acceptance.
5. Only then may a distinct device credential be issued.

There is no unpinned or cloud-relay fallback. A revoked device must be rejected
from push, pull, acknowledgement, snapshot, and reconnect paths.
Synchronization is append-only, idempotent, cursor-based, and
conflict-preserving. Do not delete queued operations until the PC acknowledges
them. Do not clear a conflict, tombstone, or cursor as an automatic retry.

Before mobile database recovery, stop the app/background worker and copy the
database with its matching WAL/SHM files before opening or checkpointing it.
Clearing Android app data or uninstalling can destroy the only unsynchronized
copy and therefore requires a verified backup and explicit user authorization.

## Protected Windows storage

Both Electron-embedded and standalone modes default to:

```text
%LOCALAPPDATA%\easy-rewind\runtime\
```

Electron protects recoverable secrets with Electron `safeStorage`. Standalone
Node execution uses Windows DPAPI with `CurrentUser` scope through a bounded,
noninteractive PowerShell adapter. The application persists only ciphertext
under `runtime\secrets`; logical secret names are hashed before use as
filenames.

Runtime directories and files receive an ACL restricted to the current Windows
user. The adapter verifies the ACL after applying it and rejects links,
reparse-point escapes, target replacement, and paths outside its trusted
runtime root. Unsupported platforms, unavailable encryption, or unverifiable
ACLs fail closed.

The database stores only versioned keyed digests for authentication
credentials. Provider credentials must not be accepted in API request bodies,
returned in responses, placed in ordinary settings, committed, logged, or
exported.

Versioned exports and pre-import backups are written atomically beneath the
protected runtime root. They receive a verified current-user ACL and are
treated as sensitive data. Import dry runs do not write domain rows; confirmed
imports verify a destination backup before applying one transaction.

## Legacy quarantine and migration

The quarantine location is:

```text
%LOCALAPPDATA%\easy-rewind\legacy-backup\<timestamp>\
```

Before opening or modifying a legacy database:

1. Stop every Easy Rewind backend and Electron process.
2. Copy the database together with its matching `-wal` and `-shm` files and
   legacy settings.
3. Restrict the timestamped directory and its files to the current Windows
   user.
4. Record original paths, sizes, backup time, and SHA-256 checksums in the
   manifest.
5. Verify the manifest before inspection or migration.

The quarantine is sensitive recovery data, not credential storage. It must be
excluded from source, builds, tests, logs, diagnostics, exports, and release
artifacts.

Inspection and migration never open the sole preserved copy. They first create
a disposable working copy; migration also creates a second dated recovery
copy. Inspection output is marked `SENSITIVE MIGRATION METADATA` and must be
written to an explicitly selected private path outside the repository.

Migration is never automatic at startup. The operator must review a dry-run
report containing row counts, transforms, skips, conflicts, warnings, required
disk, and rollback path, then confirm the exact plan fingerprint. Migration is
transactional and must retain verified rollback metadata. On failure, stop the
backend, preserve the failed runtime copy privately, and restore to the runtime
path from verified rollback data. Never checkpoint, delete, overwrite, or run
tests against the sole preserved copy.

## Credential incidents

An exposed Gemini or other provider key must be revoked at its provider.
Deleting it from the working tree does not revoke it. Rewriting Git history
does not revoke it. Adding ignore rules or keeping it in the quarantine does
not revoke it. The quarantined copy must not be treated as secure key storage.

Provider-side revocation is an external operator action and remains a release
blocker until independently attested. Repository verification must not claim
that revocation occurred.

After revocation:

1. Issue a replacement only if the product still requires the provider.
2. Store it through the protected secret adapter.
3. Search current files, Git history, build artifacts, logs, tests, and exports
   for the exposed value without printing it.
4. Rewrite and republish Git history separately when required, then coordinate
   fresh clones with every collaborator.

## Repository and release hygiene

Do not commit credentials, personal data, databases, sidecars, copied
settings, quarantine manifests, inspection reports, migration work, logs,
exports, or diagnostics. Run:

```powershell
npm run scan:secrets
npm run check:hygiene
npm run audit:production
```

These checks reduce accidental exposure; they do not prove provider-side
revocation, a clean historical purge, or a complete security audit. Record
those external actions and release decisions separately without copying
sensitive values into release evidence.

## Electron packaging and release signing

Electron loads the same backend modules in-process. It must not spawn or fall
back to a system Node executable. Packaged resources come from the validated
ASAR resource root; user data always remains beneath
`%LOCALAPPDATA%\easy-rewind\runtime`, never beside an installer or portable
executable.

IPC registration is centralized and validates sender, channel, request method,
API path, payload/response bounds, timeouts, external URL protocols, and
notification actions. Renderer processes use a narrow frozen preload bridge,
cannot create arbitrary windows, cannot navigate to untrusted content, and
cannot acknowledge a reminder merely because it was displayed.

Package configuration and artifact inspection must exclude:

- SQLite databases and matching WAL/SHM/journal files;
- settings, credentials, protected-secret files, `.env` files, private keys,
  certificates, logs, exports, diagnostics, and personal content;
- quarantine, migration work, reports, rollback data, backups, or runtime
  paths; and
- tests, fixtures, coverage, source maps, dependency caches, or nested build
  output.

Until Authenticode signing and verification succeed, Windows artifacts must
include `UNSIGNED` in their filenames and must not be published as production
releases. For an authorized signing run, sign the guarded builder output with
SHA-256 file and timestamp digests using the approved RFC 3161 timestamp
service, and keep certificate material outside the repository and ordinary
command lines. Verify the exact output with Windows trust policy before
copying its unchanged signed bytes to the final `SIGNED` filename:

```powershell
signtool verify /pa /all /v <final-artifact.exe>
```

Generate and publish SHA-256 checksums only after signing. Retain redacted
signature and timestamp evidence. A renamed artifact, checksum, local package
build, or self-signed test certificate is not production signing evidence.

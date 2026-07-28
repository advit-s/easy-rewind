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

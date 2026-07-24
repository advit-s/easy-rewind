# Security Policy

Easy Rewind stores browsing-derived and user-authored data locally. Treat
runtime databases, WAL/SHM files, settings, logs, exports, diagnostics,
migration copies, and quarantine backups as sensitive personal data.

Do not commit credentials or personal runtime data. Report a suspected exposure
privately to the repository owner and include file paths and commit identifiers,
not the secret value or personal record contents.

An exposed credential must be revoked at its provider. Deleting it from the
working tree or rewriting Git history does not revoke it.

The legacy quarantine under
`%LOCALAPPDATA%\easy-rewind\legacy-backup\` is recovery data, not credential
storage. It is excluded from source, builds, tests, logs, diagnostics, exports,
and release artifacts.

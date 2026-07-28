# Stage 2 requirement traceability

This ledger links each Stage 2 requirement to its executable command and safe
evidence. `PENDING` is never equivalent to passing. Stage 2 implementation is
recorded at checkpoint `6f7140e`; final release remains subject to the blocked
gates below.

| ID    | State         | Verification                                       | Evidence and remaining gate                                                                               |
| ----- | ------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| S2-01 | `verified`    | `npm run test:lifecycle`                           | [commands.md](commands.md), shared composition and lifecycle `16/16`; Windows adapter smoke passed        |
| S2-02 | `verified`    | `npm run test:migrations`                          | [commands.md](commands.md), canonical migration/schema contract `88/88`, zero skips                       |
| S2-03 | `verified`    | `node --test backend/src/auth/auth.test.js`        | [commands.md](commands.md), authentication `7/7`, zero skips                                              |
| S2-04 | `verified`    | `npm run test:contracts`                           | [commands.md](commands.md), frozen error schemas plus HTTP contract routes                                |
| S2-05 | `verified`    | `npm run test:contracts`                           | [commands.md](commands.md), cursor pagination and bounds                                                  |
| S2-06 | `implemented` | `npm run test:contracts`                           | [commands.md](commands.md), opaque bounded cursor contract frozen; runtime convergence belongs to Stage 3 |
| S2-07 | `verified`    | `npm run test:contracts`                           | [commands.md](commands.md), exact reminder states and database alignment                                  |
| S2-08 | `verified`    | `npm run test:lifecycle`                           | [commands.md](commands.md), safe contract-valid health and migration-availability status                  |
| S2-09 | `verified`    | `node --test backend/src/legacy/migration.test.js` | [recovery.md](recovery.md), explicit dry-run and confirmed transactional migration passed                 |
| S2-10 | `verified`    | `node --test backend/src/legacy/migration.test.js` | [recovery.md](recovery.md), verified destination recovery-copy workflow passed                            |
| S2-11 | `verified`    | `node --test backend/src/legacy/migration.test.js` | [recovery.md](recovery.md), interruption rollback and unchanged quarantine checks passed                  |
| S2-12 | `verified`    | `npm run verify:native`                            | [commands.md](commands.md), staging `13/13` and real Electron `43.2.0` SQLite smoke passed                |
| S2-13 | `verified`    | `npm run check:hygiene`                            | [commands.md](commands.md), Git-aware exclusions, hygiene, and secret scan passed                         |
| S2-14 | `blocked`     | Authorized Gemini provider revocation confirmation | [README.md](README.md), external provider action unresolved; no key material retained                     |

## Frozen public contract

The deterministic generator check passes against the committed public
contract:

- Schema bundle SHA-256:
  `9c5292808862a88cb1035f6431456e5776442de0086e321769e1b892a815d145`
- OpenAPI SHA-256:
  `c58423ce97f8f2960ccc11e7d2fd828b3360a114ca01861a4c7fce17fbceb450`

The checksums cover public schema/OpenAPI bytes only. They are safe to retain
and are not database, quarantine, secret, hostname, or device fingerprints.

## Exit decision

**FAIL / BLOCKED.** All locally executable Stage 2 implementation requirements
pass. The online clean-install aggregate remains blocked pending explicit
authorization to send dependency metadata to the npm registry. The verified
implementation checkpoint is `6f7140e`. Gemini revocation is an external
unresolved release blocker even after all local checks pass.

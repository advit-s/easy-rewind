# Stage 3 evidence

This directory records redacted verification evidence for Stage 3 domain
correctness and synchronization. It does not claim that Stage 3 is complete.

Task 1 is implemented: migration `004_stage3.sql` adds the frozen Stage 3
tables, columns, constraints, owner relationships, and planned query indexes
without changing migrations 001 through 003. The same unreleased migration now
also makes every reminder delivery target one owner-matched device and freezes
per-device/channel idempotency. The broader Stage 3 requirement rows remain
`not-started` until their runtime services and tests exist.

Permitted requirement statuses remain `not-started`, `implemented`, `verified`,
`failing`, and `blocked`. A requirement becomes `verified` only after its exact
command passes with zero failures and zero skips and its recovery procedure is
recorded.

Stage 2's external Gemini revocation blocker and clean-install authorization
blocker remain unchanged. This evidence never treats a local provider secret
reference or quarantined legacy backup as secure provider-key storage.

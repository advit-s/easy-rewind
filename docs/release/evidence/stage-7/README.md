# Stage 7 evidence

Stage 7 assembles CI, artifact inspection, documentation, and end-to-end
acceptance evidence. The repository now contains:

- `.github/workflows/stage7-ci.yml`, with independent quality, backend,
  clients, Windows Electron, and checksum jobs;
- `.github/workflows/release-gate.yml`, a manual fail-closed candidate gate for
  exact-commit, provider-revocation, signing-secret, Authenticode, inspection,
  and release-checksum checks; and
- deterministic artifact inspectors and workflow-contract tests under
  `scripts/validation/`.

Focused Stage 7 workflow/artifact contract tests pass `12/12`, and the focused
Stage 6/7 documentation formatting check passes. The complete repository
formatting gate must still pass in the final combined worktree and clean CI
checkout. No completed remote workflow run is claimed. The retained local
evidence also proves the Stage 6 automated desktop/backend/native/package
gates, a real Windows embedded lifecycle with current-user ACL/SQLite
startup/shutdown, construction of unsigned Windows artifacts, and a freshly
rebuilt unpacked executable reaching status-ok health beneath an isolated
LocalAppData root. None of this proves an installer, signed production release,
or clean-machine acceptance.

The following remain explicit blockers until independent evidence is retained:

- provider-side revocation of the exposed Gemini credential;
- full-history and generated-artifact secret/hygiene scans in the authorized
  release environment;
- Authenticode signing and signature verification;
- clean Windows install, upgrade, restart, sleep/resume, uninstall, standard
  user, and no-system-Node acceptance;
- loaded Chrome package and real-browser dashboard accessibility/responsive
  acceptance; and
- installed Android artifact and physical-device pairing, TLS pinning,
  offline convergence, conflict, reminder/background-work, and revocation
  acceptance.

No skipped, missing, manual, or external check may be represented as passing.
The CI uploads are deliberately named `client-builds-non-release` and
`windows-unsigned-non-release`; unsigned local artifacts remain test artifacts.

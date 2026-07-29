# Stage 4 Chrome command evidence

All retained results are aggregate and redacted. They exclude credentials,
authorization material, storage values, page contents, machine identities,
network identities, and machine-local locations.

| Scope                                     | Command                                                                 | State                                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Chrome extension tests                    | `npm run test:extension`                                                | `PASS` — `73/73`, zero failures and zero skips                                                                                  |
| Disposable package validation             | `npm run validate:extension`                                            | `PASS` — `16` production files and `11` manifest references                                                                     |
| Manifest permissions                      | Packaged-manifest assertion in `npm run test:extension`                 | `PASS` — exact set: `activeTab`, `alarms`, `contextMenus`, `notifications`, `storage`                                           |
| Credential/XSS package checks             | Packaging and focused extension tests                                   | `PASS` — credential fields, executable HTML, unsafe link protocols, and unsafe popup rendering are rejected                     |
| Limited secret scan                       | Secretlint restricted to new extension and packaging-validation sources | `PASS` — a credential-shaped test fixture first produced an expected false positive and was replaced with a non-secret sentinel |
| Fresh authentication bootstrap regression | Complete backend test suite                                             | `PASS` — `556/556`, zero skips                                                                                                  |
| Production extension authentication       | Session authorization and background integration tests                  | `PASS` — validated local-install authorization is session-only, non-echoing, and used by the bounded API client                 |
| Complete repository hygiene               | `npm run check:hygiene`                                                 | `BLOCKED` — the managed sandbox denied Git-metadata traversal; no passing result is claimed                                     |

The contract/state/API aggregate SHA-256 is:

```text
b69e3a323aa1fe3916efdddcc8d46f7c15a5c2ace301bc5b2c60be4023ca8fae
```

This digest covers the exact API client, message-contract, and state-store
source bytes using the role-and-length framing documented in this directory's
README. It contains no runtime configuration or user data.

The Chrome focused, authorization, and disposable-package checks are green. The
Stage 4 exit gate remains open until the Git-aware hygiene command runs
successfully in an authorized environment and the separate Android work is
completed.

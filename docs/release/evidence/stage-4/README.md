# Stage 4 Chrome evidence

This directory records redacted automated verification evidence for the Chrome
Manifest V3 client. The focused extension suite passes `73/73` tests with zero
skips, and disposable packaging validates `16` production files and `11`
manifest references.

The implemented Chrome boundary has:

- an exact, credential-free local state allowlist;
- strict service-worker, popup, and content-script message contracts;
- one bounded loopback API client with injected authorization and explicit offline, authentication,
  conflict, incompatible, and failed states;
- opt-in capture with sensitive-page exclusions and disposable listeners;
- text-only popup rendering and checked external-link protocols;
- restart-safe service-worker initialization and cursor persistence; and
- a strict local-only extension CSP with the minimum currently used
  permissions.

The retained permission set is `activeTab`, `alarms`, `contextMenus`,
`notifications`, and `storage`. No provider credential belongs in extension
state, requests, logs, errors, source, or the packaged artifact.

The exact API client, message contract, and state-store bytes have the aggregate
SHA-256:

```text
b69e3a323aa1fe3916efdddcc8d46f7c15a5c2ace301bc5b2c60be4023ca8fae
```

The digest is reproducible by sorting the source roles as `api-client`,
`message-contracts`, and `state-store`, then hashing each UTF-8 role, a NUL
separator, its decimal byte length, a NUL separator, and its exact file bytes.

A limited secret scan covering the new extension and packaging-validation
sources passed after a credential-shaped test fixture was replaced with a
non-secret sentinel. The complete repository hygiene command could not traverse
Git metadata in the managed sandbox. It is therefore recorded as blocked in
this environment, not as passing.

The production background retrieves a strictly validated local-install bearer
only from `chrome.storage.session`. The masked popup form clears its value
before awaiting the service worker, and the authorization is excluded from
local state, URLs, logs, errors, notifications, and returned messages.

This evidence does not complete Stage 4. Android implementation, the complete
Git-aware hygiene gate, and later full acceptance remain separate work. It also
does not clear the external provider-key revocation blocker.

# Stage 4 Chrome Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the Manifest V3 extension against the frozen local API while removing provider credentials, unsafe rendering, broad capture, and false-success states.

**Architecture:** A service-worker API client owns authentication, timeout, retry, bounded responses, cursors, and connection state. Popup and content-script modules exchange validated messages only; the content script receives one complete privacy snapshot before installing capture listeners. All persistent state uses an exact allowlist and provider credentials are forbidden recursively.

**Tech Stack:** Chrome Manifest V3, browser-native ES modules, DOM APIs, Node.js built-in test runner, frozen schemas in `packages/contracts`.

---

## File and ownership map

```text
extension/src/api-client.js          bounded authenticated loopback requests
extension/src/state-store.js         exact Chrome-storage allowlist and migrations
extension/src/privacy-policy.js      sensitive-page and opt-in capture decisions
extension/src/message-contracts.js   strict service-worker/content/popup messages
extension/src/safe-dom.js            text-only rendering and safe URL handling
extension/background.js              lifecycle, context menus, notifications, recovery
extension/content.js                 privacy-gated capture listeners
extension/popup.js                   popup controller and explicit UI states
extension/popup.html                 static accessible markup without inline handlers
extension/manifest.json              minimum permissions and strict CSP
extension/test/                      unit, contract, privacy, DOM, and manifest tests
scripts/validation/                  packaged-extension validation
```

### Task 1: Freeze extension storage and message contracts

**Files:**

- Create: `extension/src/state-store.js`
- Create: `extension/src/message-contracts.js`
- Create: `extension/test/state-store.test.js`
- Create: `extension/test/message-contracts.test.js`

- [ ] **Step 1: Write failing tests**

Assert the only stored keys are `connection`, `privacy`, `capture`, `ui`, and
`sync`, and recursively reject keys matching
`apiKey|token|secret|credential|password`. Assert every message is an exact
object with one frozen `type` and bounded payload.

- [ ] **Step 2: Verify RED**

Run:

```powershell
node --test extension/test/state-store.test.js extension/test/message-contracts.test.js
```

Expected: both suites fail because the modules do not exist.

- [ ] **Step 3: Implement exact validators and storage migration**

Expose:

```js
createExtensionStateStore({ storageArea, now });
validateExtensionMessage(message);
containsCredential(value);
```

On migration, delete legacy Gemini/provider fields instead of translating
them. Defaults keep capture disabled and contain no machine hostname.

- [ ] **Step 4: Verify GREEN**

Run the RED command and require zero skips.

### Task 2: Build the single bounded local API client

**Files:**

- Create: `extension/src/api-client.js`
- Create: `extension/test/api-client.test.js`

- [ ] **Step 1: Write failing mocked transport tests**

Cover exact loopback URL validation, bearer/session setup, 10-second timeout,
abort, 1 MiB response limit, JSON content type, safe error envelopes, offline,
401 reauthentication, 409 conflict, 426 incompatible backend, and no credential
in URL/log/error output.

- [ ] **Step 2: Verify RED**

```powershell
node --test extension/test/api-client.test.js
```

- [ ] **Step 3: Implement**

Expose `createApiClient({ baseUrl, fetch, getAuthorization, now })` with
`request`, `health`, `push`, and `pull`. Return explicit states:
`ready`, `offline`, `authentication_required`, `conflict`, `incompatible`, and
`failed`; never convert a rejected request to success.

- [ ] **Step 4: Verify GREEN**

Run the focused test with zero skips.

### Task 3: Implement privacy policy before content listeners

**Files:**

- Create: `extension/src/privacy-policy.js`
- Modify: `extension/content.js`
- Create: `extension/test/privacy-policy.test.js`
- Create: `extension/test/content-startup.test.js`

- [ ] **Step 1: Write failing tests**

Cover disabled-by-default capture, complete settings awaited before startup,
browser-internal pages, password/payment/health/account pages, allowlist,
blocklist, minimum dwell/selection thresholds, no typed-text capture, and
immediate listener/timer removal when disabled.

- [ ] **Step 2: Verify RED**

```powershell
node --test extension/test/privacy-policy.test.js extension/test/content-startup.test.js
```

- [ ] **Step 3: Implement**

Content startup must follow:

```js
const settings = await requestPrivacySnapshot();
const decision = evaluateCapture({ settings, location, document });
if (decision.allowed) controller.start();
```

Every registered listener and timer is owned by one disposable controller.

- [ ] **Step 4: Verify GREEN**

Run the focused command with zero skips.

### Task 4: Replace unsafe popup rendering and monolithic request code

**Files:**

- Create: `extension/src/safe-dom.js`
- Modify: `extension/popup.html`
- Modify: `extension/popup.js`
- Create: `extension/test/safe-dom.test.js`
- Create: `extension/test/popup-controller.test.js`

- [ ] **Step 1: Write failing tests**

Reject `innerHTML`, inline `on*` handlers, `javascript:`/`data:` links, and
request code outside the service-worker client. Assert accessible loading,
empty, ready, offline, authentication, retry, conflict, and incompatible states.

- [ ] **Step 2: Verify RED**

```powershell
node --test extension/test/safe-dom.test.js extension/test/popup-controller.test.js
```

- [ ] **Step 3: Implement**

Use `textContent`, `createElement`, `replaceChildren`, delegated `data-action`
events, protocol-checked `http:`/`https:` links, focus restoration, and a live
status region. Popup actions send only validated messages.

- [ ] **Step 4: Verify GREEN**

Run the focused tests and static scans with zero skips.

### Task 5: Repair the Manifest V3 service worker

**Files:**

- Modify: `extension/background.js`
- Create: `extension/test/background.test.js`

- [ ] **Step 1: Write failing lifecycle tests**

Cover installation, browser restart, state recovery, context-menu capture,
notification mapping, retry after backend return, cursor persistence, explicit
conflict state, and rejected unknown messages. Assert no provider SDK import or
key handling.

- [ ] **Step 2: Verify RED**

```powershell
node --test extension/test/background.test.js
```

- [ ] **Step 3: Implement**

Keep one initialization promise, recreate idempotent context menus, route all
HTTP through `api-client.js`, and persist only sanitized state through
`state-store.js`.

- [ ] **Step 4: Verify GREEN**

Run the focused suite with zero skips.

### Task 6: Minimize permissions and add packaged smoke validation

**Files:**

- Modify: `extension/manifest.json`
- Modify: `scripts/validation/validate-extension.mjs`
- Create: `scripts/validation/extension-package.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing manifest/package tests**

Require Manifest V3, strict extension CSP, no remotely hosted code, no broad
`<all_urls>` host permission, loopback-only API access, and only permissions
used by executable code. Build into a disposable directory and scan for
credentials, source maps containing secrets, inline handlers, and unsafe HTML.

- [ ] **Step 2: Verify RED**

```powershell
node --test scripts/validation/extension-package.test.mjs
```

- [ ] **Step 3: Implement validation and commands**

Add:

```json
{
  "test:extension": "node --test extension/test/*.test.js scripts/validation/extension-package.test.mjs"
}
```

- [ ] **Step 4: Run the Stage 4 Chrome gate**

```powershell
npm run test:extension
npm run validate:extension
npm run scan:secrets
npm run check:hygiene
```

Require zero failures and zero skipped required suites.

### Task 7: Record evidence and recovery

**Files:**

- Create: `docs/release/evidence/stage-4/chrome-commands.md`
- Create: `docs/release/evidence/stage-4/chrome-recovery.md`
- Modify: `docs/release/requirements/stages-2-7.csv`
- Modify: `README.md`
- Modify: `SECURITY.md`

- [ ] **Step 1: Record only redacted aggregate results**

Document test counts, permission list, packaged-file count, contract checksum,
and credential/XSS scan outcome without hostnames, URLs, tokens, page content,
or storage values.

- [ ] **Step 2: Document recovery**

Disable capture, clear extension state, revoke the install credential, reload
the unpacked known-good build, reauthenticate, and replay only acknowledged
cursors. Clearing the extension must never delete the PC database.

- [ ] **Step 3: Commit the implementation checkpoint**

Stage only the explicit extension, validation, documentation, and package files.

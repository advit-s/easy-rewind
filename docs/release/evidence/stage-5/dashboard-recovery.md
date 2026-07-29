# Stage 5 dashboard recovery

Use this procedure when the dashboard enters an inconsistent authentication,
rendering, pagination, import/export, or destructive-action state:

1. Stop dashboard requests and keep the current error, conflict, or offline
   state visible. Do not report a failed action as successful.
2. Clear only the dashboard session record from `sessionStorage`. Never clear,
   move, replace, or checkpoint the canonical PC database as a dashboard retry.
3. Revoke the affected local installation authorization through the protected
   backend boundary if disclosure or cross-profile behavior is suspected.
4. Close the dashboard and reload the known-good local asset set whose source
   validation and backend-route evidence passed.
5. Reauthenticate explicitly. Do not place authorization in a URL,
   `localStorage`, page markup, logs, exports, or imported data.
6. Resume paginated reads from the last acknowledged opaque cursor. Discard an
   unconfirmed response and never advance ownership or cursor state from it.
7. Preserve both variants of every conflict and require an explicit resolution.
   A cross-profile response is terminal for that session and requires
   reauthentication and investigation.
8. Before import, restore, device revocation, or another destructive operation,
   create and verify the backend recovery copy required by the relevant domain
   procedure. The dashboard itself is not a backup boundary.
9. If a downloaded export or selected import is suspect, cancel the operation
   and preserve backend recovery evidence before retrying with a verified file.
10. Rerun dashboard tests, source validation, and real-browser acceptance before
    release.

Refreshing the page is not database recovery. Backend databases, WAL/SHM files,
protected backups, legacy quarantine, and mobile queued operations retain their
separate recovery procedures.

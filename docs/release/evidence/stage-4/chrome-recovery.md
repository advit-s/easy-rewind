# Stage 4 Chrome recovery

Use this procedure when the extension enters an inconsistent authentication,
capture, cursor, or package state:

1. Disable capture before diagnosing or replacing the extension.
2. Clear only the extension's local and session state. Do not delete, move,
   reset, or replace the PC database.
3. Revoke the affected extension install credential through the local
   authentication boundary.
4. Remove or disable the suspect extension package and reload the known-good
   unpacked package whose validation evidence was retained.
5. Reauthenticate to obtain a new short-lived browser session or replacement
   install credential as required by the supported bootstrap flow.
6. Restore privacy preferences explicitly; capture remains disabled until the
   user opts in again.
7. Resume synchronization from the last acknowledged opaque cursor. Replay only
   acknowledged cursor positions and idempotent operations; never advance a
   cursor based on an unconfirmed request.
8. If the backend reports a conflict, authentication requirement, incompatible
   version, or failed request, keep that state visible and resolve it before
   resuming capture or synchronization.

Clearing extension state is not database recovery. The canonical PC database,
its WAL/SHM state, protected backups, and legacy quarantine follow their
separate backup and rollback procedures.

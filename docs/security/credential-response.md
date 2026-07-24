# Exposed Gemini Credential Response

1. Sign in to the Google AI Studio or Google Cloud project that owns the exposed
   Gemini API key.
2. Identify the key by project and creation metadata. Do not paste it into
   tickets, chat, logs, commands, or this repository.
3. Revoke or delete the exposed key at the provider.
4. Review provider usage and billing logs from the earliest affected commit.
5. Create a replacement only if Gemini remains enabled.
6. Store the replacement only through the repaired backend-only protected
   configuration flow after Stage 3. Do not put it in the extension, dashboard,
   Electron JSON settings, a tracked `.env` file, or the quarantine.
7. Record the revocation time and operator confirmation in a private incident
   record. The public verification report records only a status and a private
   incident-record reference, never the credential.

The quarantine is recovery data, not secure credential storage. History
rewriting and file deletion are containment steps, not revocation.

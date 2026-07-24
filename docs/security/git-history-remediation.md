# Git History Remediation

Perform this only after the containment and workspace gates pass and all
collaborators have coordinated a freeze. History remediation is a separate
Stage 1 external action required before the final PASS decision; it is not part
of quarantine, source purge, or workspace normalization.

Work from a fresh mirror clone outside the normal working copy. Keep an offline
mirror backup until the rewrite, push, and downstream cleanup have been
validated.

## Affected paths

- `backend/.env`
- `backend/data/easy-rewind.db`
- `backend/data/easy-rewind.db-wal`
- `backend/data/easy-rewind.db-shm`
- `backend/data/settings.json`

Install `git-filter-repo`, then use the coordinated remote URL:

```powershell
git clone --mirror <REMOTE-URL> easy-rewind-sanitized.git
Set-Location easy-rewind-sanitized.git
git filter-repo --force --invert-paths `
  --path backend/.env `
  --path backend/data/easy-rewind.db `
  --path backend/data/easy-rewind.db-wal `
  --path backend/data/easy-rewind.db-shm `
  --path backend/data/settings.json
```

Scan all rewritten refs for secrets and forbidden paths before pushing. Validate
branches, tags, remote-tracking refs, and any retained pull-request refs. If the
credential is discovered at another path or inside other file content, include
that path in the rewrite and create a local `replacements.txt` containing the
value only for the content replacement:

```powershell
git filter-repo --force --replace-text .\replacements.txt
```

Never commit, upload, quote, log, or retain `replacements.txt`. Keep it out of
shell history and CI variables, and securely delete it after validation.

After the repository owner confirms the freeze and validates every rewritten
ref, coordinate the destructive remote update:

```powershell
git push --force --mirror <REMOTE-URL>
```

All collaborators must discard old clones and re-clone. Forks, caches, release
artifacts, pull-request refs, and external mirrors may require separate cleanup.
Repository hosts may require support requests for unreachable cached objects.
The exposed Gemini key must still be revoked at its provider; history rewriting
is not credential revocation.

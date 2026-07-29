# Stage 3 command evidence

All retained results are aggregate and redacted. Machine-local paths, database
contents, credentials, request bodies, and raw command output are excluded.

| Scope                     | Command                                                                                               | State                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Task 1 RED                | `node --test backend/src/database/stage3-schema.test.js` before migration 004                         | Expected failure: `1/5` passed because version 4, the eight tables, additive columns, and indexes were absent                                 |
| Task 1 focused GREEN      | `node --test backend/src/database/stage3-schema.test.js`                                              | `PASS` — initial schema checkpoint `5/5`, zero skips                                                                                          |
| Reminder-device RED       | `node --test backend/src/database/stage3-schema.test.js` before the delivery extension                | Expected failure: `5/6`; `reminder_deliveries.device_id` and its owner/idempotency indexes were absent                                        |
| Reminder-device GREEN     | `node --test backend/src/database/stage3-schema.test.js`                                              | `PASS` — `6/6`, zero skips                                                                                                                    |
| Exact schema contract     | `node --test backend/src/database/schema-contract.test.js backend/src/database/stage3-schema.test.js` | `PASS` — `44/44`, zero skips                                                                                                                  |
| Database regression       | `node --test backend/src/database/*.test.js`                                                          | `PASS` — `95/95`, zero skips                                                                                                                  |
| Requirements ledger RED   | `npm run test:requirements` before fixture generalization                                             | Expected failure: `13/18`; five legacy fixture assertions assumed the ledger contained only Stage 2 rows and appended a colliding `S3-01` row |
| Requirements ledger GREEN | `npm run test:requirements`                                                                           | `PASS` — `18/18`, zero skips; all fourteen Stage 2 rows remain exact while real Stage 3 rows are allowed                                      |
| Domain and routes         | `npm run test:domain`                                                                                 | `PASS` — `74/74`, zero skips                                                                                                                  |
| Durable jobs              | `npm run test:jobs`                                                                                   | `PASS` — `12/12`, zero skips                                                                                                                  |
| Remote acquisition        | `npm run test:remote`                                                                                 | `PASS` — `22/22`, zero skips                                                                                                                  |
| Import/export             | `npm run test:import-export`                                                                          | `PASS` — `21/21`, zero skips                                                                                                                  |
| Sync and LAN              | `npm run test:sync`                                                                                   | `PASS` — `60/60`, zero skips                                                                                                                  |
| Complete backend          | `npm --workspace backend test`                                                                        | `PASS` — `549/549`, zero skips                                                                                                                |
| Frozen contracts          | `npm run test:contracts`                                                                              | `PASS` — contracts `23/23` and HTTP `17/17`, zero skips                                                                                       |
| Secret scan               | `npm run scan:secrets`                                                                                | `PASS`; rerun with Git metadata readable after the managed sandbox denied `.git` traversal                                                    |
| Repository hygiene        | `npm run check:hygiene`                                                                               | `PASS`                                                                                                                                        |
| Complete Stage 3 sequence | `npm run verify:stage3`, followed by the two sandbox-blocked Git-aware checks above                   | `PASS`; every implementation/test step passed, and the separately rerun secret and hygiene checks passed                                      |
| Earlier-stage regression  | `npm test`                                                                                            | `PASS`; workspace `53/53`, containment `21/21`, hygiene `69/69`, backend `549/549`, and isolated legacy backend `57/57`, all with zero skips  |

The Task 1 tests freeze the original migration checksums:

- `001_core.sql`: `6e1e26210b7ed0a208563004424fac939c0d929ee76ffdfd926f96d0c7b7a73f`
- `002_auth_and_devices.sql`: `5a1ab333861e5f8a84bde1a76802872f9fcd2665f1a60eed2db2af85009f5826`
- `003_jobs_and_sync.sql`: `5ea93ba525bd14a1f5864efc85ef2a69d1970e16a3e34e686c344e30741e2f53`

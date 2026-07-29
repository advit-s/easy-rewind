# Stage 7 traceability

| Requirement | State         | Evidence boundary                                                                                                                                                                              |
| ----------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S7-01       | `implemented` | Pinned, immutable-action CI covers quality, backend, clients, native ABI, Windows packaging, and checksums; focused contracts pass 12/12, while a completed clean remote run is still required |
| S7-02       | `implemented` | Deterministic inspectors and short-retention non-release uploads exist; Windows signing and installed Android artifacts require retained release evidence                                      |
| S7-03       | `verified`    | Installation, onboarding, offline/sync, conflict, revocation, backup/restore, migration, signing, and recovery boundaries are documented                                                       |
| S7-04       | `blocked`     | Provider-side Gemini credential revocation is unconfirmed                                                                                                                                      |
| S7-05       | `blocked`     | Authenticode signing and verification are unavailable                                                                                                                                          |
| S7-06       | `blocked`     | Clean Windows, Chrome, dashboard, and physical Android acceptance has not been retained                                                                                                        |
| S7-07       | `blocked`     | Final release gate cannot close while any prior-stage/manual/external blocker remains                                                                                                          |

Documentation completeness is not runtime acceptance. Each manual or external
row must retain its own evidence before its state can become `verified`.

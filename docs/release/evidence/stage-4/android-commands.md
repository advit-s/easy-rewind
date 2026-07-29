# Stage 4 Android command evidence

All retained results are aggregate and redacted. They exclude credentials,
pairing material, TLS fingerprints, database contents, user content, machine
identities, network identities, and machine-local paths.

| Scope                               | Command                                                                                              | State                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Android domain and adapter tests    | `npm run test:mobile`                                                                                | `PASS` — `64/64`, zero failures and zero skips                                            |
| Android-only source validation      | `npm run validate:mobile`                                                                            | `PASS` — `49` required files and `58` inspected source/configuration/assets, Android only |
| Android release configuration tests | `npm run test:android-release`                                                                       | `PASS` — `6/6`, zero failures and zero skips                                              |
| Android release source validation   | `npm run validate:android-release`                                                                   | `PASS` — preview APK and production AAB profiles plus permission/privacy/artifact guards  |
| Mobile TypeScript                   | `npm run mobile:typecheck`                                                                           | `PASS` — zero TypeScript errors                                                           |
| Expo Android JavaScript export      | `expo export --platform android --clear` from the mobile workspace                                   | `PASS` — Expo Router bundled `1,297` modules into a `2.9 MB` Hermes bytecode bundle       |
| Complete repository secret scan     | `npm run scan:secrets`                                                                               | `PENDING` — Git-aware execution must run in an authorized environment                     |
| Complete repository hygiene         | `npm run check:hygiene`                                                                              | `BLOCKED` — the managed sandbox has denied Git-metadata traversal                         |
| Expo development build              | Android development-build command on a clean machine                                                 | `BLOCKED` — no development build has been produced or retained                            |
| Android emulator/device acceptance  | Installed development build with offline, pairing, sync, reminder, revocation, and TLS-pin scenarios | `BLOCKED` — no emulator or physical-device run has been executed                          |
| APK/AAB inspection                  | Signed release artifact inspection and install smoke                                                 | `BLOCKED` — no release APK/AAB exists                                                     |

The source validator requires:

- Android as the only configured Expo platform;
- the complete planned mobile source, screen, adapter, and test inventory;
- exact Expo 57, React, and React Native dependency/configuration consistency;
- declared dependencies for every Expo/React module used by configuration or
  production source;
- stable root `test:mobile` and `validate:mobile` commands; and
- no secret-bearing files, credential material, runtime databases, SQLite
  sidecars, native/generated directories, source maps, APKs, AABs, or build
  outputs in the mobile source tree.

An automated source gate does not prove native runtime behavior. Stage 4 stays
blocked until the Android development-build/emulator or device acceptance,
artifact inspection, and Git-aware repository gates pass.

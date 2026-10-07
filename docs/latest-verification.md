# Latest verification — 7 October 2026

This records local verification on an Apple Silicon Mac and successful public macOS, Linux, and Windows CI on 7 October 2026. It covers software and speech-pipeline behavior; it is not a transcript-accuracy score.

## Automated checks

`npm run check` passed:

- Syntax checks and repository lint passed.
- Node test suite: **395 passed, 0 failed**.
- Production bundle build passed.

The test runner explicitly enumerates top-level `test/*.test.js` files. This works without shell glob expansion on Windows and keeps ignored local archives under `test/` out of the suite.

## Real speech pipeline

The pinned public `whisper.cpp` JFK WAV fixture was downloaded and SHA-256 verified with `scripts/prepare-speech-fixture.js`. `scripts/live-dictation-smoke.js` then ran it through the local HTTP API and installed Whisper Base model.

- Three saved audio chunks produced **3/3 provisional** and **3/3 user-requested revised** transcript segments.
- Revised transcription stayed deferred until the smoke explicitly called the same `asr/revise` endpoint used by **Improve transcript**.
- No high-quality ASR pass was requested. Whisper processes, temporary folders, and job queues returned to zero after completion.
- Ollama was disabled for this smoke. It did not evaluate translation, generated notes, or course-material correction quality.

The pinned sample is a short English fixture. This result does not establish accuracy across accents, languages, devices, long lectures, or noisy environments. The separate [10.5-minute Base benchmark](performance-validation-2026-09-08.md) records resource measurements on the same Mac.

## Version C / C6 quality status

The current branch has deterministic guards and a controlled fixed-input evaluation runner. In the latest 20-slice run, C6 word error rate against the saved Whisper Large-v3 transcript proxy moved from 0.3271 to 0.3243; 2 cases improved by proxy WER, 18 were unchanged, and none worsened. This proxy is not human-verified ground truth, so no broad correction-accuracy claim is made. Full method and limitations are in the [C6 evaluation report](c6-evaluation-2026-10-07.md). The fixed lecture dataset and saved baseline files are local-only and are not included in this public snapshot.

## Cross-platform status

The public source at [77f87a4](https://github.com/FAN0020/local-lecture-copilot/commit/77f87a4a9dc8ef49c1c2caa73c17be619b3b7c8d) passed both workflows:

| Platform | Result | Evidence |
| --- | --- | --- |
| macOS and Ubuntu | Syntax, lint, full tests, build, real-speech server pipeline, and Electron startup/shutdown passed | [Successful run](https://github.com/FAN0020/local-lecture-copilot/actions/runs/37631625925) |
| Windows x64 | Full suite: **390 passed, 0 failed, 5 platform skips**. Server/native speech checks, package build, and packaged Electron smoke passed | [Successful run](https://github.com/FAN0020/local-lecture-copilot/actions/runs/37631625448) |

The Windows workflow builds and checks the package, but skips executing the installer. Physical microphone capture and broad transcript quality are outside these checks.

Before release, stale Electron-smoke expectations were aligned with explicit transcript revision and its HTTP 202 response; packaging was made non-publishing; the test command was made portable; and Windows test-directory cleanup gained bounded retries for transient filesystem errors. Required test/build failures still fail CI. Artifact uploads are best-effort because the account has encountered storage limits; the linked workflow logs retain the check results.

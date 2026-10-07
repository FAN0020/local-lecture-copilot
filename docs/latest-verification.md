# Latest verification — 7 October 2026

This is a fresh local verification of the current Version C code on an Apple Silicon Mac. It covers software and speech-pipeline behavior; it is not a transcript-accuracy score.

## Automated checks

`npm run check` passed:

- Syntax checks and repository lint passed.
- Node test suite: **395 passed, 0 failed**.
- Production bundle build passed.

The test command is scoped to top-level `test/*.test.js` files so ignored local archives under `test/` cannot be mistaken for this repository's tests.

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

An earlier Windows x64 run passed its 19 checks on the then-current source. The latest pre-fix workflow had stale smoke expectations and attempted to publish an installer during validation. Those checks have been updated and the current workflow is being rerun; consult the repository Actions page for the latest Windows/macOS/Linux result.

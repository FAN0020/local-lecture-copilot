# Multistage ASR benchmark

> Historical benchmark: current C6 behavior is documented in [architecture.md](architecture.md). C6 cleanup uses Raw directly; the older HQ-first policy below is not the current runtime design.

These historical measurements compare models for the local whisper.cpp
pipeline. They used an accelerated runtime and do not measure the current
CPU-only, manual-revision defaults described below.

## Environment

* Apple M5 Pro, 15 cores, 24 GB RAM
* macOS / Darwin 25.5, arm64
* whisper.cpp b4938, Metal + Accelerate, flash attention enabled
* Original 24:29 English lecture recording with accented speech
* Models: Small, Medium, Large v3 Turbo, and Large v3, unquantized GGML
* Language fixed to English for comparable results

The installed runtime had no CoreML encoder bundle or VAD model. It also had no
registered quantized model, so those configurations could not be selected as a
shipping default. The CLI supports VAD; the application uses local energy-based
natural speech boundaries until a managed VAD model is packaged and measured.

## Results

| Audio window | Small | Medium | Large v3 Turbo | Large v3 |
| --- | ---: | ---: | ---: | ---: |
| 0–180 seconds | 13.80 s | 7.69 s | 7.32 s | 10.51 s |
| 600–720 seconds | 3.54 s | 6.48 s | 5.22 s | 11.55 s |
| 12-second speech window | 1.95 s | 3.04 s | 2.77 s | — |

Small on the same 12-second window took 3.07 seconds with `--no-gpu`, making
Metal about 1.6× faster in that live-sized sample.

With Large v3 as a reference rather than ground truth, normalized word edit
distance was:

| Audio window | Small | Medium | Large v3 Turbo |
| --- | ---: | ---: | ---: |
| 0–180 seconds | 0.409 | 0.356 | 0.476 |
| 600–720 seconds | 0.342 | 0.265 | 0.218 |

Manual review found Small understandable and generally fastest on short/live
windows, with more substitutions and repetition. Medium was the most complete
on the first window. Turbo gave the best overall latency/detail balance and the
best reference distance on the second window. Large v3 recovered the most
specific detail on the second window but was slower and had some first-window
omissions. Automatic language detection misidentified accented English for
Small, Medium, and Large v3; Turbo detected English. An explicit session
language produced coherent output across models.

## Current battery-conscious policy

* Live draft: **Base**, then Tiny/Small if unavailable. An explicit stage model
  selection still takes priority.
* Improve transcript: **Large v3 Turbo**, started by clicking the button after
  stopping dictation. This processes saved segments once and does not also
  start high-quality ASR or translation.
* High quality: **Large v3**, requested explicitly, including as a prerequisite
  of a user-requested cleanup or analysis action.

The runtime chooses only among installed models and records the actual choice.
Turbo is the first high-quality fallback when Large v3 is unavailable or fails.
Medium is next because it was consistently competitive. The user-selected model
is also inserted into each fallback chain, so a smaller installation remains
usable without hard-coding the benchmark machine's complete model set.

The packaged macOS runtime currently uses Accelerate/CPU with `--no-gpu` and
two threads by default, with an explicit provider cap of four. The pinned b4938
Metal backend has crashed while loading the
packaged models, so it is treated as a known-broken accelerator instead of being
retried for every audio chunk. Staged Whisper work is serialized separately from
the model selection above. Re-enabling Metal requires upgrading or repairing the
packaged backend and validating repeated model loads, cancellation, and fallback
under the same concurrency regression suite.

The live decoder uses `--beam-size 1 --best-of 1` to avoid multiple candidate
paths. Temperature fallback remains enabled to recover uncertain decoding
instead of producing runaway repetition. Manual revision keeps the full
decoder defaults. This intentionally trades some draft accuracy for less
work while recording; the original audio is retained for later improvement.
All stages request segment JSON instead of unused token-level JSON, and each
chunk validates only its selected model. The provider requests below-normal
process priority where the host permits it, to leave capacity for other apps.

One `whisper-cli` may run at a time, and at most eight saved-file jobs may wait.
Heavy manual AI actions are unavailable while any session records, and recording
waits for an existing manual AI action to finish. Stop drains draft transcription
and saves audio. Session reads, artifact reads, and restart do not launch
revision, high-quality ASR, cleanup, or translation. Deferred stages are shown
as available work rather than an active backlog. Failed work remains retryable
through an explicit action. When revision and high-quality stages use the same
model on unchanged audio, the completed full-decoder revision is reused.

Bilingual recording permits translation of new speech. It shares the hardware
scheduler at a lower priority than draft ASR and pauses when disabled. Revisions
do not automatically retranslate existing output. An interrupted live unit is
retried only by an explicit translation update after Stop.

The historical Small/Turbo/Large timings above do not establish the latency,
accuracy, or power savings of these new defaults. Lowering the thread count
limits contention but can increase elapsed inference time; battery improvement
must be measured over a representative recording session. See the
[September local performance validation](performance-validation-2026-09-08.md)
for the measured Base run, translation results, and hardware limitations.

## Limitations and future measurements

The recording has no human reference transcript, so edit distance to Large v3
is only a consistency proxy. Before adding quantized, CoreML, or whisper.cpp VAD
artifacts to packaging, repeat the same windows plus representative Chinese and
mixed-language recordings, measure peak memory and power, and compare against a
human-corrected reference. Model defaults should change when that evidence is
stronger than these measurements.

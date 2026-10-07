# Local Base performance validation — 8 September 2026

The manual-revision redesign passed the local Base dictation check below. This is a measured result on one Mac, not certification for all popular devices. Live translation is evaluated separately because its language model changes the resource budget.

## Hardware and setup

- Apple M5 Pro, 15 CPU cores, 24 GiB RAM; macOS on battery.
- Product server at localhost, real bundled whisper.cpp Base model, two CPU threads, CPU/Accelerate backend, single-candidate live decoding. No mocked speech recognition.
- The real browser microphone path received a prerecorded 48 kHz mono speech fixture through Chromium's fake audio device. The 360.7-second fixture loops and contains varied English speech slices. Real AudioWorklet capture, speech boundaries, chunk upload, transcription, persistence, polling and rendering all ran.
- A dedicated Electron app displayed the localhost product so Activity Monitor could identify its client processes. The backend ran separately and its native workers were included in process measurements.
- Earlier microphone-fixture attempts produced silence because macOS blocked access to the WAV file. Those runs were excluded. The successful fixture lived inside the temporary app bundle; the browser sandbox stayed enabled.
- Codex, Activity Monitor and unrelated applications remained open. The machine already had substantial memory use and swap before testing. Whole-machine power and swap are therefore not attributable solely to this product.

## Base dictation result

The valid recording ran from 11:42:25.875 to 11:53:00.804 UTC, with 634.165 seconds of audio. All 66 chunks completed; none failed. Revision, high-quality ASR and LLM activity stayed at zero. Stop drained the final chunk in 0.635 seconds.

CPU uses Activity Monitor's convention: **100% means one fully occupied CPU core**. The tested Mac has 15 cores.

| Measurement | Before recording | Live Base dictation | After Stop |
|---|---:|---:|---:|
| Mean total product CPU | 0.75% | 21.46% | 0.91% |
| Mean sampled physical footprint | 184 MiB | 330 MiB | 296 MiB |
| Maximum sampled physical footprint | 184 MiB | 833 MiB | 301 MiB |
| Independent CPU task, mean | 5.63 ms | 5.54 ms | 5.52 ms |
| Whole-Mac discharge estimate | 7.8 W | 9.9 W | 8.4 W |
| Thermal state | nominal | nominal | nominal |

The live CPU mean is 1.43% of this Mac's total CPU capacity. Mean components were client 10.89%, server 0.76% and Whisper 9.81% of one core. Native inference bursts averaged 152% while active; their largest whole-job average was 159%. These burst averages are not instantaneous peak CPU measurements.

Whisper took 0.620 seconds per chunk on average, 0.693 seconds at the 95th percentile, and 0.747 seconds at maximum. Total decoding wall time was 0.065 times the speech-audio duration. There was at most one active inference and no sampled queue accumulation. Local API latency was 4.88 ms at the 95th percentile, with a 7.21 ms maximum. The independent CPU probe showed no slowdown.

Activity Monitor showed green memory pressure and approximately 87–90% whole-machine CPU idle in captured live snapshots. One live client snapshot summed to approximately 462 MB across the app and its helpers. After Stop, refreshed Activity Monitor readings showed 0.0% CPU for the client helpers, 0.3% for the main client process, and 0.0 Energy Impact for each client component. Expanded client Energy Impact samples were approximately 49, 26 and 25 relative units during recording; the separately launched backend was not included in those Energy pane sums. Energy Impact is a relative score, not watts or battery percentage. [Apple's Energy pane documentation](https://support.apple.com/en-ie/guide/activity-monitor/actmntr43697/mac)

The battery gauge moved from 39% to 36% over the valid run while other applications were active. This is a whole-Mac observation, not a measured three-percentage-point product cost. No battery-life improvement percentage is claimed because the old version was not run in a controlled comparison.

## Live translation validation

The 4B translation trial worked functionally but failed the intended lightweight
memory budget. During 202.9 seconds of Base dictation with
`qwen3.5:4b`, Activity Monitor's memory-pressure graph turned yellow. After the
model unloaded it returned to green; whole-machine memory used fell from about
21.79 GB to 18.43 GB. The 4B model is therefore not the base live-translation default.

The final configuration separates **Raw translation model** from **Document model**.
Raw translation defaults to the already installed `qwen2.5:1.5b-instruct`; documents
retain their selected model, including 4B. Existing translations are preserved.
Missing translation models show a retryable error without silently loading 4B.

| Measured live configuration | Base + 4B translation | Base + 1.5B translation |
|---|---:|---:|
| Recording duration | 202.9 s | 259.9 s |
| Total CPU, mean, one-core units | 47.1% | 24.1% |
| Aggregate RSS, mean | 3.47 GiB | 1.62 GiB |
| Aggregate RSS, sampled maximum | 4.56 GiB | 2.03 GiB |
| Kernel physical footprint, mean | 4.62 GiB | 0.54 GiB |
| Kernel physical footprint, sampled maximum | 6.02 GiB | 0.90 GiB |
| Whole-Mac discharge estimate, mean | 12.8 W | 8.0 W |
| Memory pressure | yellow | green |
| Thermal state | nominal | nominal |
| Maximum sampled queued Whisper / LLM jobs | 0 / 0 | 0 / 0 |

The lighter runner reported approximately 1.1 GiB RSS and 1,102,263,090 bytes
(1.03 GiB) of Ollama model/VRAM allocation. Its much smaller kernel physical
footprint excludes some mapped or Metal residency; it must not be presented as
the entire model's memory cost. RSS also has limitations because shared pages
can be counted in more than one process. Both measures are shown above.

In the lighter run, all 27 speech chunks completed, with
Whisper averaging 0.633 seconds and a maximum
of 0.993 seconds. Stop drained the last chunk in
0.683 seconds. 50 of 51
translation units completed; the initial unit was preempted by incoming speech
and remained visibly pending for an explicit retry. There were no automatic
revised/high-quality passes or repeated retries of that unit. Chinese output
was observed in the recording UI. The independent CPU probe had a
6.52 ms 95th percentile and one
15.06 ms outlier; local API latency peaked at
5.38 ms. No sustained transcription backlog or UI stall
was observed in this run.

After Stop, the model unloaded with its one-minute keep-alive. In a subsequent
60-second idle window, total CPU averaged 1.50%
of one core with instrumentation running, aggregate RSS averaged
598 MiB, and both inference queues were empty. Memory
pressure remained green. Refreshed Activity Monitor readings after Stop showed 0.2% CPU for the main
client and 0.0% for its helpers. The final client Energy Impact was 0.2 for
the main process and 0.0 for each helper, with none preventing sleep. Earlier
unavailable Energy pane values were not interpreted as zero.

The 1.5B model is a live draft quality tradeoff. A spot check found omitted
clauses, so Raw translation now uses a dedicated translator system instruction
and only one preceding sentence of context. A real-provider recheck retained
the previously omitted theoretical-concept and code-base clauses in 1.4 seconds,
although names and garbled ASR wording still require review. The sustained
numbers above precede this final prompt-only refinement; that refinement passed
the complete checks and the single-sentence real-model check, without another
full-duration benchmark. This is not a translation-accuracy certification.

A CUA snapshot/binding issue caused an unintended explicit translation of an older
test session while setting up the 4B run. It finished before the valid 4B window;
that workload, blank reload attempts, and stale screenshots were excluded. Fresh
UI state verified the separate model choices and live Chinese output. Native
process telemetry, rather than stale UI frames, determines the numerical windows.

## Release decision and regression checks

The measured Base + 1.5B configuration is suitable for this local validation and
is the configuration selected for main. The 4B live model remains an explicit
option with a higher resource cost. The results suggest useful resource headroom,
but do not certify older, fanless, 8 GiB, Windows or Linux hardware. A longer lecture
and a lower-powered-device matrix remain necessary before making that broad claim.

`npm run check` passed: syntax/type checks, lint, all **285 tests**, and production
build. Focused coverage includes manual ASR admission, new-speech translation,
suppressed retranslation, Stop/pause/restart races, draft preemption, model-unload
cancellation, separate model settings and missing-model errors. Runtime diagnostics
also now use the current revision job counter and a model-independent Whisper
queue label.

Aggregate machine-readable measurements are in
[the benchmark summary](benchmarks/2026-09-08-local-base.json). No lecture audio,
transcripts, model binaries, or temporary browser profiles are included.

## Measurement method and limits

- Browser CPU uses cumulative CPU-seconds from Electron process metrics; the displayed Electron CPU percentage is host-normalized on this system and was not added directly to macOS process percentages.
- Backend CPU uses process CPU time. Each native Whisper process is wrapped by `/usr/bin/time -lp` to include its complete user/system CPU time and peak RSS; one-second process sampling alone would miss these subsecond workers.
- The memory table sums simultaneous `proc_pid_rusage` physical-footprint values for identified app processes at one-second intervals. It does not sum independent lifetime maxima. Sampling can miss short peaks. Whisper's complete-process maximum RSS was 280 MiB; physical footprint and RSS measure different things.
- The CPU idle baseline spans 60 seconds. The initial physical-footprint/battery baseline has only 16 one-second footprint samples, because that sampler was introduced later. The settled post-Stop check spans 70.0 seconds.
- Observer overhead includes one local API read per second, process metrics and log writes. Thermal state is macOS's pressure classification; it is not a CPU temperature sensor or a measurement of case temperature.
- Whole-Mac discharge is estimated from battery voltage times battery current sampled every five seconds. It includes display, other applications and test instrumentation. Root-only power profiling was unavailable; incomplete sampled per-process energy counters were not treated as total app energy.
- Short speech slices and one 10.5-minute run do not establish accuracy on all accents/noise, long-lecture memory bounds, or sustained behavior on fanless, older Intel, Windows/Linux or 8 GiB devices. Those remain separate hardware and duration checks. A two-thread preference is not a hard process CPU cap.

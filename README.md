# Local Lecture Copilot

A local-first lecture workspace for transcription, bilingual reading, course-grounded notes, and structured outlines. This is an NTU team project; this checkout contains Fan Yupei's Version C / Conservative Material Repairs (C6) contribution on top of the shared application.

[![macOS and Linux validation](https://github.com/FAN0020/local-lecture-copilot/actions/workflows/platform-validation.yml/badge.svg)](https://github.com/FAN0020/local-lecture-copilot/actions/workflows/platform-validation.yml) [![Windows x64 validation](https://github.com/FAN0020/local-lecture-copilot/actions/workflows/windows-validation.yml/badge.svg)](https://github.com/FAN0020/local-lecture-copilot/actions/workflows/windows-validation.yml)

## Reviewer snapshot

**Classification:** Local speech AI · desktop application · NTU team project. **Stack:** Electron, Node.js, whisper.cpp, Ollama.

| Area | Measured outcome | Evidence and scope |
| --- | --- | --- |
| Software checks | **395/395 local tests passed**; macOS, Linux, and Windows CI passed | [Verification](docs/latest-verification.md); Windows has 390 passed and 5 platform skips; providers are mocked in automated tests |
| Real speech workflow | **3/3 provisional + 3/3 requested revisions**; queues and processes drained | [Native smoke](docs/latest-verification.md#real-speech-pipeline); pinned English audio on macOS |
| ASR performance | **66/66 chunks** over 10.5 minutes; **0.620 s** mean decode per chunk | [Benchmark](docs/performance-validation-2026-09-08.md); one M5 Pro and one English fixture |
| C6 material repairs | **20 fixed slices**; proxy WER **0.3271 → 0.3243**; 2 improved, 18 unchanged | [Evaluation](docs/c6-evaluation-2026-10-07.md); Large-v3 reference is not human-verified ground truth |

## Contents

| Section | Reviewer shortcut |
| --- | --- |
| [What works](#what-works) · [Run locally](#run) | Product scope and setup |
| [Current verification](docs/latest-verification.md) | Fresh suite result and a real local speech smoke |
| [Performance report](docs/performance-validation-2026-09-08.md) | 10.5-minute local ASR and resource measurements |
| [C6 fixed-input evaluation](docs/c6-evaluation-2026-10-07.md) | Results against an unverified transcript proxy, with limits |
| [Verify](#verify) | Current command for syntax, lint, tests, and build |

This is the **PE6203 Version C / Conservative Material Repairs (C6)** contribution. It retains the shared team's audio, Whisper, persistence, and UI foundation while limiting cleanup to small validated terminology/name/number/formula substitutions supported by course material. Notes and Outline retain material-grounded generation. The [architecture](docs/architecture.md) documents the current implementation. The [fixed-input C6 evaluation](docs/c6-evaluation-2026-10-07.md) reports a modest change against an unverified transcript proxy, not a human accuracy result.

## What works

- Persistent lecture sessions stored as readable JSON plus their original uploads.
- Browser microphone recording and audio/video upload with playback.
- Local OpenAI Whisper CLI transcription with language and model selection.
- Editable raw transcript with an immutable original and up to 50 saved revisions.
- Intelligent structural paragraphing during live dictation and after final refinement, with locked manual split/merge edits.
- Bilingual Original/Translation comparison inside Raw, Cleaned, Notes, and Outline, with a persisted Original-only toggle.
- Immediate provisional-tail and sentence-stable Raw translation, plus contextual paragraph/block translation for derived documents.
- Cleaned transcripts automatically refresh through the conservative material-RAG pipeline after each completed Raw chunk; Generate remains an explicit retry/update action. Cleanup uses conservative sentence detection (including CJK punctuation, ellipses, decimals, and common abbreviations) and groups related sentences into semantic paragraphs.
- Independent cleanup, key-points, Q&A, and structured-analysis stages. C6 cleanup preserves a frozen B baseline and permits only validated material-supported substitutions; all other baseline bytes remain unchanged.
- PDF, DOC/DOCX, PPTX, RTF, text, Markdown, CSV, JSON, HTML, SRT, and VTT material extraction.
- Ollama-backed notes and outlines grounded in extracted materials with `[M1]` source markers.
- Editable derived artifacts with explicit missing/stale generation, Markdown preview, in-place progress/error retry, and restart recovery.
- Application interface localisation in English and Simplified Chinese, independent of transcription and translation languages.
- A deterministic “full study pack” workflow: clean → analyze → notes → outline.

No agent, planner, tool-selection loop, telemetry, hosted service, or cloud database is used.

## Requirements

- Node.js 20 or newer; run `npm ci` for desktop development and CI.
- Managed whisper.cpp and Base are prepared by the startup scripts. Python Whisper is not required. macOS preparation requires CMake and the command-line developer tools.
- FFmpeg is needed for audio/video formats other than supported WAV input.
- Ollama plus a local model are needed for document generation and translation; recording and Raw transcription work without them.

Normal desktop startup checks Ollama in the background. Existing installed models are reused. On a clean macOS or Windows device it downloads and verifies the official runtime, starts it, and pulls the document model (`OLLAMA_MODEL`, default `qwen3.5:4b`). Progress and retryable errors appear in provider status. Linux and browser/server mode require manual Ollama installation. Set `LECTURE_COPILOT_OLLAMA_SETUP=0` to disable desktop setup.

Raw translation independently defaults to `qwen2.5:1.5b-instruct`; install that model or explicitly choose another installed model. Setup never replaces the selected Raw translation model or silently downloads it.

```sh
ollama pull qwen3.5:4b
ollama pull qwen2.5:1.5b-instruct
```

Base is bundled for provisional and revised transcription. Larger Whisper models are optional downloads from Settings. HQ is an explicit comparison action.

## Run

```sh
npm start
# or, with automatic restarts during local development
npm run dev
```

Both commands prepare the managed Whisper runtime before starting the server.

Open [http://127.0.0.1:4318](http://127.0.0.1:4318). Browser microphone permission is required only for recording; uploads work without it.

Sessions are stored in `.lecture-copilot/` by default and survive restarts. Override paths/providers with environment variables shown in `.env.example`:

```sh
LECTURE_COPILOT_DATA=/path/to/private/data OLLAMA_MODEL=gemma3:4b npm start
```

The server deliberately binds to `127.0.0.1`. Set `HOST` only if you understand the privacy implications of exposing lecture data to a network.

## Desktop app

The desktop build wraps the same web application in Electron. It starts the
local server on an ephemeral loopback port and stores sessions under the
platform's application-data directory by default. The Settings dialog shows
the active workspace and can change it; imported audio and course materials are
copied into the selected workspace. Settings also includes an immediately
applied App language preference, persisted in the same application settings
file as the workspace path. App language, transcription/source language, and
translation target language are separate settings.

```sh
npm install
npm run desktop:dev
npm run desktop:build:mac   # macOS installer/package
npm run desktop:build:win   # Windows x64 installer/package (run on Windows)
npm run desktop:build:linux # Linux package (run on Linux)
```

Generated packages are written to `release/` and are intentionally ignored by
Git. Windows and Linux packages can be built on their native operating systems
or from a configured cross-build environment; the shared configuration can be
validated on macOS.

### Windows validation from Apple Silicon

The repository includes a Windows 11 ARM/UTM validation workflow, an SSH-based
Mac-to-VM bridge, real server/Electron/package smoke tests, diagnostic
collection, and a `windows-latest` x64 GitHub Actions job. After one-time VM
setup, run:

```sh
./scripts/run-windows-validation.sh --mode Full
```

See [Windows development and testing](docs/WINDOWS_DEVELOPMENT_AND_TESTING.md)
for VM setup, branch/worktree selection, source-provenance checks, result
locations, CI behavior, and the important distinction between Windows ARM x64
emulation and Windows x64 release validation.

## Pipeline

```text
Audio → Raw transcript ─┬→ immediate, replaceable Raw translation
                        └→ automatic material-RAG → Cleaned transcript ─┬→ contextual Cleaned translation
                                              ├→ Key points / Q&A / Analysis
                                              └→ Notes / Outline ← Course materials
                                                   │         │
                                                   ├→ Notes translation
                                                   └→ Outline translation
```

Every translation is tied to one source artifact, source fingerprint, and target
language. Raw translates finalized sentence units and one replaceable provisional
tail, using bounded preceding context for terminology; Cleaned, Notes, and Outline
use ordered semantic blocks and preserve Markdown structure. Failed, interrupted,
or stale generation never replaces its source or a newer result. P0 transcription
works without Ollama; translation and other P1/P2 generation require it.

Realtime Raw translation uses one low-priority per-session worker (manual Raw
translation allows two requests by default) inside a process-wide Ollama queue
(two active, sixteen queued by default), stable sentence caching, provisional-tail
replacement, and deduplicated persistence. Provisional and revised ASR updates
both request a refresh; the last usable translation remains visible until its
replacement is saved. Set
`LECTURE_COPILOT_TRANSLATION_DEBUG=1` to expose an in-memory lifecycle trace at
`/api/debug/translation-metrics`; set
`lecture-copilot-translation-debug=1` in local storage to add browser render
performance marks while profiling.

All provisional, manually requested revised, and optional HQ Whisper work shares one native-process slot and a
bounded queue of saved-audio file references. Live chunks are acknowledged as
soon as their WAV is persisted. Revised Whisper work enters the queue only after
Improve transcript is clicked, and HQ runs only when explicitly requested after recording stops. Final lecture WAV assembly is
streamed from those files instead of loading the entire lecture into memory.
Set `LECTURE_COPILOT_RUNTIME_DEBUG=1` to log a concise `[RUNTIME-MEM]` record
every ten seconds and expose `/api/debug/runtime`; it is disabled by default.

## Verify

```sh
npm run check
```

This runs syntax checks, repository lint rules, Node integration/unit tests, and a production bundle build. The macOS/Linux workflow additionally runs native real-speech and Electron shutdown checks; the Windows workflow retains its native PowerShell and packaged-app checks. Tests use deterministic provider doubles; they never download a model or send data over a network.

## Data and supported files

Runtime data, model files, recordings, build output, and secrets are Git-ignored. Plain text and Office Open XML extraction is local. PDF extraction prefers `pdftotext` when installed and otherwise uses a built-in best-effort text-stream extractor; scanned image-only PDFs need OCR before upload.

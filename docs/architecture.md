# Architecture

The application uses explicit transformations and bounded workers. Models do not choose tools or control the workflow. The current correction revision is `C6-raw-rag-v1`; earlier C2/C5 reports describe historical designs, including an HQ-first source that C6 supersedes.

## Data flow

```text
Microphone PCM / uploaded audio
  ├─ live speech boundaries → durable WAV segments and stable IDs
  │    → provisional Whisper ASR → revised Whisper ASR → Raw transcript
  └─ uploaded audio → explicit Whisper transcription → Raw transcript

Raw transcript
  ├─ opt-in immediate provisional-tail and live sentence translation / explicit saved-text translation
  └─ automatic Cleaned refinement after each completed Raw chunk
       → frozen Version B correction (transcript only)
       → contiguous baseline windows
       → window-scoped lexical retrieval from attached materials
       → deterministic candidate patches
       → model selects candidate IDs
       → deterministic validation and exact substitutions
       → Cleaned transcript
            → Notes / Outline / analysis / document translations

Optional high-quality audio comparison → separate HighQuality transcript
                                      (not a C6 cleanup dependency)
```

`src/app.js` controls scheduling, dependencies, persistence and API actions. `src/pipeline.js` defines artifact transformations. `src/conservative-retrieval.js`, `src/conservative-correction.js` and `src/version-b-baseline.js` implement C6 correction. `src/providers/material.js` extracts reference text. The browser and Electron shell use the same local HTTP application.

## Audio and ASR

The renderer cuts PCM at natural speech boundaries after trailing silence, with a 14-second maximum segment. It transfers Float32 frames, resamples each cut into one WAV Blob, uploads it and releases the Blob after durable acknowledgement. Server queues retain paths and segment identity, not audio buffers. Stop flushes the worklet's final samples and assembles the recording with bounded file-copy buffers. Original chunks and complete recordings remain durable until their session is deleted.

Each staged segment has a stable ID, ordinal, absolute timestamps, audio source revision and independent `provisional`, `revised` and optional `highQuality` versions. Attempt tokens and source revisions reject cancelled or superseded writes. Raw projects revised wording when available, otherwise provisional wording, without appending duplicate segments. Paragraphization preserves stable identities and manually locked boundaries.

Provisional ASR defaults to Base, then Tiny, then Small, restricted to installed models. Explicit stage selections take precedence; revision prefers Turbo, Medium, then other installed fallbacks. Base alone can run both provisional and revised passes. Revision re-reads the saved audio; the current application does not supply a contextual Whisper prompt. The phrase “prompt-assisted Raw” in older UI/history is therefore not a separate implemented stage.

Live chunks run only provisional Whisper ASR, then automatically schedule C6 material-RAG refinement from the updated Raw transcript. Revised Whisper work remains deferred and is excluded from the active backlog until the user clicks Improve transcript; session reads, Stop, and restart never enqueue it. Improve transcript can retry or use a newly selected installed revision model, and its Raw update schedules C6 again. Optional HQ comparison re-reads saved audio only through its explicit ensure endpoint. Its absence or failure does not prevent C6 correction of Raw.

When a runtime or provisional model is missing, recording reports an actionable error and Settings provides model installation. Missing revision models fall back to installed models; a failed pass preserves provisional text and source audio. Restart makes interrupted stage attempts retryable. No optional model downloads begin as a side effect of transcription or translation.

## Conservative material correction

C6 always selects `rawTranscript` as its source, including when a saved HQ artifact exists. It passes a material-free copy of that source to the frozen Version B implementation from `48ec0c1cd77fa9e8eedd71455da80453e33ee57c`. B retains its original prompts, validation, retry, source fallback and paragraph projection. A complete baseline is reused only when source, model, frozen revision and configuration match; interrupted regions can resume.

Each completed provisional or user-requested revised Whisper segment schedules this pipeline asynchronously. Concurrent chunk updates are deduplicated by the existing artifact job and stale source fingerprints force a fresh snapshot; an explicit Generate/Update action remains available as a retry when the local model was unavailable.

The baseline is divided into contiguous windows (7,000 characters by default). Each window retrieves at most three complete terminology excerpts within a 2,400-character labeled evidence budget. Ranking uses lexical anchors, rarity and passage density. There are no embeddings, vector database, web search or autonomous retrieval. Complete excerpts are selected rather than truncated to fill the budget.

Deterministic code builds exact, occurrence-addressed candidate substitutions from the local baseline and evidence. The model selects candidate IDs under a JSON schema; it cannot supply replacement transcript prose. Validators enforce source offsets, supporting quotes, terminology anchors, bounded edit distance and changed-word budgets. Grammar and claim changes, uncertainty removal, unsupported numeric edits and overlapping replacements are rejected. Accepted edits apply from right to left; every byte outside accepted spans remains the B baseline.

No evidence, no candidates, abstention, rejected selections or a repair-provider failure retains the baseline. Cancellation propagates. Failure to generate B remains an error, preserving Raw and audio for retry. Material text is untrusted evidence, never instructions. These conservative checks reduce unsupported changes; they do not prove every accepted repair is factually correct.

Artifacts persist source/material/configuration fingerprints, baseline provenance, windows, excerpts, candidate patches, model responses, accepted/rejected edits and errors. Material changes invalidate C6 and dependent generated artifacts while valid B can be reused. Manual documents remain authoritative. Source/material fingerprint checks reject stale writes; an ensure can retry from a fresh snapshot. Resumed dictation may overlap cleanup without letting cleanup hide active recording or publish a result for an obsolete Raw source.

The fixed-input Version C rerun supplies saved, hash-verified B output and Raw instead of regenerating ASR/B. Ground truth is used only for evaluation. Notes and Outline have a separate material-grounded generation path; they do not reuse correction retrieval as unrestricted permission to rewrite Raw.

## Translation and UI actions

Bilingual explicitly enables live translation. Merely recording or pressing Stop does not start translation when disabled. Opening sessions, switching tabs and GET artifact requests read saved data. Improve transcript and Translate issue explicit POST actions; Generate retries missing or stale derived artifacts. Valid saved artifacts are reused.

Live Raw translation starts from provisional ASR instead of waiting for revision. It assembles stable sentences plus one replaceable unfinished-tail unit. Provisional and revised ASR updates both request a refresh; while a unit is refreshed, its last usable translation stays visible. Each unit has a stable ID, source revision, translation revision/language, status and an attempted-at marker. One live request runs at a time per session with bounded preceding source context. Source renewals are coalesced, outdated results are rejected, and the newest saved wording is translated next. Failed revisions are not automatically retried until newer source arrives or the user retries. Pausing Bilingual aborts its worker; restarting a saved enabled session does not resume model work. Resumed recording excludes the old untranslated backlog.

Corrections keep the previous translation visible until the automatic live refresh or an explicit translation action succeeds. Source/target checks prevent stale results from overwriting current units. Manual Raw translation processes a bounded snapshot, with up to two concurrent sentence calls by default; simultaneous manual Raw requests are rejected before expensive work is queued. Recording in another session blocks manual Raw work. A target/model change preserves saved output and does not trigger a download or automatic replacement.

Raw translation defaults to `qwen2.5:1.5b-instruct`, independently of the document model. An unavailable selected model produces a retryable error without falling back to a larger model. Cleaned, Notes and Outline translations preserve Markdown structure and store source/target dependencies separately. The legacy `translation` API key aliases Cleaned translation.

Raw display groups stable sentence units into compact bilingual rows; presentation never changes transcript bytes. Main's title-edit draft handling, adaptive session polling, model controls, PCM flush, localization and scroll-follow behavior remain integrated with C6's material extraction, re-extraction and activity log.

## Resource ownership and shutdown

A bounded scheduler runs one Whisper inference task at a time: provisional ASR (priority 0), manually requested revised ASR (1), then optional HQ (3). ASR can requeue from durable files, but revised work is never admitted without Improve transcript. Immediate Raw translation and automatic C6 refinement use the separately bounded Ollama scheduler. Completed entries are released and overflow is recoverable from saved audio.

All model generation shares a separate Ollama scheduler (two active, sixteen queued by default). Requests have cancellation, output/context limits and provider timeouts. The lifecycle manager bounds runner age/request count and supports unload. The provider's default idle keep-alive is one minute; application close explicitly unloads used models. No unbounded translation retry loop follows Stop or source edits.

Closing the app aborts both schedulers, waits for recovery/revision/translation/artifact jobs and the Whisper provider, terminates native children and removes tracked temporary directories. Whisper retains a bounded 64 KiB diagnostic tail and has a ten-minute default process timeout. Electron awaits server shutdown before quitting.

## Persistence and deployment

`SessionStore` uses `FileStorageAdapter` for ordinary local files: recordings, chunks, transcript stage versions, paragraphization, derived artifacts, reference material and bounded activity logs. Atomic writes preserve the workspace across restart. Session IDs, recording segment IDs and daily title indexes survive deletion/restart without accidental reuse.

Application settings independently persist workspace location, UI locale and installed ASR model choices. Session settings hold transcription/translation languages and separate document/Raw translation models. User text is never run through UI localization.

Electron resolves writable user-data and model paths separately from packaged resources. Windows packages carry x64 Electron, x64 Whisper and the Base model; optional Ollama and larger Whisper models remain independent. Native validation evidence must identify the tested source and package. Real WAV injection into a packaged Windows app validates the software pipeline; it does not establish physical microphone-hardware behavior.

## First-run provider setup and validation

Normal Electron startup owns an asynchronous Ollama bootstrap. It reuses existing installed models or installs a verified macOS/Windows runtime and pulls the configured document model. Linux installation remains manual. Browser/server startup does not install software. Health exposes progress; an explicit retry restarts failed setup. Smoke mode disables bootstrap to keep the provider-unavailable scenario reproducible.

The document-model catalog is briefly cached. New sessions choose an installed model, and unavailable saved document models migrate to an available model. The independently selected Raw translation model is preserved. A missing provider produces an actionable 503 before explicit document processing; Raw and saved audio remain available. Provider readiness never triggers saved-document generation.

Shutdown drains inference before stopping an owned Ollama server, awaits child exit, and closes the HTTP listener even when cleanup fails. An already-running external Ollama server is not owned or terminated. Setup cancellation waits for its command process before deleting temporary downloads.

The Windows validation workflow remains the native x64 harness. A separate macOS/Linux matrix runs the same suite, managed Whisper preparation, multi-chunk real-speech dictation, Electron real-speech validation, and shutdown checks. These jobs establish software-runtime evidence; physical microphone capture and fresh-device Ollama installation remain separate checks.

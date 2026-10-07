# Managed STT runtime

Generated whisper.cpp binaries and GGML models are placed in platform-specific
subdirectories by `npm run stt:prepare`. They are build inputs, not source
files, and are intentionally ignored by Git. Desktop packaging copies the
matching runtime into the application's resources directory.

The packaged Base model remains in this read-only runtime directory. Models
installed from the application are verified and stored separately under the
application's writable user-data directory (`models/whisper.cpp`), never in
packaged resources or lecture workspaces.

The multistage policy resolves each role independently from installed models:

* live draft: Base first, then Tiny/Small and other installed fallbacks;
* manual revision: Large v3 Turbo first, then Medium/Large and smaller fallbacks;
* requested high quality: Large v3 first, then Large v3 Turbo/Medium and smaller
  fallbacks.

Explicit stage selections take priority. Missing models are skipped, unavailable
models advance to the next installed candidate, and every stage records the
model actually used. The packaged Base model supports both live drafts and
manual improvement without another download.

Recording runs only the draft pass. Improve transcript starts revision from saved
audio after Stop. Higher-quality transcription and language-model processing
require explicit actions; Stop, reopening tabs, and application restart do not
start them. Revisions and high-quality passes share completed results when the
model and source audio match, avoiding an identical full-decoder pass.

CPU inference defaults to two threads (maximum four), with a best-effort
below-normal process priority. Live drafts use a single decoding candidate with
temperature fallback preserved; manual revision retains full decoding. Segment
JSON avoids producing unused token-level diagnostics. Native work is serialized
with a bounded queue, and manual AI processing is kept separate from recording
to avoid repeated process aborts and model reloads.

The pinned whisper.cpp b4938 macOS runtime uses Accelerate/CPU with `--no-gpu`
because packaged Metal model loading has failed. See `docs/asr-benchmark.md`
for historical model measurements and the limits of applying those accelerated
results to current defaults. Quantized and CoreML variants require managed
registry support and target-runtime validation before selection.

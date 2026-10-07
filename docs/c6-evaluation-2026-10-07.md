# Version C / C6 fixed-input evaluation — 7 October 2026

## Run definition

| Field | Value |
| --- | --- |
| Pipeline | Current Version C C6 material-supported terminology repair; frozen Version B transcript is the baseline |
| Cases | 20 fixed slices; source manifest SHA-256 `d94743103ad523a037c92e01ac93caf11ff4a6f069b4cb1cd3bf748acfb664a0` |
| Model | Local Ollama `qwen3.5:4b`, digest `2a654d98e6fba55d452b7043684e9b57a947e393bbffa62485a7aac05ee4eefd` |
| Parameters | Temperature 0.1, seed 42, 120-second provider timeout, forced cleanup |
| Software fingerprint | `3e1bc4ee71954f38e148f41e8c1e4fcbb54cc46a350777c45fac853f4ca13ba3` |
| Run fingerprint | `a926c65da47260b32031bbe28ab438d7b3f0f72f477484751ab0c2c1716b6141` |

The runner reused the exact saved Whisper Base text, Version B outputs, and PDF extraction method. It did not rerun speech recognition or expose the comparison reference to the correction model. The case transcripts, recordings, course materials, and per-case outputs remain local and are not part of this repository.

## Results

The comparison reference is the saved Whisper Large-v3 transcript. It is **not human-verified ground truth**. Text was lowercased, punctuation was removed, and whitespace was normalized. WER and CER are macro averages across the 20 cases; lower is better.

| Metric vs Large-v3 transcript proxy | Version B | C6 | Change |
| --- | ---: | ---: | ---: |
| Word error rate | 0.3271 | **0.3243** | -0.0028 |
| Character error rate | 0.2319 | **0.2308** | -0.0011 |
| SequenceMatcher similarity, default settings | 0.5631 | **0.5939** | +0.0308 |
| SequenceMatcher similarity, `autojunk=False` | 0.8131 | **0.8141** | +0.0010 |

C6 changed two of 20 transcripts. By proxy WER, two cases improved, 18 were unchanged, and none worsened. Three local model calls completed with zero provider errors; no case was degraded. The total run took 8.97 seconds. A spot check found the two accepted terminology changes aligned with the selected course materials. One proper-name error in the same material-heavy example remained uncorrected.

## Decision and limits

**Decision: hold broader quality claims.** The proxy metrics show a small improvement over B, but Large-v3 output can contain errors of its own and cannot establish human transcription accuracy. The 20 slices are a narrow fixed set, and 18 stayed unchanged. This run does not measure comprehension, note quality, user preference, or generalization to other lectures, languages, models, or devices. The result supports a reproducible engineering evaluation, not a claim that C6 is more accurate overall.

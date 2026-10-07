import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { artifactForStage, runStage } from './pipeline.js';
import { ARTIFACT_KEYS, DEFAULT_LIVE_TRANSLATION_MODEL, STAGES, fingerprint, json, nonEmpty, now, publicSession, readBody, readJson } from './lib.js';
import { ASR_MODEL_PREFERENCES, ASR_PRIORITY, ASR_STAGE, InferenceScheduler, isAbortError, resolveAsrModelPlan, transcriptVersion } from './asr-pipeline.js';
import { DEFAULT_STT_LANGUAGE, DEFAULT_STT_MODEL, STT_LANGUAGES, STT_MODELS } from './providers/stt.js';
import { assembleRawUnits, RAW_TRANSLATION_SYSTEM, rawTranslationContext, rawTranslationPrompt, rawUnitNeedsTranslation } from './raw-translation.js';
import { createTranslationProfiler, wordCount } from './translation-profiler.js';
import { OllamaLifecycle } from './llm-lifecycle.js';
import { CORRECTION_REVISION } from './conservative-correction.js';
import { summarizeCorrectionMaterial } from './conservative-retrieval.js';
import { OLLAMA_BOOTSTRAP_ACTIVE_STATES } from './ollama-bootstrap.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_ROOT = path.resolve(__dirname, '..', 'web');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};
const DERIVED_STAGE_BY_ARTIFACT = {
  keyPoints: 'key-points',
  qa: 'qa',
  structuredAnalysis: 'analysis',
};
const DEFAULT_LLM_MODEL = 'qwen3.5:4b';
const LLM_MODEL_CACHE_MS = 2_000;

function route(pathname) {
  return pathname.split('/').filter(Boolean).map(decodeURIComponent);
}

function processing(stage, status, message, extra = {}) {
  return { stage, status, message, ...extra };
}

function supportsStagedAsr(runtime) {
  return Boolean(runtime && runtime.ready !== false && Array.isArray(runtime.installedModels) && runtime.installedModels.length >= 1 &&
    runtime.installedModels.some((model) => ASR_MODEL_PREFERENCES.provisional.includes(model)) &&
    runtime.installedModels.some((model) => ASR_MODEL_PREFERENCES.revised.includes(model)));
}

export function createApp({
  store,
  stt,
  llm,
  materials,
  webRoot = DEFAULT_WEB_ROOT,
  settings = {},
  translationProfiler = createTranslationProfiler(),
  translationConcurrency = process.env.LECTURE_COPILOT_TRANSLATION_CONCURRENCY || 2,
  sttQueueLimit = process.env.LECTURE_COPILOT_STT_QUEUE_LIMIT || 8,
  llmConcurrency = process.env.LECTURE_COPILOT_LLM_CONCURRENCY || 2,
  llmQueueLimit = process.env.LECTURE_COPILOT_LLM_QUEUE_LIMIT || 16,
  llmRecycleRequests = process.env.LECTURE_COPILOT_OLLAMA_RECYCLE_REQUESTS || 25,
  llmRunnerMaxAgeMs = process.env.LECTURE_COPILOT_OLLAMA_RUNNER_MAX_AGE_MS || 300_000,
  runtimeDebug = process.env.LECTURE_COPILOT_RUNTIME_DEBUG === '1',
  ollamaBootstrap = null,
}) {
  const active = new Set();
  const derivedJobs = new Map();
  const rawTranslationJobs = new Map();
  const liveTranslationRuns = new Map();
  const liveTranslationBootstrapWaiters = new Map();
  const manualRequests = new Set();
  const asrRevisionJobs = new Map();
  const rawTranslationControllers = new Map();
  const rawTranslationConcurrency = Math.min(4, Math.max(1, Number(translationConcurrency) || 1));
  const inferenceScheduler = new InferenceScheduler({ concurrency: 1, maxQueued: Math.min(32, Math.max(2, Number(sttQueueLimit) || 8)) });
  const llmScheduler = new InferenceScheduler({
    concurrency: Math.min(4, Math.max(1, Number(llmConcurrency) || 2)),
    maxQueued: Math.min(64, Math.max(2, Number(llmQueueLimit) || 16)),
  });
  const llmLifecycle = new OllamaLifecycle({
    provider: llm,
    maxRequests: llmRecycleRequests,
    maxRunnerAgeMs: llmRunnerMaxAgeMs,
  });
  let llmModelCatalog = { checkedAt: 0, models: null };
  let llmModelCatalogRequest = null;
  let llmSequence = 0;
  let closing = false;

  async function installedLlmModels({ refresh = false } = {}) {
    if (typeof llm.listModels !== 'function') return null;
    if (!refresh && llmModelCatalog.models && Date.now() - llmModelCatalog.checkedAt < LLM_MODEL_CACHE_MS) {
      return llmModelCatalog.models;
    }
    if (llmModelCatalogRequest) return llmModelCatalogRequest;
    llmModelCatalogRequest = Promise.resolve().then(() => llm.listModels()).catch(() => []).then((models) => {
      const normalized = [...new Set((models || []).map((model) => String(model || '').trim()).filter(Boolean))];
      llmModelCatalog = { checkedAt: Date.now(), models: normalized };
      return normalized;
    }).finally(() => {
      llmModelCatalogRequest = null;
    });
    return llmModelCatalogRequest;
  }

  function availableLlmModel(requested, installed) {
    if (!installed?.length) return null;
    const selected = String(requested || '').trim();
    if (installed.includes(selected)) return selected;
    if (selected && !selected.includes(':')) {
      const latest = installed.find((model) => model === `${selected}:latest`);
      if (latest) return latest;
    }
    const configuredDefault = String(process.env.OLLAMA_MODEL || DEFAULT_LLM_MODEL).trim();
    return installed.includes(configuredDefault) ? configuredDefault : installed[0];
  }

  async function reconcileSessionLlmModel(session, { refresh = false, required = false } = {}) {
    const installed = await installedLlmModels({ refresh });
    if (required && Array.isArray(installed) && installed.length === 0) {
      throw Object.assign(new Error('Ollama is not running or has no installed models. Start Ollama, then install a model (for example: ollama pull qwen3.5:4b).'), {
        status: 503,
        code: 'OLLAMA_NOT_READY',
      });
    }
    const selected = availableLlmModel(session.llmModel, installed);
    if (!selected || selected === session.llmModel) return session;
    console.warn(`Ollama model “${session.llmModel || 'unknown'}” is unavailable; using installed model “${selected}” for session ${session.id}.`);
    return store.updateMeta(session.id, { llmModel: selected });
  }

  function combinedSignal(first, second) {
    if (!first) return second;
    if (!second) return first;
    return AbortSignal.any([first, second]);
  }

  function enqueueLlm(options, { priority = 4, key, label = 'LLM generation' } = {}) {
    const jobKey = key || `llm:${++llmSequence}`;
    const metadata = {
      sessionId: options.sessionId || null,
      requestType: options.requestType || label,
      model: options.model,
      promptCharacters: String(options.prompt || '').length,
      estimatedPromptTokens: Math.ceil(String(options.prompt || '').length / 4),
      retrievedContextCharacters: Number(options.retrievedContextCharacters) || 0,
      numCtx: Number(options.numCtx) || null,
      numPredict: Number(options.numPredict) || null,
    };
    return llmScheduler.enqueue({
      priority,
      key: jobKey,
      label,
      metadata,
      task: ({ signal }) => llmLifecycle.generate({ ...options, signal: combinedSignal(options.signal, signal) }, metadata),
    });
  }

  const llmForSession = (sessionId) => ({
    generate: (options) => enqueueLlm({ ...options, sessionId }),
    listModels: (...args) => llm.listModels?.(...args),
  });

  function handleDetachedRawTranslationError(sessionId, error) {
    if (error.code === 'ENOENT' || error.status === 404 || error.code === 'OLLAMA_NOT_READY') return;
    console.error(`Automatic raw translation failed for ${sessionId}:`, error);
  }

  function handleDetachedAsrError(sessionId, stage, error) {
    if (isAbortError(error)
      || error?.code === 'ENOENT'
      || error?.status === 404
      || error?.code === 'STALE_ASR_RESULT'
      || error?.code === 'NO_SPEECH'
      || error?.code === 'STT_MODEL_MISSING'
      || error?.code === 'INFERENCE_QUEUE_FULL'
      || error?.code === 'OLLAMA_NOT_READY'
      || error?.code === 'ABORT_ERR') return;
    console.error(`Background ${stage} ASR failed for ${sessionId}:`, error);
  }

  async function pauseLiveTranslation(sessionId) {
    const run = liveTranslationRuns.get(sessionId);
    if (run) { run.pending = false; run.cancelled = true; }
    const translation = rawTranslationControllers.get(sessionId);
    if (translation?.newOnly) translation.controller.abort(Object.assign(new Error('Live translation was paused'), { name: 'AbortError', code: 'ABORT_ERR' }));
    inferenceScheduler.cancelWhere((entry) => entry.metadata?.liveTranslationSession === sessionId, 'Live translation was paused');
    await Promise.allSettled([run?.promise, translation?.newOnly ? rawTranslationJobs.get(sessionId) : null].filter(Boolean));
  }

  function deferLiveTranslationUntilBootstrapReady(sessionId, { final = false } = {}) {
    const existing = liveTranslationBootstrapWaiters.get(sessionId);
    if (existing) {
      existing.final ||= final;
      return;
    }
    const waiter = { final, promise: null };
    liveTranslationBootstrapWaiters.set(sessionId, waiter);
    waiter.promise = ollamaBootstrap.ensureReady()
      .then((setup) => {
        if (liveTranslationBootstrapWaiters.get(sessionId) !== waiter) return null;
        liveTranslationBootstrapWaiters.delete(sessionId);
        if (closing || setup?.status !== 'ready') return null;
        llmModelCatalog = { checkedAt: 0, models: null };
        return requestLiveTranslation(sessionId, { final: waiter.final });
      })
      .catch((error) => {
        if (!closing) handleDetachedRawTranslationError(sessionId, error);
      })
      .finally(() => {
        if (liveTranslationBootstrapWaiters.get(sessionId) === waiter) liveTranslationBootstrapWaiters.delete(sessionId);
      });
  }

  async function requestLiveTranslation(sessionId, { final = false } = {}) {
    if (closing) return;
    const session = await store.get(sessionId);
    if (!session.liveTranslation?.enabled || (!final && !['recording', 'finalizing'].includes(session.dictation?.status))) return;
    const bootstrapState = ollamaBootstrap?.snapshot?.();
    if (bootstrapState && OLLAMA_BOOTSTRAP_ACTIVE_STATES.has(bootstrapState.status)) {
      await store.setLiveTranslation(sessionId, { status: 'pending' });
      deferLiveTranslationUntilBootstrapReady(sessionId, { final });
      return;
    }
    const existing = liveTranslationRuns.get(sessionId);
    if (existing && !existing.cancelled) {
      existing.pending = true;
      existing.final ||= final;
      return;
    }
    const run = { pending: true, final, cancelled: false, promise: null };
    liveTranslationRuns.set(sessionId, run);
    await store.setLiveTranslation(sessionId, { status: 'pending' });
    run.promise = (async () => {
      while (run.pending && !run.cancelled && !closing) {
        const finalBatch = run.final;
        run.pending = false;
        run.final = false;
        const current = await store.get(sessionId);
        if (!current.liveTranslation?.enabled || manualRequests.size || asrRevisionJobs.size
          || (!finalBatch && !['recording', 'finalizing'].includes(current.dictation?.status))) break;
        await store.setLiveTranslation(sessionId, { status: 'running' });
        await scheduleRawTranslation(sessionId, { newOnly: true, final: finalBatch });
      }
    })().catch((error) => handleDetachedAsrError(sessionId, 'live-translation', error)).finally(async () => {
      if (liveTranslationRuns.get(sessionId) === run) {
        liveTranslationRuns.delete(sessionId);
        await store.setLiveTranslation(sessionId, { status: 'idle' }).catch(() => {});
      }
    });
  }

  async function logActivity(sessionId, entry) {
    const scope = String(entry.scope || 'system').toUpperCase();
    console.info(`[${scope}] ${entry.code}`, entry.details || {});
    return store.appendActivityLog?.(sessionId, entry);
  }

  function visibleMaterial(material) {
    const { storedPath, extractedText, ...visible } = material;
    return visible;
  }

  async function extractStoredMaterial(sessionId, record, { reextract = false } = {}) {
    if (reextract) {
      await store.setMaterialExtraction(sessionId, record.id, {
        extractionState: 'extracting', extractionStep: 'material-reextraction-started',
        extractionError: null, extractedText: '', retrieval: null,
      });
      await logActivity(sessionId, {
        scope: 'material', code: 'material-reextraction-started', materialId: record.id,
        details: { filename: record.filename, bytes: record.bytes },
      });
    } else {
      await store.setMaterialExtractionProgress(sessionId, record.id, {
        extractionState: 'extracting', extractionStep: 'material-format-detected',
      });
    }
    try {
      const extracted = await materials.extract(record.storedPath, record.filename, {
        onProgress: async ({ code, details }) => {
          await store.setMaterialExtractionProgress(sessionId, record.id, { extractionState: 'extracting', extractionStep: code });
          await logActivity(sessionId, {
            scope: 'material', code, materialId: record.id,
            details: { filename: record.filename, ...details },
          });
        },
      });
      const { text, ...metadata } = extracted;
      const preparedRetrieval = summarizeCorrectionMaterial(text);
      const { chunks, ...retrieval } = preparedRetrieval;
      await logActivity(sessionId, {
        scope: 'material', code: 'material-lexical-chunks-ready', materialId: record.id,
        details: { filename: record.filename, ...retrieval },
      });
      for (const chunk of chunks.slice(0, 20)) {
        await logActivity(sessionId, {
          scope: 'material', code: 'material-chunk-prepared', materialId: record.id,
          details: { filename: record.filename, ...chunk, chunks: chunks.length },
        });
      }
      if (chunks.length > 20) {
        await logActivity(sessionId, {
          scope: 'material', code: 'material-chunks-omitted', materialId: record.id,
          details: { filename: record.filename, count: chunks.length - 20 },
        });
      }
      const material = await store.setMaterialExtraction(sessionId, record.id, {
        ...metadata, retrieval, extractedText: text, extractionError: null,
        extractionState: 'complete', extractionStep: 'material-extraction-complete',
      });
      await logActivity(sessionId, {
        scope: 'material', code: 'material-extraction-complete', status: 'success', materialId: record.id,
        details: { filename: record.filename, extractor: metadata.extractor, characterCount: metadata.characterCount, chunkCount: retrieval.chunkCount },
      });
      return material;
    } catch (error) {
      await store.setMaterialExtraction(sessionId, record.id, {
        extractionError: error.message, extractionState: 'error', extractionStep: 'material-extraction-error',
        extractedText: '', retrieval: null,
      });
      await logActivity(sessionId, {
        scope: 'material', code: 'material-extraction-error', status: 'error', materialId: record.id,
        details: { filename: record.filename, error: error.message },
      });
      error.status ||= 422;
      error.materialId = record.id;
      throw error;
    }
  }

  async function withActive(lock, work) {
    if (active.has(lock)) throw Object.assign(new Error('A transcription job is already running for this session'), { status: 409 });
    active.add(lock);
    try {
      return await work();
    } finally {
      active.delete(lock);
    }
  }

  async function withStage(sessionId, stage, work) {
    const lock = `${sessionId}:${stage}`;
    if (active.has(lock)) throw Object.assign(new Error(`${stage} is already running`), { status: 409 });
    active.add(lock);
    try {
      // Dictation may resume while cleanup is still working. The session has
      // one foreground processing slot, so do not replace an active dictation
      // status with cleanup (or let cleanup replace it when it finishes).
      const current = await store.get(sessionId);
      if (!['recording', 'finalizing'].includes(current.dictation?.status)) {
        await store.processing(sessionId, processing(stage, 'running', `Running ${stage}…`, { startedAt: now() }));
      }
      const result = await work();
      const finished = await store.get(sessionId);
      if (finished.processing?.stage === stage) {
        await store.processing(sessionId, processing(stage, 'success', `${stage} completed`, { finishedAt: now() }));
      }
      return result;
    } catch (error) {
      await store.get(sessionId).then((current) => {
        if (current.processing?.stage === stage) {
          return store.processing(sessionId, processing(stage, 'error', error.message, { finishedAt: now() }));
        }
        return null;
      }).catch(() => {});
      throw error;
    } finally {
      active.delete(lock);
    }
  }

  function recordTranscriptStageCompletion(sessionId, stage, sequence, updated) {
    if (![ASR_STAGE.PROVISIONAL, ASR_STAGE.REVISED].includes(stage)) return;
    translationProfiler.record(sessionId, 'transcript-finalized', {
      sourceFingerprint: fingerprint(updated.artifact?.content || ''),
      sourceCharacters: updated.artifact?.content?.length || 0,
      sourceWords: wordCount(updated.artifact?.content || ''),
      sequence,
      stage,
    });
  }

  async function runTranscriptStage(sessionId, segmentId, stage, { force = false, signal, model: selectedModel, fallbacks: selectedFallbacks } = {}) {
    const begun = await store.beginTranscriptStage(sessionId, segmentId, stage, { force, model: selectedModel });
    if (begun.skip) return begun;
    const complete = (result) => store.completeTranscriptStage(sessionId, segmentId, stage, result, {
      token: begun.token,
      sourceRevision: begun.sourceRevision,
    });
    if (!begun.hasSpeech) {
      return complete({ content: '', language: begun.language, provider: 'whisper.cpp', model: begun.model });
    }
    const fallbacks = selectedFallbacks || (begun.fallbacks.length ? begun.fallbacks : [begun.model].filter(Boolean));
    let lastError = null;
    let attemptedModel = begun.model;
    for (const model of fallbacks) {
      attemptedModel = model;
      try {
        const result = await stt.transcribe(begun.audioPath, {
          model,
          language: begun.language,
          stage,
          signal,
        });
        const updated = await complete({ ...result, model: result.model || model });
        recordTranscriptStageCompletion(sessionId, stage, begun.segment?.chunkSequence, updated);
        if ([ASR_STAGE.PROVISIONAL, ASR_STAGE.REVISED].includes(stage)) {
          void ensureDerivedArtifacts(sessionId, 'cleanedTranscript')
            .catch((error) => handleDetachedAsrError(sessionId, 'material-rag', error));
          await requestLiveTranslation(sessionId).catch((error) => handleDetachedAsrError(sessionId, 'live-translation', error));
        }
        return updated;
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw error;
        if (error.code === 'NO_SPEECH') {
          const updated = await complete({ content: '', language: begun.language, provider: 'whisper.cpp', model });
          recordTranscriptStageCompletion(sessionId, stage, begun.segment?.chunkSequence, updated);
          return updated;
        }
        lastError = error;
        if (error.code === 'STT_MODEL_MISSING' || error.status === 503) continue;
        break;
      }
    }
    const error = lastError || Object.assign(new Error(`No ASR model was available for ${stage}`), { status: 503, code: 'STT_MODEL_MISSING' });
    await store.failTranscriptStage(sessionId, segmentId, stage, error, {
      token: begun.token,
      sourceRevision: begun.sourceRevision,
      model: attemptedModel,
    });
    throw error;
  }

  function enqueueTranscriptStage(sessionId, segmentId, stage, options = {}) {
    return inferenceScheduler.enqueue({
      priority: ASR_PRIORITY[stage],
      key: `${sessionId}:${segmentId}:${stage}`,
      label: `${stage} ${segmentId}`,
      preemptible: stage !== ASR_STAGE.PROVISIONAL,
      task: ({ signal }) => runTranscriptStage(sessionId, segmentId, stage, { ...options, signal }),
    });
  }

  function enqueueWhisperTranscription(key, audioPath, options, { priority, preemptible, label }) {
    return inferenceScheduler.enqueue({
      priority,
      key,
      label,
      preemptible,
      task: ({ signal }) => stt.transcribe(audioPath, { ...options, signal }),
    });
  }

  async function ensureLiveRevisions(sessionId, { manual = false } = {}) {
    const session = await store.get(sessionId);
    if (!session.transcriptSegments?.length) return session.artifacts.rawTranscript;
    const runtime = manual ? await stt.status?.() : null;
    const configured = manual ? await settings.get?.() : null;
    const plan = manual ? resolveAsrModelPlan(runtime?.installedModels || STT_MODELS, { selectedModel: session.sttModel, stageModels: configured?.asrModels }) : null;
    const pending = session.transcriptSegments.filter((segment) => segment.versions && (!segment.versions.revised
      || (manual && (segment.versions.revised.model !== plan.models.revised || segment.stages?.revised?.status === 'error'))));
    for (const segment of pending) {
      if (closing) break;
      try {
        await enqueueTranscriptStage(sessionId, segment.id, ASR_STAGE.REVISED, manual ? { model: plan.models.revised, fallbacks: plan.fallbacks.revised, force: Boolean(segment.versions?.revised) } : {});
      } catch (error) {
        handleDetachedAsrError(sessionId, ASR_STAGE.REVISED, error);
      }
    }
    const current = await store.get(sessionId);
    if (manual && current.transcriptSegments.some((segment) => segment.hasSpeech && (!segment.versions?.revised || segment.stages?.revised?.status === 'error'))) {
      throw Object.assign(new Error('Raw revision failed. Check installed Whisper models and retry.'), { status: 503, code: 'ASR_REVISION_FAILED' });
    }
    return current.artifacts.rawTranscript;
  }

  async function ensureHighQualityTranscript(sessionId) {
    const session = await store.get(sessionId);
    if (!session.transcriptSegments?.length) return null;
    if (['recording', 'finalizing'].includes(session.dictation?.status)) {
      return session.artifacts.highQualityTranscript || null;
    }
    const pending = session.transcriptSegments.filter((segment) => segment.versions && !segment.versions.highQuality);
    for (const segment of pending) {
      if (closing) break;
      try {
        await enqueueTranscriptStage(sessionId, segment.id, ASR_STAGE.HIGH_QUALITY);
      } catch (error) {
        handleDetachedAsrError(sessionId, ASR_STAGE.HIGH_QUALITY, error);
      }
    }
    const current = await store.get(sessionId);
    const artifact = current.artifacts.highQualityTranscript;
    if (artifact?.generationState === 'complete' && artifact.content) return artifact;
    const failed = current.transcriptSegments.filter((segment) => segment.stages?.highQuality?.status === 'error');
    if (failed.length) {
      throw Object.assign(new Error(`High-quality audio transcription failed for ${failed.length} segment${failed.length === 1 ? '' : 's'}. Retry after checking the installed Whisper models.`), {
        status: 503,
        code: 'HIGH_QUALITY_ASR_FAILED',
      });
    }
    throw Object.assign(new Error('The original audio did not contain recognizable speech for the high-quality transcript.'), { status: 422, code: 'NO_SPEECH' });
  }

  async function generateStage(sessionId, stage) {
    return withStage(sessionId, stage, async () => {
      const session = await reconcileSessionLlmModel(await store.get(sessionId), { required: true });
      const result = await runStage({
        stage,
        session,
        llm: llmForSession(sessionId),
        onCleanupProgress: stage === 'cleanup'
          ? (artifact) => store.setArtifact(sessionId, 'cleanedTranscript', artifact)
          : undefined,
        onCleanupLog: stage === 'cleanup'
          ? (entry) => logActivity(sessionId, { scope: 'revision', ...entry })
          : undefined,
      });
      // Persist before the stage is marked successful so a source/target change
      // cannot leave a discarded stale result reported as completed.
      return store.setArtifact(sessionId, result.key, result.artifact);
    });
  }

  async function ensureGeneratedArtifact(sessionId, key, stage, { before } = {}) {
    let staleError;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (before) await before();
      const session = await store.get(sessionId);
      const artifact = session.artifacts[key];
      const needsCurrentCleanup = key === 'cleanedTranscript' && artifact?.source !== 'manual-edit'
        && artifact?.pipelineRevision !== CORRECTION_REVISION;
      if (!needsCurrentCleanup && store.artifactIsValid(session, key)) return artifact;
      try {
        return await generateStage(sessionId, stage);
      } catch (error) {
        if (error.code !== 'STALE_RESULT') throw error;
        staleError = error;
        // Source edits, course materials, and target-language changes can race. Retry
        // from a fresh session snapshot so the ensure request still fulfills
        // the user's latest intent.
      }
    }
    throw staleError || Object.assign(new Error('The source kept changing while generation was running. Retry when editing pauses.'), { status: 409, code: 'STALE_RESULT' });
  }

  function scheduleRawTranslation(sessionId, { final = false, newOnly = false } = {}) {
    if (closing) return Promise.resolve(null);
    if (rawTranslationJobs.has(sessionId)) return rawTranslationJobs.get(sessionId);
    const queueId = translationProfiler.record(sessionId, 'queued', { final });
    const finalizeTail = final;
    let sourceFingerprint = fingerprint('');
    const controller = new AbortController();
    const translationState = { controller, sourceFingerprint: '', targetLanguage: '', newOnly };
    rawTranslationControllers.set(sessionId, translationState);
    const job = (async () => {
      const session = newOnly ? await store.get(sessionId) : await reconcileSessionLlmModel(await store.get(sessionId), { required: true });
      const raw = session.artifacts.rawTranscript?.content || '';
      if (!raw) return null;
      sourceFingerprint = fingerprint(raw);
      const targetLanguage = session.targetLanguage || 'Chinese';
      translationState.sourceFingerprint = sourceFingerprint;
      translationState.targetLanguage = targetLanguage;
      const assembled = assembleRawUnits(raw, session.artifacts.rawTranslation, {
        finalizeTail,
        targetLanguage,
        sourceSegments: session.paragraphization?.segments || [],
      });
      const translationUnits = [...assembled.segments, assembled.pendingTranslation].filter(Boolean);
      const firstLiveOrdinal = newOnly ? assembleRawUnits(session.dictation?.transcriptPrefix || '').segments.length : 0;
      const eligible = (unit) => rawUnitNeedsTranslation(unit) && (!newOnly || (unit.ordinal >= firstLiveOrdinal
        && !unit.liveTranslationAttemptedAt && unit.status !== 'error'));
      translationProfiler.record(sessionId, 'worker-start', {
        queueId,
        sourceFingerprint,
        queueDepth: translationUnits.filter(eligible).length,
        sourceCharacters: raw.length,
        sourceWords: wordCount(raw),
      });
      const pending = translationUnits.some(eligible);
      const initialized = await store.saveRawTranslation(sessionId, {
        ...assembled,
        targetLanguage,
        generationState: pending ? 'running' : 'idle',
      }, { expectedSourceFingerprint: sourceFingerprint, expectedTargetLanguage: targetLanguage });
      if (!initialized) return null;
      const pendingUnits = translationUnits.filter(eligible);
      let nextPending = 0;
      let providerActive = 0;
      // Provider calls may overlap within this session, but every result is
      // merged by stable unit ID through the store. The persisted segment
      // array remains source-ordered even when a later request finishes first.
      const translateWorker = async () => {
        while (nextPending < pendingUnits.length) {
          if (controller.signal.aborted) return;
          const unit = pendingUnits[nextPending++];
          const index = assembled.segments.findIndex((segment) => segment.id === unit.id);
          const contextIndex = index >= 0 ? index : assembled.segments.length;
          const requestId = `${queueId || sessionId}:${unit.id}:${unit.sourceRevision}`;
          const prompt = rawTranslationPrompt({
            sourceText: unit.sourceText,
            context: rawTranslationContext(assembled.segments, contextIndex, 1),
            targetLanguage,
          });
          const model = session.liveTranslationModel || DEFAULT_LIVE_TRANSLATION_MODEL;
          const providerStartedAt = performance.now();
          providerActive += 1;
          translationProfiler.record(sessionId, 'provider-start', {
            requestId,
            unitId: unit.id,
            ordinal: unit.ordinal,
            characters: prompt.length,
            words: wordCount(prompt),
            estimatedTokens: Math.ceil(prompt.length / 4),
            concurrency: providerActive,
            model,
          });
          let providerCompleted = false;
          try {
            const generate = ({ signal } = {}) => enqueueLlm({
              model,
              system: RAW_TRANSLATION_SYSTEM,
              prompt,
              signal: combinedSignal(controller.signal, signal),
              sessionId,
              requestType: 'raw-translation',
              numCtx: 2048,
              numPredict: 256,
            }, {
              priority: 0,
              key: `raw-translation:${sessionId}:${targetLanguage}:${unit.id}:${unit.sourceRevision}`,
              label: `raw translation ${unit.id}`,
            });
            let result;
            if (newOnly) {
              if (controller.signal.aborted) throw Object.assign(new Error('Live translation was paused'), { name: 'AbortError', code: 'ABORT_ERR' });
              const claimed = await store.claimLiveTranslationUnit(sessionId, {
                id: unit.id,
                sourceRevision: unit.sourceRevision,
                targetLanguage,
              });
              if (!claimed) throw Object.assign(new Error('Live translation unit changed or was already attempted'), { name: 'AbortError', code: 'ABORT_ERR' });
              result = await generate();
            } else {
              result = await generate();
            }
            translationProfiler.record(sessionId, 'provider-complete', {
              requestId,
              unitId: unit.id,
              provider: result.provider,
              model: result.model || model,
              providerDurationMs: performance.now() - providerStartedAt,
            });
            providerCompleted = true;
            const translatedText = String(result.content || '').trim();
            if (translatedText) {
              unit.translatedText = translatedText;
              unit.translatedRevision = unit.sourceRevision;
              unit.translatedTargetLanguage = targetLanguage;
            }
            unit.status = translatedText ? 'translated' : 'error';
            unit.error = translatedText ? null : 'Translation returned no text';
            unit.provider = result.provider;
            unit.model = result.model || model;
            unit.translatedAt = now();
            const persistStartedAt = performance.now();
            const applied = await store.applyRawTranslationUnit(sessionId, { ...unit, targetLanguage });
            translationProfiler.record(sessionId, 'persisted', {
              requestId,
              unitId: unit.id,
              applied: Boolean(applied),
              startedAt: persistStartedAt,
            });
            if (!applied) return;
          } catch (error) {
            if (error.code === 'ENOENT' || error.status === 404) throw error;
            if (!providerCompleted) {
              translationProfiler.record(sessionId, 'provider-complete', {
                requestId,
                unitId: unit.id,
                error: error.message,
                providerDurationMs: performance.now() - providerStartedAt,
              });
            }
            if (controller.signal.aborted || isAbortError(error)) return;
            unit.status = 'error';
            unit.error = error.message;
            const persistStartedAt = performance.now();
            const applied = await store.applyRawTranslationUnit(sessionId, { ...unit, targetLanguage }).catch(() => null);
            translationProfiler.record(sessionId, 'persisted', {
              requestId,
              unitId: unit.id,
              applied: Boolean(applied),
              error: true,
              startedAt: persistStartedAt,
            });
            // Live translation is downstream and never allowed to fail dictation.
          } finally {
            providerActive -= 1;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(newOnly ? 1 : rawTranslationConcurrency, pendingUnits.length) }, () => translateWorker()));
      return store.settleRawTranslation(sessionId);
    })().catch(async (error) => {
      await store.settleRawTranslation(sessionId).catch(() => {});
      throw error;
    }).finally(() => {
      if (rawTranslationJobs.get(sessionId) === job) rawTranslationJobs.delete(sessionId);
      if (rawTranslationControllers.get(sessionId) === translationState) rawTranslationControllers.delete(sessionId);
    });
    rawTranslationJobs.set(sessionId, job);
    return job;
  }

  async function ensureDerivedArtifacts(sessionId, through = 'translation') {
    const jobKey = `${sessionId}:${through}`;
    const existing = derivedJobs.get(jobKey);
    if (existing) return existing;
    const job = (async () => {
      let session = await store.get(sessionId);
      if (!session.artifacts.rawTranscript?.content) return session.artifacts;
      if (through === 'cleanedTranscript') {
        await ensureArtifact(sessionId, 'cleanedTranscript', 'cleanup');
      } else if (through === 'translation') {
        await ensureArtifact(sessionId, 'cleanedTranscript', 'cleanup');
        await ensureArtifact(sessionId, 'cleanedTranslation', 'cleaned-translation', {
          before: () => ensureArtifact(sessionId, 'cleanedTranscript', 'cleanup'),
        });
      }
      return (await store.get(sessionId)).artifacts;
    })();
    derivedJobs.set(jobKey, job);
    try {
      return await job;
    } catch (error) {
      // A shutdown or workspace switch can remove the session while a detached
      // background job is still unwinding. There is nothing left to update.
      if (error.code === 'ENOENT' || error.status === 404) return null;
      throw error;
    } finally {
      if (derivedJobs.get(jobKey) === job) derivedJobs.delete(jobKey);
    }
  }

  async function ensureArtifact(sessionId, key, stage, { before } = {}) {
    const jobKey = `${sessionId}:artifact:${key}`;
    const existing = derivedJobs.get(jobKey);
    if (existing) return existing;
    const prerequisites = async () => {
      if (before) await before();
      const session = await store.get(sessionId);
      if (['notes', 'outline', 'keyPoints', 'qa', 'structuredAnalysis'].includes(key) && session.artifacts.rawTranscript?.content) {
        await ensureArtifact(sessionId, 'cleanedTranscript', 'cleanup');
      }
    };
    const job = ensureGeneratedArtifact(sessionId, key, stage, { before: prerequisites });
    derivedJobs.set(jobKey, job);
    try {
      return await job;
    } finally {
      if (derivedJobs.get(jobKey) === job) derivedJobs.delete(jobKey);
    }
  }

  async function runtimeSnapshot() {
    const sessions = await store.listRaw();
    const seenChunks = new Set();
    let audioChunks = 0;
    let audioBytes = 0;
    let segments = 0;
    for (const session of sessions) {
      segments += session.transcriptSegments?.length || 0;
      for (const recording of [session.dictation, ...(session.recordingSegments || [])].filter(Boolean)) {
        for (const chunk of recording.chunks || []) {
          const key = `${session.id}:${recording.id}:${chunk.sequence}`;
          if (seenChunks.has(key)) continue;
          seenChunks.add(key);
          audioChunks += 1;
          audioBytes += Number(chunk.bytes) || 0;
        }
      }
    }
    const memory = process.memoryUsage();
    return {
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
      rss: memory.rss,
      audioBytes,
      audioChunks,
      segments,
      sessions: sessions.length,
      activeLocks: active.size,
      derivedJobs: derivedJobs.size,
      revisionJobs: asrRevisionJobs.size,
      rawTranslationJobs: rawTranslationJobs.size,
      liveTranslationJobs: liveTranslationRuns.size,
      whisper: { ...inferenceScheduler.snapshot(), ...(stt.snapshot?.() || {}) },
      llm: {
        ...llmScheduler.snapshot(),
        lifecycle: llmLifecycle.snapshot(),
        runningModels: runtimeDebug && typeof llm.runningModels === 'function' ? await llm.runningModels() : [],
      },
    };
  }

  async function serveStatic(pathname, res) {
    const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const resolved = path.resolve(webRoot, requested);
    if (!resolved.startsWith(`${path.resolve(webRoot)}${path.sep}`) && resolved !== path.resolve(webRoot, 'index.html')) return false;
    try {
      const body = await fs.readFile(resolved);
      res.writeHead(200, {
        'content-type': MIME_TYPES[path.extname(resolved)] || 'application/octet-stream',
        'content-length': body.length,
        'cache-control': 'no-cache',
      });
      res.end(body);
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return false;
    }
  }

  const handler = async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const parts = route(url.pathname);
    let manualToken = null;
    try {
      const rawTranslationAction = req.method === 'POST' && parts[0] === 'api' && parts[1] === 'sessions'
        && parts[3] === 'artifacts' && parts[4] === 'rawTranslation' && parts[5] === 'ensure';
      const rawTranslationOptions = rawTranslationAction ? await readJson(req) : null;
      const liveRawRequest = rawTranslationAction
        && ['recording', 'finalizing'].includes((await store.get(parts[2])).dictation?.status);
      if (rawTranslationAction && !liveRawRequest) {
        if (manualRequests.size) throw Object.assign(new Error('Wait for the current AI task to finish.'), { status: 409, code: 'PROCESSING_ACTIVE' });
        manualToken = Symbol('manual-translation');
        manualRequests.add(manualToken);
        const recordingSession = (await store.listRaw()).find((session) => ['recording', 'finalizing'].includes(session.dictation?.status));
        if (recordingSession) throw Object.assign(new Error('Stop dictation before starting AI processing to keep recording responsive.'), { status: 409, code: 'RECORDING_ACTIVE' });
        const liveSessions = new Set([...liveTranslationRuns.keys(), ...[...rawTranslationControllers.entries()]
          .filter(([, translation]) => translation.newOnly).map(([sessionId]) => sessionId)]);
        await Promise.all([...liveSessions].map(pauseLiveTranslation));
      }
      if (url.pathname === '/api/health' && req.method === 'GET') {
        const models = await installedLlmModels({ refresh: true }) || [];
        const sttRuntime = await stt.status?.() || { ready: true, models: Object.fromEntries(STT_MODELS.map((model) => [model, true])), installedModels: STT_MODELS };
        const configuredSettings = await settings.get?.() || {};
        const asrModelPlan = resolveAsrModelPlan(sttRuntime.installedModels || STT_MODELS, {
          selectedModel: DEFAULT_STT_MODEL,
          stageModels: configuredSettings.asrModels,
        });
        return json(res, 200, {
          ok: true,
          defaultSttModel: DEFAULT_STT_MODEL,
          defaultLiveTranslationModel: DEFAULT_LIVE_TRANSLATION_MODEL,
          sttModels: STT_MODELS,
          languages: STT_LANGUAGES,
          sttReady: sttRuntime.ready,
          sttRuntime,
          asrPipeline: {
            enabled: supportsStagedAsr(sttRuntime) && asrModelPlan.enabled,
            mode: 'rag-revision',
            automaticHighQuality: false,
            revisionSource: 'rawTranscript',
            retrievalMethod: 'lexical-anchors',
            vectorized: false,
            models: asrModelPlan.models,
            fallbacks: asrModelPlan.fallbacks,
            scheduler: inferenceScheduler.snapshot(),
          },
          ollamaModels: models,
          ollamaReady: models.length > 0,
          ollamaBootstrap: ollamaBootstrap?.snapshot?.() || null,
          runtimeDebug,
        });
      }
      if (url.pathname === '/api/ollama/bootstrap' && req.method === 'POST') {
        if (!ollamaBootstrap?.ensureReady) return json(res, 404, { error: 'Automatic Ollama setup is unavailable' });
        void ollamaBootstrap.ensureReady();
        return json(res, 202, ollamaBootstrap.snapshot());
      }
      if (url.pathname === '/api/debug/runtime' && req.method === 'GET') {
        if (!runtimeDebug) return json(res, 404, { error: 'Runtime diagnostics are disabled' });
        return json(res, 200, await runtimeSnapshot());
      }
      if (url.pathname === '/api/debug/translation-metrics' && req.method === 'GET') {
        if (!translationProfiler.enabled) return json(res, 404, { error: 'Translation profiling is disabled' });
        return json(res, 200, translationProfiler.all());
      }
      if (url.pathname === '/api/stt/models' && req.method === 'GET') {
        return json(res, 200, await stt.status?.() || {});
      }
      if (parts[0] === 'api' && parts[1] === 'stt' && parts[2] === 'models' && parts[3] && parts[4] === 'install' && req.method === 'POST') {
        if (!stt.startModelInstall) throw Object.assign(new Error('This host does not support managed model installation'), { status: 501, code: 'STT_MODEL_INSTALL_UNAVAILABLE' });
        const model = await stt.startModelInstall(parts[3]);
        return json(res, 202, { model });
      }
      if (url.pathname === '/api/settings' && req.method === 'GET') {
        return json(res, 200, {
          ...(await settings.get?.() || {}),
          storagePath: store.root,
        });
      }
      if (url.pathname === '/api/settings' && req.method === 'PATCH') {
        const input = await readJson(req);
        if (input.storagePath && active.size) throw Object.assign(new Error('Finish the current processing stage before changing storage location'), { status: 409 });
        const updated = await settings.update?.(input);
        return json(res, 200, {
          ...(updated || {}),
          storagePath: store.root,
        });
      }
      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'live-translation' && req.method === 'POST') {
        const input = await readJson(req);
        if (typeof input.enabled !== 'boolean') throw Object.assign(new Error('enabled must be a boolean'), { status: 400 });
        await store.setLiveTranslation(parts[2], { enabled: input.enabled, ...(!input.enabled ? { status: 'idle' } : {}) });
        if (input.enabled) await requestLiveTranslation(parts[2]);
        else await pauseLiveTranslation(parts[2]);
        return json(res, 200, publicSession(await store.get(parts[2])));
      }
      if (url.pathname === '/api/sessions' && req.method === 'GET') return json(res, 200, await store.list());
      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        const input = await readJson(req);
        if (!String(input.llmModel || '').trim()) {
          const installed = await installedLlmModels();
          const selected = availableLlmModel('', installed);
          if (selected) input.llmModel = selected;
        }
        const session = await store.create(input);
        return json(res, 201, publicSession(session));
      }
      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2]) {
        const sessionId = parts[2];
        if (parts.length === 3 && req.method === 'DELETE') {
          if ([...active].some((lock) => lock.startsWith(`${sessionId}:`))) {
            throw Object.assign(new Error('Finish the current session processing before deleting it'), { status: 409 });
          }
          inferenceScheduler.cancelWhere((entry) => entry.key.startsWith(`${sessionId}:`), 'Session was deleted');
          rawTranslationControllers.get(sessionId)?.controller.abort(Object.assign(new Error('Session was deleted'), { name: 'AbortError', code: 'ABORT_ERR' }));
          const deleted = await store.deleteSession(sessionId);
          return json(res, 200, { id: deleted.id, title: deleted.title });
        }
        if (parts.length === 3 && req.method === 'GET') {
          let session = await reconcileSessionLlmModel(await store.get(sessionId));
          if (session.asr && session.asr.mode !== 'rag-revision') {
            session = await store.configureRagRevision(sessionId);
          }
          return json(res, 200, publicSession(session));
        }
        if (parts.length === 3 && req.method === 'PATCH') return json(res, 200, publicSession(await store.updateMeta(sessionId, await readJson(req))));
        if (parts[3] === 'audio' && parts.length === 4 && req.method === 'POST') {
          const filename = decodeURIComponent(req.headers['x-filename'] || 'lecture.webm');
          const body = await readBody(req, 1024 * 1024 * 1024);
          if (!body.length) throw Object.assign(new Error('Audio file is empty'), { status: 400 });
          const { session } = await store.saveUpload(sessionId, 'audio', filename, body, req.headers['content-type']);
          return json(res, 201, publicSession(session));
        }
        if (parts[3] === 'audio' && parts[4] === 'content' && req.method === 'GET') {
          const session = await store.get(sessionId);
          if (!session.audio) throw Object.assign(new Error('No audio attached'), { status: 404 });
          const body = await store.readFile(session.audio.storedPath);
          res.writeHead(200, { 'content-type': session.audio.mimeType, 'content-length': body.length, 'accept-ranges': 'bytes' });
          res.end(body);
          return;
        }
        if (parts[3] === 'recordings' && parts[4] && parts[5] === 'audio' && parts[6] === 'content' && req.method === 'GET') {
          const session = await store.get(sessionId);
          const segment = (session.recordingSegments || []).find((item) => item.id === parts[4]);
          if (!segment?.audio) throw Object.assign(new Error('Recording segment audio was not found'), { status: 404 });
          const body = await store.readFile(segment.audio.storedPath);
          res.writeHead(200, { 'content-type': segment.audio.mimeType, 'content-length': body.length, 'accept-ranges': 'bytes' });
          res.end(body);
          return;
        }
        if (parts[3] === 'dictation' && parts[4] === 'start' && req.method === 'POST') {
          const options = await readJson(req);
          const session = await store.get(sessionId);
          const model = options.model || session.sttModel || DEFAULT_STT_MODEL;
          const language = options.language || session.language || DEFAULT_STT_LANGUAGE;
          const runtime = await stt.status?.();
          if (runtime && !runtime.ready) throw Object.assign(new Error(runtime.message), { status: 503, code: 'STT_RUNTIME_MISSING' });
          const stagedAsr = supportsStagedAsr(runtime);
          const configuredSettings = await settings.get?.() || {};
          const modelPlan = resolveAsrModelPlan(runtime?.installedModels || [model], {
            selectedModel: model,
            stageModels: configuredSettings.asrModels,
          });
          if (stagedAsr && !modelPlan.enabled) {
            throw Object.assign(new Error('No installed Whisper model is available for provisional transcription.'), { status: 503, code: 'STT_MODEL_MISSING' });
          }
          if (!stagedAsr && runtime?.models && !runtime.models[model]) {
            throw Object.assign(new Error(`Whisper model “${model}” is not installed. Choose ${runtime.installedModels.join(', ') || 'an installed model'}.`), { status: 503, code: 'STT_MODEL_MISSING' });
          }
          const primaryModel = stagedAsr ? modelPlan.models.provisional : model;
          await store.updateMeta(sessionId, { sttModel: primaryModel, language });
          const dictation = await store.startDictation(sessionId, {
            model: primaryModel,
            language,
            stagedAsr,
            asrModels: modelPlan.models,
            asrFallbacks: modelPlan.fallbacks,
          });
          return json(res, 201, dictation);
        }
        if (parts[3] === 'dictation' && parts[4] === 'chunks' && req.method === 'POST') {
          const sequence = Number(url.searchParams.get('sequence'));
          if (!Number.isInteger(sequence) || sequence < 0) throw Object.assign(new Error('A valid dictation chunk sequence is required'), { status: 400 });
          const hasSpeech = url.searchParams.get('speech') !== '0';
          const body = await readBody(req, 8 * 1024 * 1024);
          if (!body.length) throw Object.assign(new Error('Dictation chunk is empty'), { status: 400 });
          return await withActive(`${sessionId}:dictation`, async () => {
            const startMs = Number(url.searchParams.get('startMs'));
            const endMs = Number(url.searchParams.get('endMs'));
            const chunk = await store.saveDictationChunk(sessionId, sequence, body, {
              startMs: Number.isFinite(startMs) ? startMs : undefined,
              endMs: Number.isFinite(endMs) ? endMs : undefined,
              hasSpeech: url.searchParams.get('speech') !== '0',
              boundary: url.searchParams.get('boundary') || 'legacy-fixed',
            });
            const session = await store.get(sessionId);
            if (session.dictation?.stagedAsr && chunk.segmentId) {
              if (chunk.status !== 'transcribed') {
                void enqueueTranscriptStage(sessionId, chunk.segmentId, ASR_STAGE.PROVISIONAL)
                  .catch((error) => handleDetachedAsrError(sessionId, ASR_STAGE.PROVISIONAL, error));
              }
              // The WAV is durable at this point. Acknowledge it immediately so
              // the renderer can release its Blob instead of retaining audio
              // while CPU-only Whisper drains the bounded background queue.
              return json(res, 200, publicSession(session));
            }
            if (chunk.status === 'transcribed' || !chunk.hasSpeech) return json(res, 200, publicSession(session));
            try {
              const result = await enqueueWhisperTranscription(
                `${sessionId}:${session.dictation.id}:legacy:${sequence}`,
                chunk.storedPath,
                { model: session.dictation.model, language: session.dictation.language, stage: ASR_STAGE.PROVISIONAL },
                { priority: ASR_PRIORITY.provisional, preemptible: false, label: `legacy provisional ${sequence}` },
              );
              const updated = await store.setDictationChunkResult(sessionId, sequence, result);
              translationProfiler.record(sessionId, 'transcript-finalized', {
                sourceFingerprint: fingerprint(updated.artifact?.content || ''),
                sourceCharacters: updated.artifact?.content?.length || 0,
                sourceWords: wordCount(updated.artifact?.content || ''),
                sequence,
              });
              if (session.liveTranslation?.enabled) void requestLiveTranslation(sessionId)
                .catch((error) => handleDetachedAsrError(sessionId, 'live-translation', error));
              return json(res, 200, publicSession(await store.get(sessionId)));
            } catch (error) {
              if (error.code === 'NO_SPEECH') {
                await store.setDictationChunkResult(sessionId, sequence, { content: '', language: session.dictation.language, provider: 'whisper.cpp' });
                return json(res, 200, publicSession(await store.get(sessionId)));
              }
              await store.setDictationChunkResult(sessionId, sequence, { error: error.message });
              error.status ||= 502;
              throw error;
            }
          });
        }
        if (parts[3] === 'dictation' && parts[4] === 'finalize' && req.method === 'POST') {
          return await withActive(`${sessionId}:dictation`, async () => {
            await store.markDictationFinalizing(sessionId);
            let session = await store.get(sessionId);
            if (session.dictation?.stagedAsr) {
              for (const chunk of session.dictation.chunks.filter((item) => item.segmentId)) {
                await enqueueTranscriptStage(sessionId, chunk.segmentId, ASR_STAGE.PROVISIONAL);
              }
              session = await store.get(sessionId);
            } else {
              for (const chunk of session.dictation.chunks.filter((item) => item.status !== 'transcribed')) {
                if (!chunk.hasSpeech) {
                  await store.setDictationChunkResult(sessionId, chunk.sequence, { content: '', language: session.dictation.language, provider: 'whisper.cpp' });
                  continue;
                }
                try {
                  const result = await enqueueWhisperTranscription(
                    `${sessionId}:${session.dictation.id}:legacy:${chunk.sequence}`,
                    chunk.storedPath,
                    { model: session.dictation.model, language: session.dictation.language, stage: ASR_STAGE.PROVISIONAL },
                    { priority: ASR_PRIORITY.provisional, preemptible: false, label: `legacy provisional ${chunk.sequence}` },
                  );
                  const updated = await store.setDictationChunkResult(sessionId, chunk.sequence, result);
                  translationProfiler.record(sessionId, 'transcript-finalized', {
                    sourceFingerprint: fingerprint(updated.artifact?.content || ''),
                    sourceCharacters: updated.artifact?.content?.length || 0,
                    sourceWords: wordCount(updated.artifact?.content || ''),
                    sequence: chunk.sequence,
                  });
                } catch (error) {
                  if (error.code === 'NO_SPEECH') {
                    await store.setDictationChunkResult(sessionId, chunk.sequence, { content: '', language: session.dictation.language, provider: 'whisper.cpp' });
                    continue;
                  }
                  await store.setDictationChunkResult(sessionId, chunk.sequence, { error: error.message });
                  error.status ||= 502;
                  throw error;
                }
                session = await store.get(sessionId);
              }
            }
            const completed = await store.finalizeDictation(sessionId);
            if (!completed.artifacts.rawTranscript?.content) {
              await store.processing(sessionId, processing('dictation', 'error', 'Recording was saved, but Whisper found no speech.', { finishedAt: now() }));
              throw Object.assign(new Error('Recording was saved, but Whisper found no speech.'), { status: 422, code: 'NO_SPEECH' });
            }
            await store.refineParagraphs(sessionId);
            const refined = await store.get(sessionId);
            if (refined.dictation.stagedAsr) {
              if (refined.liveTranslation?.enabled) void requestLiveTranslation(sessionId, { final: true })
                .catch((error) => handleDetachedRawTranslationError(sessionId, error));
            } else if (refined.liveTranslation?.enabled) {
              void requestLiveTranslation(sessionId, { final: true })
                .catch((error) => handleDetachedRawTranslationError(sessionId, error));
            }
            // Raw, audio, and any completed automatic Cleaned refinement are
            // already durable. Finalization never queues a revised Whisper pass.
            return json(res, 200, publicSession(refined));
          });
        }
        if (parts[3] === 'asr' && parts[4] === 'revise' && req.method === 'POST') {
          const session = await store.get(sessionId);
          if (!session.transcriptSegments?.length) throw Object.assign(new Error('No saved staged audio is available to revise.'), { status: 409, code: 'ASR_AUDIO_MISSING' });
          if (session.dictation?.status !== 'complete') throw Object.assign(new Error('Finish saving the recording before revising it.'), { status: 409, code: 'RECORDING_ACTIVE' });
          if (!asrRevisionJobs.has(sessionId)) {
            await pauseLiveTranslation(sessionId);
            await store.processing(sessionId, processing('revision', 'running', 'Improving transcript from saved audio…', { startedAt: now() }));
            const job = withStage(sessionId, 'revision', () => ensureLiveRevisions(sessionId, { manual: true }))
              .catch((error) => handleDetachedAsrError(sessionId, 'revision', error))
              .finally(() => { if (asrRevisionJobs.get(sessionId) === job) asrRevisionJobs.delete(sessionId); });
            asrRevisionJobs.set(sessionId, job);
          }
          return json(res, 202, publicSession(await store.get(sessionId)));
        }
        if (parts[3] === 'paragraphs' && parts[4] === 'refine' && req.method === 'POST') {
          const refined = await store.refineParagraphs(sessionId);
          return json(res, 200, publicSession(refined));
        }
        if (parts[3] === 'paragraphs' && parts[4] === 'split' && req.method === 'POST') {
          const updated = await store.updateParagraphs(sessionId, 'split', await readJson(req));
          return json(res, 200, publicSession(updated));
        }
        if (parts[3] === 'paragraphs' && parts[4] === 'merge-previous' && req.method === 'POST') {
          const updated = await store.updateParagraphs(sessionId, 'merge-previous', await readJson(req));
          return json(res, 200, publicSession(updated));
        }
        if (parts[3] === 'transcribe' && req.method === 'POST') {
          const options = await readJson(req);
          const session = await store.get(sessionId);
          if (!session.audio) throw Object.assign(new Error('Record or upload audio first'), { status: 400 });
          const runtime = await stt.status?.();
          const configuredSettings = await settings.get?.() || {};
          const plan = resolveAsrModelPlan(runtime?.installedModels || [options.model || session.sttModel], {
            selectedModel: options.model || session.sttModel,
            stageModels: configuredSettings.asrModels,
          });
          const transcriptionModel = options.model || session.sttModel || plan.models.provisional;
          const transcriptionLanguage = options.language || session.language;
          const result = await withStage(sessionId, 'transcription', async () => enqueueWhisperTranscription(
            `${sessionId}:audio:${session.audio.id}:${transcriptionModel}:${transcriptionLanguage}`,
            session.audio.storedPath,
            { model: transcriptionModel, language: transcriptionLanguage, stage: ASR_STAGE.PROVISIONAL },
            { priority: ASR_PRIORITY.provisional, preemptible: true, label: `uploaded audio ${session.audio.id}` },
          ));
          const sourceFingerprint = fingerprint(`${session.audio.id}:${transcriptionModel}:${options.language || session.language}`);
          const artifact = await store.setArtifact(sessionId, 'rawTranscript', {
            ...result,
            source: 'transcription',
            sourceFingerprint,
          }, { preserve: true });
          return json(res, 200, artifact);
        }
        if (parts[3] === 'materials' && parts.length === 4 && req.method === 'POST') {
          const filename = decodeURIComponent(req.headers['x-filename'] || 'material.txt');
          const body = await readBody(req, 100 * 1024 * 1024);
          if (!body.length) throw Object.assign(new Error('Material file is empty'), { status: 400 });
          const { record } = await store.saveUpload(sessionId, 'material', filename, body, req.headers['content-type']);
          await logActivity(sessionId, {
            scope: 'material', code: 'material-upload-stored', materialId: record.id,
            details: { filename: record.filename, bytes: record.bytes },
          });
          const material = await withActive(`${sessionId}:material:${record.id}`, () => extractStoredMaterial(sessionId, record));
          return json(res, 201, visibleMaterial(material));
        }
        if (parts[3] === 'materials' && parts[4] && parts[5] === 'extract' && req.method === 'POST') {
          const session = await store.get(sessionId);
          const record = session.materials.find((material) => material.id === parts[4]);
          if (!record) throw Object.assign(new Error('Material not found'), { status: 404 });
          const material = await withActive(`${sessionId}:material:${record.id}`, () => extractStoredMaterial(sessionId, record, { reextract: true }));
          return json(res, 200, visibleMaterial(material));
        }
        if (parts[3] === 'materials' && parts[4] && req.method === 'DELETE') {
          return json(res, 200, publicSession(await store.deleteMaterial(sessionId, parts[4])));
        }
        if (parts[3] === 'artifacts' && parts[4] && req.method === 'PUT') {
          const key = parts[4];
          if (!ARTIFACT_KEYS.has(key)) throw Object.assign(new Error('Unknown artifact'), { status: 400 });
          const body = await readJson(req, 10 * 1024 * 1024);
          if (body.content === undefined || body.content === null) throw Object.assign(new Error('Artifact content is required'), { status: 400 });
          const content = String(body.content);
          const artifact = await store.setArtifact(sessionId, key, {
            content,
            ...(Array.isArray(body.segments) ? { segments: body.segments } : {}),
            source: 'manual-edit',
            sourceFingerprint: fingerprint(content),
          }, { preserve: key === 'rawTranscript', baseContent: body.baseContent });
          return json(res, 200, artifact);
        }
        if (parts[3] === 'artifacts' && parts[4] && parts.length === 5 && req.method === 'GET') {
          const key = parts[4];
          if (!ARTIFACT_KEYS.has(key)) throw Object.assign(new Error('Unknown artifact'), { status: 400 });
          const session = await store.get(sessionId);
          return json(res, 200, (key === 'translation' ? session.artifacts.cleanedTranslation : session.artifacts[key]) || null);
        }
        if (parts[3] === 'artifacts' && parts[4] && parts[5] === 'ensure' && req.method === 'POST') {
          const key = parts[4];
          if (!ARTIFACT_KEYS.has(key)) throw Object.assign(new Error('Unknown artifact'), { status: 400 });
          if (key === 'cleanedTranscript') await ensureDerivedArtifacts(sessionId, 'cleanedTranscript');
          if (key === 'highQualityTranscript') await ensureHighQualityTranscript(sessionId);
          if (['translation', 'cleanedTranslation'].includes(key)) await ensureDerivedArtifacts(sessionId, 'translation');
          if (key === 'rawTranslation') {
            if (liveRawRequest) {
              const translation = await scheduleRawTranslation(sessionId, { newOnly: true, final: false });
              return json(res, 200, translation);
            }
            await store.processing(sessionId, processing('raw-translation', 'running', 'Translating saved transcript…', { startedAt: now() }));
            try {
              const translation = await scheduleRawTranslation(sessionId, { final: true, newOnly: rawTranslationOptions.newOnly === true });
              const incomplete = translation?.stale || translation?.generationState === 'error';
              await store.processing(sessionId, processing('raw-translation', incomplete ? 'error' : 'success', incomplete
                ? 'Translation needs another manual attempt. Saved translations were preserved.'
                : 'Translation completed', { finishedAt: now() }));
            } catch (error) {
              await store.processing(sessionId, processing('raw-translation', 'error', error.message, { finishedAt: now() }));
              throw error;
            }
          }
          if (key === 'notes') await ensureArtifact(sessionId, key, 'notes', {
            before: () => ensureArtifact(sessionId, 'cleanedTranscript', 'cleanup'),
          });
          if (key === 'outline') await ensureArtifact(sessionId, key, 'outline', {
            before: () => ensureArtifact(sessionId, 'cleanedTranscript', 'cleanup'),
          });
          if (DERIVED_STAGE_BY_ARTIFACT[key]) await ensureArtifact(sessionId, key, DERIVED_STAGE_BY_ARTIFACT[key], {
            before: () => ensureArtifact(sessionId, 'cleanedTranscript', 'cleanup'),
          });
          if (key === 'notesTranslation') await ensureArtifact(sessionId, key, 'notes-translation');
          if (key === 'outlineTranslation') await ensureArtifact(sessionId, key, 'outline-translation');
          const session = await store.get(sessionId);
          return json(res, 200, (key === 'translation' ? session.artifacts.cleanedTranslation : session.artifacts[key]) || null);
        }
        if (parts[3] === 'stages' && parts[4] && req.method === 'POST') {
          const stage = parts[4];
          if (!STAGES.has(stage)) throw Object.assign(new Error('Unknown pipeline stage'), { status: 400 });
          const options = await readJson(req);
          if (stage.includes('translation') && options.targetLanguage) await store.updateMeta(sessionId, { targetLanguage: options.targetLanguage });
          if (['translation', 'cleaned-translation'].includes(stage)) await ensureDerivedArtifacts(sessionId, 'cleanedTranscript');
          const session = await reconcileSessionLlmModel(await store.get(sessionId), { required: true });
          const result = await withStage(sessionId, stage, async () => runStage({
            stage,
            session,
            llm: llmForSession(sessionId),
            options: stage === 'cleanup' ? { ...options, forceCleanup: true } : options,
            onCleanupProgress: stage === 'cleanup'
              ? (artifact) => store.setArtifact(sessionId, 'cleanedTranscript', artifact)
              : undefined,
            onCleanupLog: stage === 'cleanup'
              ? (entry) => logActivity(sessionId, { scope: 'revision', ...entry })
              : undefined,
          }));
          const artifact = await store.setArtifact(sessionId, result.key, result.artifact);
          return json(res, 200, artifact);
        }
        if (parts[3] === 'workflows' && parts[4] === 'lecture-notes' && req.method === 'POST') {
          const options = await readJson(req);
          const completed = [];
          for (const stage of ['cleanup', 'analysis', 'notes', 'outline']) {
            const session = await reconcileSessionLlmModel(await store.get(sessionId), { required: true });
            const result = await withStage(sessionId, stage, async () => runStage({
              stage,
              session,
              llm: llmForSession(sessionId),
              options: stage === 'cleanup' ? { ...options, forceCleanup: true } : options,
              onCleanupProgress: stage === 'cleanup'
                ? (artifact) => store.setArtifact(sessionId, 'cleanedTranscript', artifact)
                : undefined,
              onCleanupLog: stage === 'cleanup'
                ? (entry) => logActivity(sessionId, { scope: 'revision', ...entry })
                : undefined,
            }));
            await store.setArtifact(sessionId, result.key, result.artifact);
            completed.push(artifactForStage(stage));
          }
          return json(res, 200, { completed, session: publicSession(await store.get(sessionId)) });
        }
      }
      if (parts[0] === 'api') return json(res, 404, { error: 'API endpoint not found' });
      if (req.method === 'GET' && await serveStatic(url.pathname, res)) return;
      json(res, 404, { error: 'Not found' });
    } catch (error) {
      if (!error.status || error.status >= 500) console.error(error);
      json(res, error.status || 500, { error: error.message || 'Unexpected error', code: error.code, materialId: error.materialId });
    } finally {
      if (manualToken) manualRequests.delete(manualToken);
    }
  };
  handler.translationProfiler = translationProfiler;
  handler.inferenceScheduler = inferenceScheduler;
  handler.llmScheduler = llmScheduler;
  handler.llmLifecycle = llmLifecycle;
  handler.ensureHighQualityTranscript = ensureHighQualityTranscript;
  handler.runtimeSnapshot = runtimeSnapshot;
  handler.idle = async () => {
    // Detached material RAG, manual Raw revision, optional compatibility ASR,
    // and translation work may enqueue more
    // work as it settles. Wait until two consecutive snapshots are empty so
    // callers can safely close or remove the backing workspace.
    let emptyPasses = 0;
    for (;;) {
      await inferenceScheduler.idle();
      const jobs = [...rawTranslationJobs.values(), ...derivedJobs.values(), ...asrRevisionJobs.values(), ...[...liveTranslationRuns.values()].map((run) => run.promise).filter(Boolean)];
      if (jobs.length) await Promise.allSettled(jobs);
      await inferenceScheduler.idle();
      await new Promise((resolve) => setImmediate(resolve));
      const scheduler = inferenceScheduler.snapshot();
      if (rawTranslationJobs.size === 0 && liveTranslationRuns.size === 0 && asrRevisionJobs.size === 0 && derivedJobs.size === 0 && scheduler.queued === 0 && scheduler.active === 0) {
        emptyPasses += 1;
        if (emptyPasses === 2) return;
      } else {
        emptyPasses = 0;
      }
    }
  };
  handler.close = async () => {
    if (closing) return;
    closing = true;
    for (const { controller } of rawTranslationControllers.values()) {
      controller.abort(Object.assign(new Error('Application is shutting down'), { name: 'AbortError', code: 'ABORT_ERR' }));
    }
    await Promise.allSettled([inferenceScheduler.close(), llmScheduler.close()]);
    await Promise.allSettled([
      ...derivedJobs.values(),
      ...rawTranslationJobs.values(),
      ...[...liveTranslationRuns.values()].map((run) => run.promise).filter(Boolean),
      ...asrRevisionJobs.values(),
    ]);
    const models = llmLifecycle.snapshot().models.map((item) => item.model).filter(Boolean);
    await Promise.allSettled(models.map((model) => llmLifecycle.requestReset(model, 'application-close')));
    await stt.close?.();
  };
  return handler;
}

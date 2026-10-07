import path from 'node:path';
import { ARTIFACT_KEYS, DEFAULT_LIVE_TRANSLATION_MODEL, fingerprint, id, now, safeFilename } from './lib.js';
import { FileStorageAdapter } from './storage.js';
import { combinePcmWavFiles } from './audio.js';
import { mergePreviousParagraph, normalizeSegments, paragraphize, splitParagraph } from './paragraphs.js';
import { DEFAULT_STT_MODEL } from './providers/whisper-models.js';
import { DEFAULT_STT_LANGUAGE } from './providers/stt.js';
import { assembleRawUnits, rawUnitNeedsTranslation } from './raw-translation.js';
import { ASR_STAGE, ASR_STAGES, orderedTranscriptSegments, projectTranscript, summarizeAsrBacklog } from './asr-pipeline.js';
import { CORRECTION_REVISION, correctionMaterialsFingerprint } from './conservative-correction.js';

const EMPTY_ARTIFACTS = {
  rawTranscript: null,
  highQualityTranscript: null,
  rawTranslation: null,
  cleanedTranscript: null,
  cleanedTranslation: null,
  notesTranslation: null,
  outlineTranslation: null,
  translation: null,
  keyPoints: null,
  qa: null,
  structuredAnalysis: null,
  notes: null,
  outline: null,
};

const TITLE_INDEX_FILE = 'session-title-indexes.json';
const ACTIVITY_LOG_LIMIT = 200;

function appendTranscript(prefix, addition) {
  const previous = String(prefix || '');
  const next = String(addition || '').trim();
  if (!previous) return next;
  if (!next) return previous;
  return `${previous}${/\s$/u.test(previous) ? '' : ' '}${next}`;
}

function asrStaleError(message = 'A newer ASR attempt replaced this result') {
  return Object.assign(new Error(message), { status: 409, code: 'STALE_ASR_RESULT' });
}

function wavDurationSeconds(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return 0;
  const bytesPerSecond = buffer.readUInt32LE(28);
  const dataBytes = buffer.readUInt32LE(40);
  return bytesPerSecond > 0 ? dataBytes / bytesPerSecond : 0;
}

function audioSourceFingerprint(session) {
  const source = orderedTranscriptSegments(session.transcriptSegments || [])
    .map((segment) => `${segment.id}:${segment.sourceRevision}`)
    .join('|');
  return fingerprint(source);
}

/** Merge an editor save with confirmed speech appended since that editor snapshot. */
export function mergeConcurrentRawEdit(baseContent, editedContent, currentContent) {
  const base = String(baseContent ?? '');
  const edited = String(editedContent ?? '');
  const current = String(currentContent ?? '');
  if (current === base || current === edited) return edited;
  if (current.startsWith(base)) {
    const appended = current.slice(base.length);
    return appended && !edited.endsWith(appended) ? `${edited}${appended}` : edited;
  }
  return edited;
}

function dictationIsActive(dictation) {
  return ['recording', 'finalizing'].includes(dictation?.status);
}

function automaticTitleInput(input) {
  if (input.automaticTitle === undefined) return null;
  const date = String(input.automaticTitle?.date || '');
  const label = String(input.automaticTitle?.label || '').trim().slice(0, 80);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date || !label) {
    throw Object.assign(new Error('Automatic session titles require a valid local date and display label'), { status: 400 });
  }
  return { date, label };
}

function sessionDate(session) {
  const created = new Date(session.createdAt);
  if (Number.isNaN(created.valueOf())) return null;
  return [
    created.getFullYear(),
    String(created.getMonth() + 1).padStart(2, '0'),
    String(created.getDate()).padStart(2, '0'),
  ].join('-');
}

function rawTranslationArtifact(session, value) {
  const rawFingerprint = fingerprint(session.artifacts.rawTranscript?.content || '');
  const segments = Array.isArray(value.segments) ? value.segments : [];
  const pendingTranslation = value.pendingTranslation || null;
  const content = [...segments, pendingTranslation].filter((segment) => segment?.translatedText)
    .map((segment) => segment.translatedText).join('\n\n');
  return {
    ...(session.artifacts.rawTranslation || {}),
    source: 'raw-live-translation',
    sourceArtifact: 'rawTranscript',
    sourceFingerprint: rawFingerprint,
    dependsOn: { key: 'rawTranscript', fingerprint: rawFingerprint },
    content,
    contentFingerprint: fingerprint(content),
    targetLanguage: String(value.targetLanguage || session.targetLanguage),
    segments,
    pendingText: String(value.pendingText || ''),
    pendingTranslation,
    generationState: value.generationState || ([...segments, pendingTranslation].filter(Boolean)
      .some((segment) => segment.status === 'translating') ? 'running' : 'idle'),
    stale: false,
    staleReason: null,
    updatedAt: now(),
    generatedAt: value.generatedAt || session.artifacts.rawTranslation?.generatedAt || null,
  };
}

function rawTranslationUnitEquivalent(segment, candidate) {
  if (!segment || !candidate) return segment === candidate;
  return segment.id === candidate.id
    && segment.sourceText === candidate.sourceText
    && segment.sourceRevision === candidate.sourceRevision
    && (segment.translatedRevision || null) === (candidate.translatedRevision || null)
    && (segment.targetLanguage || null) === (candidate.targetLanguage || null)
    && (segment.translatedTargetLanguage || null) === (candidate.translatedTargetLanguage || null)
    && (segment.liveTranslationAttemptedAt || null) === (candidate.liveTranslationAttemptedAt || null)
    && segment.translatedText === candidate.translatedText
    && (segment.previousTranslatedText || '') === (candidate.previousTranslatedText || '')
    && segment.status === candidate.status
    && (segment.error || null) === (candidate.error || null)
    && (segment.provider || null) === (candidate.provider || null)
    && (segment.model || null) === (candidate.model || null);
}

function rawTranslationEquivalent(previous, next) {
  if (!previous || previous.sourceFingerprint !== next.sourceFingerprint
    || previous.targetLanguage !== next.targetLanguage
    || previous.pendingText !== next.pendingText
    || previous.generationState !== next.generationState
    || previous.stale !== next.stale
    || previous.staleReason !== next.staleReason
    || !rawTranslationUnitEquivalent(previous.pendingTranslation || null, next.pendingTranslation || null)) return false;
  const before = Array.isArray(previous.segments) ? previous.segments : [];
  const after = Array.isArray(next.segments) ? next.segments : [];
  if (before.length !== after.length) return false;
  return before.every((segment, index) => {
    const candidate = after[index];
    return rawTranslationUnitEquivalent(segment, candidate);
  });
}

export class SessionStore {
  constructor(rootOrStorage) {
    this.storage = rootOrStorage instanceof FileStorageAdapter ? rootOrStorage : new FileStorageAdapter(rootOrStorage);
    this.refreshPaths();
    this.locks = new Map();
    this.createLock = Promise.resolve();
    this.dictationStartLock = Promise.resolve();
  }

  refreshPaths() {
    this.root = this.storage.root;
    this.sessionsRoot = this.storage.resolve('sessions');
  }

  async mutate(sessionId, action) {
    const previous = this.locks.get(sessionId) || Promise.resolve();
    const run = previous.catch(() => {}).then(action);
    this.locks.set(sessionId, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(sessionId) === run) this.locks.delete(sessionId);
    }
  }

  async init() {
    await this.storage.mkdir('sessions');
    const sessions = await this.listRaw();
    await Promise.all(sessions.map(async (session) => {
      let changed = false;
      if (!session.liveTranslationModel) {
        session.liveTranslationModel = DEFAULT_LIVE_TRANSLATION_MODEL;
        changed = true;
      }
      session.artifacts ||= {};
      for (const key of Object.keys(EMPTY_ARTIFACTS)) {
        if (!(key in session.artifacts)) {
          session.artifacts[key] = null;
          changed = true;
        }
      }
      if (!session.artifacts.cleanedTranslation && session.artifacts.translation) {
        session.artifacts.cleanedTranslation = {
          ...session.artifacts.translation,
          sourceArtifact: 'cleanedTranscript',
          migratedFrom: 'translation',
        };
        changed = true;
      }
      if (!Array.isArray(session.recordingSegments)) {
        session.recordingSegments = [];
        changed = true;
      }
      if (!Array.isArray(session.transcriptSegments)) {
        session.transcriptSegments = [];
        session.transcriptBase = session.artifacts.rawTranscript?.content || '';
        session.transcriptBaseOriginal = session.artifacts.rawTranscript?.originalContent || session.transcriptBase;
        session.transcriptBaseSegments = session.paragraphization?.segments || [];
        changed = true;
      }
      if (session.highQualityParagraphization === undefined) {
        session.highQualityParagraphization = null;
        changed = true;
      }
      for (const segment of session.transcriptSegments) {
        segment.versions ||= {};
        segment.stages ||= {};
        for (const stage of ASR_STAGES) {
          if (stage === ASR_STAGE.REVISED && !segment.versions.revised
            && ['pending', 'running'].includes(segment.stages[stage]?.status)) {
            segment.stages[stage] = {
              ...segment.stages[stage],
              status: 'deferred',
              error: null,
              token: null,
            };
            changed = true;
            continue;
          }
          if (segment.stages[stage]?.status === 'running') {
            segment.stages[stage] = {
              ...segment.stages[stage],
              status: 'error',
              error: 'ASR was interrupted when the application stopped. Retrying is safe.',
              interruptedAt: now(),
              token: null,
            };
            changed = true;
          }
        }
      }
      if (session.dictation?.status === 'complete') {
        if (!session.recordingSegments.some((segment) => segment.id === session.dictation.id)) {
          session.recordingSegments.push({
            ...session.dictation,
            ordinal: session.recordingSegments.length,
            audio: session.audio || null,
          });
          changed = true;
        }
      }
      session.recordingSegments.sort((left, right) => Number(left.ordinal ?? 0) - Number(right.ordinal ?? 0)
        || String(left.startedAt || '').localeCompare(String(right.startedAt || '')));
      session.recordingSegments.forEach((segment, ordinal) => {
        if (segment.ordinal !== ordinal) {
          segment.ordinal = ordinal;
          changed = true;
        }
      });
      if (session.schemaVersion !== 4) {
        session.schemaVersion = 4;
        changed = true;
      }
      if (['pending', 'running'].includes(session.liveTranslation?.status)) {
        session.liveTranslation.status = 'idle';
        changed = true;
      }
      const rawTranslation = session.artifacts.rawTranslation;
      if (rawTranslation?.generationState === 'running'
        || rawTranslation?.segments?.some((segment) => segment.status === 'translating')
        || rawTranslation?.pendingTranslation?.status === 'translating') {
        rawTranslation.generationState = 'error';
        rawTranslation.interruptedAt = now();
        rawTranslation.segments = rawTranslation.segments.map((segment) => segment.status === 'translating'
          ? { ...segment, status: 'error', error: 'Translation was interrupted when the application stopped. Retry is safe.' }
          : segment);
        if (rawTranslation.pendingTranslation?.status === 'translating') {
          rawTranslation.pendingTranslation = {
            ...rawTranslation.pendingTranslation,
            status: 'error',
            error: 'Translation was interrupted when the application stopped. Retry is safe.',
          };
        }
        changed = true;
      }
      const cleanedTranscript = session.artifacts.cleanedTranscript;
      if (cleanedTranscript?.generationState === 'running') {
        cleanedTranscript.generationState = 'error';
        cleanedTranscript.interruptedAt = now();
        cleanedTranscript.interruptionReason = 'Cleanup was interrupted when the application stopped. Saved regions can be reused safely.';
        changed = true;
      }
      const interruptedDictation = dictationIsActive(session.dictation);
      if (interruptedDictation) {
        session.dictation.status = 'error';
        session.dictation.lastError = 'Dictation was interrupted when the application stopped. Saved chunks can be retried.';
        session.dictation.updatedAt = now();
        changed = true;
      }
      if (session.processing?.status === 'running' || interruptedDictation) {
        session.processing = {
          stage: interruptedDictation ? 'dictation' : session.processing.stage,
          status: 'error',
          message: interruptedDictation
            ? 'Dictation was interrupted when the application stopped. Saved chunks can be retried.'
            : 'Interrupted when the application stopped. You can safely rerun this stage.',
          finishedAt: now(),
        };
        changed = true;
      }
      if (session.artifacts.highQualityTranscript
        || session.transcriptSegments.some((segment) => segment.versions?.highQuality)) {
        this.projectHighQualityTranscript(session);
      }
      if (changed && session.asr) this.refreshAsrStatus(session);
      if (changed) await this.save(session);
    }));
  }

  file(sessionId) {
    return path.join(this.sessionsRoot, sessionId, 'session.json');
  }

  dir(sessionId) {
    return path.join(this.sessionsRoot, sessionId);
  }

  async switchRoot(root) {
    await this.storage.copyTo(root);
    this.storage.setRoot(root);
    this.refreshPaths();
    await this.init();
    return this.root;
  }

  async listRaw() {
    let entries = [];
    try {
      entries = await this.storage.readdir('sessions', { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const sessions = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        sessions.push(JSON.parse(await this.storage.readFile(this.file(entry.name), 'utf8')));
      } catch (error) {
        if (error.code !== 'ENOENT') console.warn(`Skipping unreadable session ${entry.name}: ${error.message}`);
      }
    }
    return sessions;
  }

  async list() {
    return (await this.listRaw())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ artifacts, materials, audio, recordingSegments = [], dictation, ...session }) => ({
        ...session,
        audio: audio ? (({ storedPath, ...visibleAudio }) => visibleAudio)(audio) : null,
        recordingSegmentCount: recordingSegments.length,
        recordingSegments: recordingSegments.map((segment) => ({
          id: segment.id,
          ordinal: segment.ordinal,
          status: segment.status,
          startedAt: segment.startedAt,
          finishedAt: segment.finishedAt,
          audio: segment.audio ? (({ storedPath, ...visibleAudio }) => visibleAudio)(segment.audio) : null,
          chunkCount: (segment.chunks || []).length,
        })),
        dictation: dictation ? {
          ...dictation,
          transcriptPrefix: undefined,
          transcriptPrefixFingerprint: undefined,
          originalTranscriptPrefix: undefined,
          chunks: (dictation.chunks || []).map(({ storedPath, transcript, ...chunk }) => ({ ...chunk, hasTranscript: Boolean(transcript) })),
        } : null,
        preview: artifacts.rawTranscript?.content?.slice(0, 140) || '',
        materialCount: materials.length,
        hasTranscript: Boolean(artifacts.rawTranscript?.content),
      }));
  }

  async create(input = {}) {
    const run = this.createLock.catch(() => {}).then(() => this.createUnlocked(input));
    this.createLock = run;
    try {
      return await run;
    } finally {
      if (this.createLock === run) this.createLock = Promise.resolve();
    }
  }

  async readTitleIndexes() {
    try {
      const state = JSON.parse(await this.storage.readFile(TITLE_INDEX_FILE, 'utf8'));
      if (!state || !state.dates || Array.isArray(state.dates) || typeof state.dates !== 'object') {
        throw new Error('Session title index metadata is invalid');
      }
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 1, dates: {} };
      throw error;
    }
  }

  async nextAutomaticTitle({ date, label }) {
    const state = await this.readTitleIndexes();
    let highest = Number.isSafeInteger(state.dates[date]) && state.dates[date] > 0 ? state.dates[date] : 0;
    const base = `Lecture — ${label}`;
    const indexedTitle = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} — (\\d+)$`);
    for (const session of await this.listRaw()) {
      const storedIndex = session.automaticTitle?.date === date ? Number(session.automaticTitle.index) : 0;
      if (Number.isSafeInteger(storedIndex) && storedIndex > highest) highest = storedIndex;
      if (session.title === base && sessionDate(session) === date) highest = Math.max(highest, 1);
      const match = String(session.title || '').match(indexedTitle);
      const titleIndex = match ? Number(match[1]) : 0;
      if (Number.isSafeInteger(titleIndex) && titleIndex > highest) highest = titleIndex;
    }
    const index = highest + 1;
    state.schemaVersion = 1;
    state.dates[date] = index;
    state.updatedAt = now();
    await this.storage.writeAtomicJson(TITLE_INDEX_FILE, state);
    return { title: `${base} — ${index}`, automaticTitle: { date, label, index } };
  }

  async createUnlocked(input = {}) {
    const timestamp = now();
    const automatic = automaticTitleInput(input);
    const generated = automatic ? await this.nextAutomaticTitle(automatic) : null;
    const session = {
      schemaVersion: 4,
      id: id('session_'),
      title: generated?.title || String(input.title || '').trim().slice(0, 120) || 'Untitled lecture',
      titleSource: generated ? 'automatic' : 'custom',
      automaticTitle: generated?.automaticTitle || null,
      createdAt: timestamp,
      updatedAt: timestamp,
      language: String(input.language || DEFAULT_STT_LANGUAGE),
      sttModel: String(input.sttModel || DEFAULT_STT_MODEL),
      llmModel: String(input.llmModel || process.env.OLLAMA_MODEL || 'qwen3.5:4b'),
      liveTranslationModel: String(input.liveTranslationModel || DEFAULT_LIVE_TRANSLATION_MODEL).trim() || DEFAULT_LIVE_TRANSLATION_MODEL,
      targetLanguage: String(input.targetLanguage || 'Chinese'),
      audio: null,
      recordingSegments: [],
      transcriptSegments: [],
      transcriptBase: '',
      transcriptBaseOriginal: '',
      transcriptBaseSegments: [],
      highQualityParagraphization: null,
      asr: null,
      artifacts: structuredClone(EMPTY_ARTIFACTS),
      materials: [],
      activityLog: [],
      processing: null,
      dictation: null,
      paragraphization: null,
    };
    await this.save(session);
    return session;
  }

  async get(sessionId) {
    if (!/^session_[0-9a-f-]+$/i.test(sessionId)) {
      const error = new Error('Invalid session id');
      error.status = 400;
      throw error;
    }
    try {
      return JSON.parse(await this.storage.readFile(this.file(sessionId), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        error.status = 404;
        error.message = 'Session not found';
      }
      throw error;
    }
  }

  async save(session) {
    session.updatedAt = now();
    await this.storage.writeAtomicJson(this.file(session.id), session);
    return session;
  }

  async readFile(file, options) {
    return this.storage.readFile(file, options);
  }

  async updateMeta(sessionId, input) {
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      const previousTargetLanguage = session.targetLanguage;
      for (const key of ['title', 'language', 'sttModel', 'llmModel', 'liveTranslationModel', 'targetLanguage']) {
        if (input[key] !== undefined) session[key] = String(input[key]).trim().slice(0, 160);
      }
      if (input.title !== undefined) session.titleSource = 'custom';
      if (!session.title) session.title = 'Untitled lecture';
      if (!session.liveTranslationModel) session.liveTranslationModel = DEFAULT_LIVE_TRANSLATION_MODEL;
      if (input.targetLanguage !== undefined && session.targetLanguage !== previousTargetLanguage) {
        for (const key of ['rawTranslation', 'cleanedTranslation', 'notesTranslation', 'outlineTranslation', 'translation']) {
          session.artifacts[key] = this.markStale(session.artifacts[key], 'Translation target language changed');
        }
      }
      return this.save(session);
    });
  }

  async appendActivityLog(sessionId, { scope = 'system', code, status = 'info', materialId = null, details = {} } = {}) {
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      session.activityLog ||= [];
      const entry = {
        id: id('activity_'),
        at: now(),
        scope: String(scope).slice(0, 40),
        code: String(code || 'activity').slice(0, 100),
        status: String(status).slice(0, 24),
        materialId: materialId ? String(materialId).slice(0, 100) : null,
        details: details && typeof details === 'object' && !Array.isArray(details) ? structuredClone(details) : {},
      };
      session.activityLog.push(entry);
      if (session.activityLog.length > ACTIVITY_LOG_LIMIT) session.activityLog.splice(0, session.activityLog.length - ACTIVITY_LOG_LIMIT);
      await this.save(session);
      return entry;
    });
  }

  async deleteSession(sessionId) {
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      await this.storage.rm(this.dir(sessionId), { recursive: true, force: false });
      return session;
    });
  }

  async saveUpload(sessionId, kind, filename, buffer, mimeType) {
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      if (kind === 'audio' && (session.dictation?.chunks?.length || dictationIsActive(session.dictation))) {
        throw Object.assign(new Error('Finish or retry the current dictation before uploading audio'), { status: 409 });
      }
      const cleaned = safeFilename(filename);
      const uploadId = id(kind === 'audio' ? 'audio_' : 'material_');
      const folder = kind === 'audio' ? 'audio' : 'materials';
      const targetDir = path.join(this.dir(sessionId), folder);
      await this.storage.mkdir(targetDir);
      const storedPath = path.join(targetDir, `${uploadId}_${cleaned}`);
      await this.storage.writeFile(storedPath, buffer, { flag: 'wx' });
      const record = {
        id: uploadId,
        filename: cleaned,
        mimeType: String(mimeType || 'application/octet-stream'),
        bytes: buffer.length,
        storedPath,
        createdAt: now(),
        ...(kind === 'material' ? { extractionState: 'stored' } : {}),
      };
      if (kind === 'audio') {
        session.audio = record;
      }
      else {
        session.materials.push(record);
        this.invalidateMaterialDependents(session);
      }
      await this.save(session);
      return { session, record };
    });
  }

  async startDictation(sessionId, {
    model = DEFAULT_STT_MODEL,
    language = DEFAULT_STT_LANGUAGE,
    stagedAsr = false,
    asrModels = null,
    asrFallbacks = null,
  } = {}) {
    const run = this.dictationStartLock.catch(() => {}).then(() => this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      if (dictationIsActive(session.dictation)) {
        throw Object.assign(new Error('Dictation is already active for this session'), { status: 409 });
      }
      if (session.dictation?.status !== 'complete' && session.dictation?.chunks?.length) {
        throw Object.assign(new Error('Saved dictation chunks are waiting to be retried or finalized'), { status: 409 });
      }
      // Cleanup is intentionally allowed to overlap a resumed dictation. Raw
      // changes still invalidate the in-flight cleanup result via the normal
      // dependency fingerprint checks, but recording itself must not be
      // blocked by a background Cleaned Transcript request.
      if (session.processing?.status === 'running' && !['dictation', 'cleanup'].includes(session.processing.stage)) {
        throw Object.assign(new Error('Finish the current processing stage before resuming dictation'), { status: 409 });
      }
      const otherActive = (await this.listRaw()).find((candidate) => candidate.id !== sessionId && dictationIsActive(candidate.dictation));
      if (otherActive) {
        throw Object.assign(new Error(`Dictation is already active for “${otherActive.title || 'another lecture'}”`), { status: 409 });
      }
      const transcriptPrefix = session.artifacts.rawTranscript?.content || '';
      const priorSegments = session.paragraphization?.segments || [];
      const timelineOffset = priorSegments.reduce((maximum, segment) => Math.max(maximum, Number(segment.timelineEnd ?? segment.end ?? 0)), 0);
      if (session.transcriptBase === undefined) {
        session.transcriptBase = transcriptPrefix;
        session.transcriptBaseOriginal = session.artifacts.rawTranscript?.originalContent || transcriptPrefix;
        session.transcriptBaseSegments = priorSegments;
      }
      session.dictation = {
        id: id('dictation_'),
        ordinal: (session.recordingSegments || []).length,
        status: 'recording',
        model,
        language,
        stagedAsr: Boolean(stagedAsr),
        asrModels: stagedAsr ? { ...asrModels } : null,
        asrFallbacks: stagedAsr ? structuredClone(asrFallbacks || {}) : null,
        asrMode: stagedAsr ? 'rag-revision' : null,
        startedAt: now(),
        updatedAt: now(),
        transcriptPrefix,
        transcriptPrefixFingerprint: fingerprint(transcriptPrefix),
        originalTranscriptPrefix: session.artifacts.rawTranscript?.originalContent || transcriptPrefix,
        timelineOffset,
        chunks: [],
        lastError: null,
      };
      session.asr = stagedAsr ? {
        schemaVersion: 1,
        mode: 'rag-revision',
        status: 'recording',
        models: { ...asrModels },
        pending: { provisional: 0, revised: 0, highQuality: 0 },
        failed: { provisional: 0, revised: 0, highQuality: 0 },
        updatedAt: now(),
      } : session.asr;
      session.processing = { stage: 'dictation', status: 'running', message: 'Recording and transcribing…', startedAt: now() };
      await this.save(session);
      return session.dictation;
    }));
    this.dictationStartLock = run;
    try {
      return await run;
    } finally {
      if (this.dictationStartLock === run) this.dictationStartLock = Promise.resolve();
    }
  }

  async saveDictationChunk(sessionId, sequence, buffer, { startMs, endMs, hasSpeech = true, boundary = 'legacy-fixed' } = {}) {
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      if (!session.dictation || !['recording', 'finalizing', 'error'].includes(session.dictation.status)) {
        throw Object.assign(new Error('No recoverable dictation is active'), { status: 409 });
      }
      const existing = session.dictation.chunks.find((chunk) => chunk.sequence === sequence);
      if (existing) return existing;
      const chunkDir = path.join(this.dir(sessionId), 'audio', session.dictation.id);
      const storedPath = path.join(chunkDir, `chunk-${String(sequence).padStart(6, '0')}.wav`);
      await this.storage.writeFile(storedPath, buffer, { flag: 'wx' });
      const duration = wavDurationSeconds(buffer);
      const relativeStart = Number.isFinite(Number(startMs)) && Number(startMs) >= 0 ? Number(startMs) / 1000 : sequence * Math.max(duration, 4);
      const relativeEnd = Number.isFinite(Number(endMs)) && Number(endMs) > relativeStart * 1000
        ? Number(endMs) / 1000 : relativeStart + duration;
      let transcriptSegment = null;
      if (session.dictation.stagedAsr) {
        const previousRecordingCount = (session.transcriptSegments || [])
          .filter((segment) => segment.recordingSegmentId !== session.dictation.id).length;
        const ordinal = previousRecordingCount + sequence;
        transcriptSegment = {
          id: id('transcript_segment_'),
          ordinal,
          recordingSegmentId: session.dictation.id,
          chunkSequence: sequence,
          start: Number(session.dictation.timelineOffset || 0) + relativeStart,
          end: Number(session.dictation.timelineOffset || 0) + Math.max(relativeStart, relativeEnd),
          relativeStart,
          relativeEnd: Math.max(relativeStart, relativeEnd),
          boundary: String(boundary || 'unknown'),
          hasSpeech: Boolean(hasSpeech),
          language: session.dictation.language || session.language || DEFAULT_STT_LANGUAGE,
          sourceRevision: fingerprint(buffer),
          versions: {},
          stages: Object.fromEntries(ASR_STAGES.map((stage) => [stage, {
            status: stage === ASR_STAGE.PROVISIONAL ? 'pending'
              : stage === ASR_STAGE.REVISED ? 'deferred' : 'skipped',
            attempt: 0,
            token: null,
          }])),
          models: { ...(session.dictation.asrModels || {}) },
          fallbacks: structuredClone(session.dictation.asrFallbacks || {}),
          createdAt: now(),
          updatedAt: now(),
        };
        session.transcriptSegments ||= [];
        session.transcriptSegments.push(transcriptSegment);
      }
      const record = {
        sequence,
        storedPath,
        bytes: buffer.length,
        status: 'saved',
        segmentId: transcriptSegment?.id || null,
        sourceRevision: transcriptSegment?.sourceRevision || fingerprint(buffer),
        start: Number(session.dictation.timelineOffset || 0) + relativeStart,
        end: Number(session.dictation.timelineOffset || 0) + Math.max(relativeStart, relativeEnd),
        boundary: String(boundary || 'unknown'),
        hasSpeech: Boolean(hasSpeech),
        createdAt: now(),
      };
      session.dictation.chunks.push(record);
      session.dictation.chunks.sort((a, b) => a.sequence - b.sequence);
      session.dictation.updatedAt = now();
      await this.save(session);
      return record;
    });
  }

  findTranscriptChunk(session, segment) {
    const recordings = [session.dictation, ...(session.recordingSegments || [])].filter(Boolean);
    for (const recording of recordings) {
      if (recording.id !== segment.recordingSegmentId) continue;
      const chunk = (recording.chunks || []).find((item) => item.sequence === segment.chunkSequence);
      if (chunk) return chunk;
    }
    return null;
  }

  refreshAsrStatus(session) {
    if (!session.asr) return;
    const segments = session.transcriptSegments || [];
    const pending = {};
    const failed = {};
    const completed = {};
    for (const stage of ASR_STAGES) {
      pending[stage] = segments.filter((segment) => ['pending', 'running'].includes(segment.stages?.[stage]?.status)).length;
      failed[stage] = segments.filter((segment) => segment.stages?.[stage]?.status === 'error').length;
      completed[stage] = segments.filter((segment) => Boolean(segment.versions?.[stage])).length;
    }
    const activeDictation = dictationIsActive(session.dictation);
    session.asr = {
      ...session.asr,
      mode: session.asr.mode || session.dictation?.asrMode || 'rag-revision',
      status: activeDictation ? 'recording'
        : pending.revised ? 'background'
          : segments.length ? 'complete' : 'idle',
      pending,
      backlog: summarizeAsrBacklog(segments),
      failed,
      completed,
      segmentCount: segments.length,
      updatedAt: now(),
    };
  }

  async configureRagRevision(sessionId) {
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      if (!session.asr) return session;
      let changed = session.asr.mode !== 'rag-revision';
      session.asr.mode = 'rag-revision';
      if (session.dictation?.stagedAsr) {
        if (session.dictation.asrMode !== 'rag-revision') changed = true;
        session.dictation.asrMode = 'rag-revision';
      }
      for (const segment of session.transcriptSegments || []) {
        if (!segment.versions?.revised && ['pending', 'running'].includes(segment.stages?.revised?.status)) {
          changed = true;
          segment.stages.revised = {
            ...segment.stages.revised,
            status: 'deferred',
            token: null,
            error: null,
          };
        }
        if (segment.versions?.highQuality) continue;
        segment.stages ||= {};
        if (segment.stages.highQuality?.status !== 'skipped') changed = true;
        segment.stages.highQuality = {
          ...segment.stages.highQuality,
          status: 'skipped',
          token: null,
          error: null,
          skippedReason: 'Version C uses material RAG over the prompt-revised Raw transcript.',
        };
      }
      if (session.artifacts.highQualityTranscript?.generationState === 'running') {
        changed = true;
        session.artifacts.highQualityTranscript = {
          ...session.artifacts.highQualityTranscript,
          generationState: 'superseded',
          stale: true,
          staleReason: 'Version C revision now uses the prompt-revised Raw transcript.',
          updatedAt: now(),
        };
      }
      if (session.artifacts.cleanedTranscript?.dependsOn?.key === 'highQualityTranscript') {
        changed = true;
        session.artifacts.cleanedTranscript = this.markStale(
          session.artifacts.cleanedTranscript,
          'Version C revision now uses the prompt-revised Raw transcript.',
        );
      }
      this.refreshAsrStatus(session);
      if (changed) await this.save(session);
      return session;
    });
  }

  projectRawTranscript(session, changedStage) {
    const projected = projectTranscript(session.transcriptSegments || [], { stage: 'usable' });
    const content = appendTranscript(session.transcriptBase || '', projected.content);
    if (!content) {
      this.refreshAsrStatus(session);
      return;
    }
    const previous = session.artifacts.rawTranscript;
    const contentChanged = previous?.content !== content;
    const provisional = projectTranscript(session.transcriptSegments || [], { stage: ASR_STAGES[0] });
    const originalContent = appendTranscript(session.transcriptBaseOriginal || session.transcriptBase || '', provisional.content)
      || previous?.originalContent || content;
    session.artifacts.rawTranscript = {
      ...(previous || {}),
      content,
      contentFingerprint: fingerprint(content),
      originalContent,
      source: 'multistage-live-dictation',
      sourceStage: changedStage,
      provider: projected.segments.at(-1)?.provider || previous?.provider || 'whisper.cpp',
      model: projected.segments.at(-1)?.model || previous?.model || session.dictation?.model,
      language: projected.segments.at(-1)?.language || previous?.language || session.language,
      segments: projected.segments,
      updatedAt: now(),
      revisions: previous?.revisions || [],
      stale: false,
      staleReason: null,
    };
    const baseSegments = Array.isArray(session.transcriptBaseSegments) ? session.transcriptBaseSegments : [];
    const structuralSegments = projected.segments.map((segment) => ({
      id: segment.id,
      text: segment.text,
      start: segment.start,
      end: segment.end,
      timelineStart: segment.start,
      timelineEnd: segment.end,
      recordingSegmentId: segment.recordingSegmentId,
      source: segment.stage,
      model: segment.model,
    }));
    session.paragraphization = paragraphize(baseSegments.concat(structuralSegments), {
      previous: session.paragraphization,
      mode: dictationIsActive(session.dictation) ? 'live' : 'final',
      sourceFingerprint: session.artifacts.rawTranscript.contentFingerprint,
    });
    if (contentChanged) this.invalidateRawDependents(session);
    this.refreshAsrStatus(session);
  }

  projectHighQualityTranscript(session) {
    const segments = orderedTranscriptSegments(session.transcriptSegments || []);
    if (!segments.length) return;
    const projected = projectTranscript(segments, { stage: 'highQuality', includeIntegrated: true });
    const sourceFingerprint = audioSourceFingerprint(session);
    const previous = session.artifacts.highQualityTranscript;
    const completed = segments.filter((segment) => Boolean(segment.versions?.highQuality)).length;
    const failed = segments.filter((segment) => segment.stages?.highQuality?.status === 'error').length;
    const generationState = completed === segments.length ? 'complete' : failed ? 'error' : 'running';
    session.artifacts.highQualityTranscript = {
      ...(previous || {}),
      content: projected.content,
      contentFingerprint: fingerprint(projected.content),
      source: 'high-quality-asr',
      sourceArtifact: 'originalAudio',
      sourceFingerprint,
      audioSourceFingerprint: sourceFingerprint,
      generationState,
      completedSegments: completed,
      expectedSegments: segments.length,
      failedSegments: failed,
      segments: projected.segments,
      models: [...new Set(projected.segments.map((segment) => segment.model).filter(Boolean))],
      stale: false,
      staleReason: null,
      updatedAt: now(),
      generatedAt: generationState === 'complete' ? now() : previous?.generatedAt || null,
    };
    session.highQualityParagraphization = paragraphize(projected.segments, {
      previous: session.highQualityParagraphization,
      mode: generationState === 'complete' ? 'final' : 'live',
      sourceFingerprint: fingerprint(projected.content),
    });
    if (!previous || previous.sourceFingerprint !== sourceFingerprint || previous.content !== projected.content) {
      this.invalidateHighQualityDependents(session);
    }
    this.refreshAsrStatus(session);
  }

  async beginTranscriptStage(sessionId, segmentId, stage, { force = false, model } = {}) {
    if (!ASR_STAGES.includes(stage)) throw Object.assign(new Error('Unknown ASR stage'), { status: 400 });
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      const segment = (session.transcriptSegments || []).find((item) => item.id === segmentId);
      if (!segment) throw Object.assign(new Error('Transcript segment was not found'), { status: 404 });
      const chunk = this.findTranscriptChunk(session, segment);
      if (!chunk) throw Object.assign(new Error('Original audio for this transcript segment was not found'), { status: 404, code: 'ASR_AUDIO_MISSING' });
      if (!force && segment.versions?.[stage]) {
        return { skip: true, version: structuredClone(segment.versions[stage]), segment: structuredClone(segment) };
      }
      const previous = segment.stages?.[stage] || { attempt: 0 };
      const token = id(`asr_${stage}_`);
      const selectedModel = model || segment.models?.[stage];
      segment.stages ||= {};
      segment.stages[stage] = {
        status: 'running',
        attempt: Number(previous.attempt || 0) + 1,
        token,
        model: selectedModel,
        startedAt: now(),
        error: null,
      };
      segment.updatedAt = now();
      this.refreshAsrStatus(session);
      await this.save(session);
      return {
        skip: false,
        token,
        sourceRevision: segment.sourceRevision,
        audioPath: chunk.storedPath,
        hasSpeech: segment.hasSpeech,
        model: selectedModel,
        fallbacks: [...(segment.fallbacks?.[stage] || [selectedModel])].filter(Boolean),
        language: segment.language || session.dictation?.language || session.language || DEFAULT_STT_LANGUAGE,
        segment: structuredClone(segment),
      };
    });
  }

  async completeTranscriptStage(sessionId, segmentId, stage, result, { token, sourceRevision } = {}) {
    if (!ASR_STAGES.includes(stage)) throw Object.assign(new Error('Unknown ASR stage'), { status: 400 });
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      const segment = (session.transcriptSegments || []).find((item) => item.id === segmentId);
      if (!segment) throw asrStaleError('The transcript segment no longer exists');
      if (sourceRevision && segment.sourceRevision !== sourceRevision) throw asrStaleError('Original segment audio changed before ASR completed');
      if (!segment.stages?.[stage] || segment.stages[stage].token !== token) throw asrStaleError();
      const content = String(result?.content || '').replace(/\s+/gu, ' ').trim();
      const completedAt = now();
      segment.versions ||= {};
      segment.versions[stage] = {
        stage,
        content,
        language: result?.language,
        provider: result?.provider,
        model: result?.model || segment.stages[stage].model,
        providerSegments: Array.isArray(result?.segments) ? result.segments : [],
        sourceRevision: segment.sourceRevision,
        attempt: segment.stages[stage].attempt,
        completedAt,
      };
      segment.stages[stage] = {
        ...segment.stages[stage],
        status: 'complete',
        token: null,
        model: segment.versions[stage].model,
        completedAt,
        error: null,
      };
      segment.updatedAt = completedAt;
      const chunk = this.findTranscriptChunk(session, segment);
      if (stage === 'provisional' && chunk) {
        chunk.status = 'transcribed';
        chunk.transcript = content;
        chunk.language = result?.language;
        chunk.error = null;
        chunk.segments = Array.isArray(result?.segments) ? result.segments : [];
        if (session.dictation?.status === 'error') session.dictation.status = 'recording';
      }
      if (stage === 'provisional' || stage === 'revised') this.projectRawTranscript(session, stage);
      if (stage === 'highQuality') this.projectHighQualityTranscript(session);
      this.refreshAsrStatus(session);
      await this.save(session);
      return { segment: structuredClone(segment), artifact: session.artifacts.rawTranscript, highQualityArtifact: session.artifacts.highQualityTranscript };
    });
  }

  async failTranscriptStage(sessionId, segmentId, stage, error, { token, sourceRevision, model } = {}) {
    if (!ASR_STAGES.includes(stage)) throw Object.assign(new Error('Unknown ASR stage'), { status: 400 });
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      const segment = (session.transcriptSegments || []).find((item) => item.id === segmentId);
      if (!segment || (sourceRevision && segment.sourceRevision !== sourceRevision) || segment.stages?.[stage]?.token !== token) {
        throw asrStaleError();
      }
      const message = String(error?.message || error || 'ASR failed');
      segment.stages[stage] = {
        ...segment.stages[stage],
        status: 'error',
        token: null,
        model: model || segment.stages[stage].model,
        error: message,
        finishedAt: now(),
      };
      segment.updatedAt = now();
      const chunk = this.findTranscriptChunk(session, segment);
      if (stage === 'provisional' && chunk) {
        chunk.status = 'error';
        chunk.error = message;
        if (session.dictation) {
          session.dictation.status = 'error';
          session.dictation.lastError = message;
        }
      }
      if (stage === 'highQuality') this.projectHighQualityTranscript(session);
      this.refreshAsrStatus(session);
      await this.save(session);
      return structuredClone(segment.stages[stage]);
    });
  }

  async setDictationChunkResult(sessionId, sequence, result) {
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      const chunk = session.dictation?.chunks.find((item) => item.sequence === sequence);
      if (!chunk) throw Object.assign(new Error('Dictation chunk was not found'), { status: 404 });
      if (result.error) {
        chunk.status = 'error';
        chunk.error = String(result.error);
        session.dictation.lastError = chunk.error;
        session.dictation.status = 'error';
      } else {
        chunk.status = 'transcribed';
        chunk.transcript = String(result.content || '').trim();
        chunk.language = result.language;
        const providerSegments = Array.isArray(result.segments) ? result.segments : [];
        // Keep provider timestamps whenever available. A provider may differ
        // in punctuation/spacing from the normalized raw chunk text; that is
        // not a reason to discard its timing metadata.
        chunk.segments = providerSegments.length
          ? normalizeSegments(providerSegments, chunk.transcript, { prefix: `chunk_${sequence}` })
          : normalizeSegments([], chunk.transcript, { prefix: `chunk_${sequence}` });
        chunk.error = null;
        session.dictation.lastError = null;
        if (session.dictation.status === 'error') session.dictation.status = 'recording';
      }
      const transcribedChunks = session.dictation.chunks
        .filter((item) => item.status === 'transcribed' && item.transcript)
        .sort((a, b) => a.sequence - b.sequence);
      const integratedSequences = new Set(session.dictation.integratedChunkSequences || []);
      const pendingChunks = transcribedChunks.filter((item) => !integratedSequences.has(item.sequence));
      const confirmedTranscript = transcribedChunks
        .map((item) => item.transcript)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      const segmentTranscript = pendingChunks
        .map((item) => item.transcript)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      const content = appendTranscript(session.dictation.transcriptPrefix, segmentTranscript);
      const rawChanged = Boolean(content) && content !== session.artifacts.rawTranscript?.content;
      if (rawChanged) {
        const previous = session.artifacts.rawTranscript;
        const originalContent = appendTranscript(session.dictation.originalTranscriptPrefix, confirmedTranscript);
        session.artifacts.rawTranscript = {
          content,
          contentFingerprint: fingerprint(content),
          originalContent,
          source: 'live-dictation',
          provider: result.provider || 'whisper.cpp',
          model: session.dictation.model,
          language: result.language || session.dictation.language,
          updatedAt: now(),
          revisions: previous?.revisions || [],
        };
        const priorSegments = (session.paragraphization?.segments || []).filter((segment) => segment.recordingSegmentId !== session.dictation.id);
        const segments = pendingChunks.flatMap((chunk) => (chunk.segments || normalizeSegments([], chunk.transcript, { prefix: `${session.dictation.id}_chunk_${chunk.sequence}` })).map((segment) => ({
          ...segment,
          id: `${session.dictation.id}_chunk_${chunk.sequence}_${segment.id}`,
          chunkId: `${session.dictation.id}:${chunk.sequence}`,
          recordingSegmentId: session.dictation.id,
          chunkSequence: chunk.sequence,
          // Chunk duration is known from the recorded WAV cadence even when a
          // provider omits timestamps. This keeps pauses between chunks usable
          // without pretending there is a pause inside one chunk.
          timelineStart: Number(session.dictation.timelineOffset || 0) + Number(chunk.sequence) * 4 + Number(segment.start || 0),
          timelineEnd: Number(session.dictation.timelineOffset || 0) + Number(chunk.sequence) * 4 + Number(segment.end || segment.start || 0),
        })));
        session.paragraphization = paragraphize(priorSegments.concat(segments), {
          previous: session.paragraphization,
          mode: 'live',
          sourceFingerprint: session.artifacts.rawTranscript.contentFingerprint,
        });
        this.invalidateRawDependents(session);
      }
      session.dictation.updatedAt = now();
      session.processing = result.error
        ? { stage: 'dictation', status: 'error', message: `A dictation chunk failed: ${result.error}. Recording and confirmed text were preserved.`, finishedAt: now() }
        : { stage: 'dictation', status: 'running', message: 'Recording and transcribing…', startedAt: session.dictation.startedAt };
      await this.save(session);
      return { dictation: session.dictation, artifact: session.artifacts.rawTranscript };
    });
  }

  async markDictationFinalizing(sessionId) {
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      if (!session.dictation) throw Object.assign(new Error('No dictation is available to finalize'), { status: 409 });
      if (session.dictation.status === 'complete') return session;
      session.dictation.status = 'finalizing';
      session.dictation.updatedAt = now();
      session.processing = { stage: 'dictation', status: 'running', message: 'Processing remaining audio…', startedAt: session.dictation.startedAt };
      this.refreshAsrStatus(session);
      return this.save(session);
    });
  }

  async finalizeDictation(sessionId) {
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      if (!session.dictation) throw Object.assign(new Error('No dictation is available to finalize'), { status: 409 });
      if (session.dictation.status === 'complete') return session;
      if (!session.dictation.chunks.length) {
        session.dictation = null;
        session.processing = { stage: 'dictation', status: 'success', message: 'No dictation audio was recorded', finishedAt: now() };
        return this.save(session);
      }
      const chunks = session.dictation.chunks.sort((a, b) => a.sequence - b.sequence);
      const storedPath = path.join(this.dir(sessionId), 'audio', `${session.dictation.id}.wav`);
      let audio;
      try {
        audio = await combinePcmWavFiles(chunks.map((chunk) => chunk.storedPath), storedPath);
      } catch (error) {
        session.dictation.status = 'error';
        session.dictation.lastError = error.message;
        session.processing = { stage: 'dictation', status: 'error', message: `Could not combine recorded audio: ${error.message}`, finishedAt: now() };
        await this.save(session);
        throw error;
      }
      const filename = `dictation-${session.dictation.startedAt.replace(/[:.]/g, '-')}-${session.dictation.id.slice(-8)}.wav`;
      const audioRecord = {
        id: id('audio_'),
        filename,
        mimeType: 'audio/wav',
        bytes: audio.bytes,
        storedPath,
        createdAt: session.dictation.startedAt,
      };
      session.recordingSegments ||= [];
      const finishedAt = now();
      const completedSegment = {
        ...session.dictation,
        status: 'complete',
        finishedAt,
        updatedAt: finishedAt,
        audio: audioRecord,
      };
      const existingIndex = session.recordingSegments.findIndex((segment) => segment.id === completedSegment.id);
      if (existingIndex >= 0) session.recordingSegments[existingIndex] = completedSegment;
      else session.recordingSegments.push(completedSegment);
      session.recordingSegments.sort((left, right) => Number(left.ordinal ?? 0) - Number(right.ordinal ?? 0));
      if (!session.audio) session.audio = audioRecord;
      if (session.artifacts.rawTranscript?.content) {
        session.artifacts.rawTranscript.originalContent ||= session.artifacts.rawTranscript.content;
        session.artifacts.rawTranscript.updatedAt = now();
        if (session.paragraphization) {
          session.paragraphization = paragraphize(session.paragraphization.segments, {
            previous: session.paragraphization,
            mode: 'final',
            sourceFingerprint: session.artifacts.rawTranscript.contentFingerprint,
          });
        }
      }
      session.dictation = completedSegment;
      session.processing = { stage: 'dictation', status: 'success', message: 'Dictation completed', finishedAt: now() };
      if (completedSegment.stagedAsr) {
        this.projectRawTranscript(session, 'revised');
      }
      this.refreshAsrStatus(session);
      await this.save(session);
      return session;
    });
  }

  async setMaterialExtraction(sessionId, materialId, extraction) {
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      const material = session.materials.find((item) => item.id === materialId);
      if (!material) {
        const error = new Error('Material not found');
        error.status = 404;
        throw error;
      }
      const extractionState = extraction.extractionState || (extraction.extractionError ? 'error'
        : extraction.extractedText ? 'complete' : material.extractionState || 'extracting');
      Object.assign(material, extraction, { extractionState, extractedAt: now() });
      this.invalidateMaterialDependents(session);
      await this.save(session);
      return material;
    });
  }

  async setMaterialExtractionProgress(sessionId, materialId, progress = {}) {
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      const material = session.materials.find((item) => item.id === materialId);
      if (!material) throw Object.assign(new Error('Material not found'), { status: 404 });
      Object.assign(material, {
        extractionState: String(progress.extractionState || 'extracting'),
        extractionStep: String(progress.extractionStep || '').slice(0, 100),
        extractionUpdatedAt: now(),
      });
      await this.save(session);
      return material;
    });
  }

  async deleteMaterial(sessionId, materialId) {
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      const index = session.materials.findIndex((item) => item.id === materialId);
      if (index < 0) {
        const error = new Error('Material not found');
        error.status = 404;
        throw error;
      }
      const [material] = session.materials.splice(index, 1);
      this.invalidateMaterialDependents(session);
      await this.save(session);
      await this.storage.unlink(material.storedPath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      return session;
    });
  }

  async setArtifact(sessionId, key, artifact, { preserve = false, baseContent } = {}) {
    if (!ARTIFACT_KEYS.has(key)) {
      const error = new Error('Unknown artifact');
      error.status = 400;
      throw error;
    }
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      if (artifact.source !== 'manual-edit' && (artifact.materialContextFingerprint !== undefined
        || (key === 'cleanedTranscript' && artifact.pipelineRevision === CORRECTION_REVISION))) {
        if (artifact.materialContextFingerprint !== correctionMaterialsFingerprint(session.materials)) {
          throw Object.assign(new Error('Course materials changed while generation was running; the stale result was discarded'), { status: 409, code: 'STALE_RESULT' });
        }
        const current = session.artifacts[key];
        if (key === 'cleanedTranscript' && current?.source === 'manual-edit'
          && (artifact.cleanupBaseSource !== 'manual-edit' || artifact.cleanupBaseFingerprint !== fingerprint(current.content))) {
          throw Object.assign(new Error('A manual edit replaced this generation; the stale result was discarded'), { status: 409, code: 'STALE_RESULT' });
        }
      }
      if (artifact.source !== 'manual-edit' && artifact.dependsOn?.key) {
        const sourceArtifact = session.artifacts[artifact.dependsOn.key];
        const sourceContent = sourceArtifact?.content || '';
        const sourceChanged = fingerprint(sourceContent) !== artifact.dependsOn.fingerprint
          || (sourceArtifact?.stale && sourceArtifact.source !== 'manual-edit')
          || (key === 'cleanedTranscript' && this.dependencyFor(session, key).key !== artifact.dependsOn.key);
        if (sourceChanged) {
          throw Object.assign(new Error('Source changed while generation was running; the stale result was discarded'), { status: 409, code: 'STALE_RESULT' });
        }
        if (artifact.targetLanguage && artifact.targetLanguage !== session.targetLanguage) {
          throw Object.assign(new Error('Target language changed while generation was running; the stale result was discarded'), { status: 409, code: 'STALE_RESULT' });
        }
      }
      const previous = session.artifacts[key];
      const revisions = previous?.revisions || [];
      if (previous?.content !== undefined) {
        revisions.push({
          content: previous.content,
          updatedAt: previous.updatedAt,
          source: previous.source,
        });
      }
      const content = key === 'rawTranscript' && artifact.source === 'manual-edit' && dictationIsActive(session.dictation)
        ? mergeConcurrentRawEdit(baseContent ?? previous?.content ?? '', artifact.content, previous?.content ?? '')
        : String(artifact.content ?? '');
      const dependency = artifact.dependsOn || this.dependencyFor(session, key, content);
      session.artifacts[key] = {
        ...artifact,
        content,
        contentFingerprint: fingerprint(content),
        sourceFingerprint: artifact.sourceFingerprint || fingerprint(content),
        dependsOn: dependency || undefined,
        stale: false,
        staleReason: null,
        updatedAt: now(),
        revisions: revisions.slice(-50),
      };
      if (preserve) {
        session.artifacts[key].originalContent = previous?.originalContent ?? previous?.content ?? String(artifact.content ?? '');
      }
      if (key === 'rawTranscript') {
        if (artifact.source === 'manual-edit' && dictationIsActive(session.dictation)) {
          session.dictation.transcriptPrefix = content;
          session.dictation.transcriptPrefixFingerprint = fingerprint(content);
          session.dictation.integratedChunkSequences = session.dictation.chunks
            .filter((chunk) => chunk.status === 'transcribed')
            .map((chunk) => chunk.sequence);
        }
        if (Array.isArray(artifact.segments)) {
          const segments = normalizeSegments(artifact.segments, content);
          session.paragraphization = paragraphize(segments, {
            previous: session.paragraphization,
            mode: 'final',
            sourceFingerprint: fingerprint(content),
          });
        } else {
          const segments = session.paragraphization?.sourceFingerprint === fingerprint(content)
            ? session.paragraphization.segments
            : normalizeSegments([], content);
          session.paragraphization = paragraphize(segments, {
            previous: session.paragraphization,
            mode: 'final',
            sourceFingerprint: fingerprint(content),
          });
        }
        if (artifact.source === 'manual-edit') {
          session.transcriptBase = content;
          session.transcriptBaseOriginal = session.artifacts[key].originalContent || content;
          session.transcriptBaseSegments = session.paragraphization?.segments || normalizeSegments([], content);
          for (const segment of session.transcriptSegments || []) segment.integratedIntoBase = true;
        }
        this.invalidateRawDependents(session);
      } else if (key === 'highQualityTranscript') {
        session.highQualityParagraphization = paragraphize(normalizeSegments(artifact.segments || [], content), {
          previous: session.highQualityParagraphization,
          mode: 'final',
          sourceFingerprint: fingerprint(content),
        });
        this.invalidateHighQualityDependents(session);
      } else if (key === 'cleanedTranscript') {
        session.artifacts.translation = this.markStale(session.artifacts.translation, 'Cleaned transcript changed');
        session.artifacts.cleanedTranslation = this.markStale(session.artifacts.cleanedTranslation, 'Cleaned transcript changed');
        for (const downstreamKey of ['keyPoints', 'qa', 'structuredAnalysis', 'notes', 'outline']) {
          session.artifacts[downstreamKey] = this.markStale(session.artifacts[downstreamKey], 'Cleaned transcript changed');
        }
      } else if (key === 'notes') {
        session.artifacts.notesTranslation = this.markStale(session.artifacts.notesTranslation, 'Notes changed');
      } else if (key === 'outline') {
        session.artifacts.outlineTranslation = this.markStale(session.artifacts.outlineTranslation, 'Outline changed');
      }
      await this.save(session);
      return session.artifacts[key];
    });
  }

  async updateParagraphs(sessionId, action, input = {}) {
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      if (!session.paragraphization) throw Object.assign(new Error('No paragraphized transcript is available'), { status: 409 });
      const updated = action === 'split'
        ? splitParagraph(session.paragraphization, input)
        : action === 'merge-previous' ? mergePreviousParagraph(session.paragraphization, input)
          : (() => { throw Object.assign(new Error('Unknown paragraph action'), { status: 400 }); })();
      session.paragraphization = updated;
      await this.save(session);
      return session;
    });
  }

  async refineParagraphs(sessionId) {
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      if (!session.paragraphization) return session;
      const raw = session.artifacts.rawTranscript?.content || '';
      session.paragraphization = paragraphize(session.paragraphization.segments, {
        previous: session.paragraphization,
        mode: 'final',
        sourceFingerprint: fingerprint(raw),
      });
      await this.save(session);
      return session;
    });
  }

  async saveRawTranslation(sessionId, value, { expectedSourceFingerprint, expectedTargetLanguage } = {}) {
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      const rawFingerprint = fingerprint(session.artifacts.rawTranscript?.content || '');
      if (expectedSourceFingerprint && expectedSourceFingerprint !== rawFingerprint) return null;
      if (expectedTargetLanguage && expectedTargetLanguage !== session.targetLanguage) return null;
      const next = rawTranslationArtifact(session, value);
      if (rawTranslationEquivalent(session.artifacts.rawTranslation, next)) return session.artifacts.rawTranslation;
      session.artifacts.rawTranslation = next;
      await this.save(session);
      return session.artifacts.rawTranslation;
    });
  }

  async setLiveTranslation(sessionId, update) {
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      session.liveTranslation = { enabled: false, status: 'idle', ...session.liveTranslation, ...update };
      await this.save(session);
      return session;
    });
  }

  async claimLiveTranslationUnit(sessionId, { id: unitId, sourceRevision, targetLanguage }) {
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      if (session.targetLanguage !== targetLanguage) return false;
      const translation = session.artifacts.rawTranslation;
      const unit = translation?.segments?.find((segment) => segment.id === unitId && segment.sourceRevision === sourceRevision)
        || (translation?.pendingTranslation?.id === unitId && translation.pendingTranslation.sourceRevision === sourceRevision
          ? translation.pendingTranslation : null);
      if (!unit || !rawUnitNeedsTranslation(unit) || unit.liveTranslationAttemptedAt || unit.status === 'error') return false;
      unit.liveTranslationAttemptedAt = now();
      await this.save(session);
      return true;
    });
  }

  async applyRawTranslationUnit(sessionId, value) {
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      if (String(value.targetLanguage || '') !== session.targetLanguage) return null;
      const raw = session.artifacts.rawTranscript?.content || '';
      if (!raw) return null;
      const current = session.artifacts.rawTranslation;
      const rawFingerprint = fingerprint(raw);
      const assembled = current?.sourceFingerprint === rawFingerprint && !current.stale
        ? {
          ...current,
          segments: Array.isArray(current.segments) ? current.segments.map((segment) => ({ ...segment })) : [],
          pendingTranslation: current.pendingTranslation ? { ...current.pendingTranslation } : null,
        }
        : assembleRawUnits(raw, current, {
          finalizeTail: !['recording', 'finalizing'].includes(session.dictation?.status),
          sourceSegments: session.paragraphization?.segments || [],
          targetLanguage: session.targetLanguage,
        });
      const unit = assembled.segments.find((segment) => segment.id === value.id && segment.sourceRevision === value.sourceRevision)
        || assembled.segments.find((segment) => segment.sourceText === value.sourceText && segment.sourceRevision === value.sourceRevision)
        || (assembled.pendingTranslation?.id === value.id && assembled.pendingTranslation.sourceRevision === value.sourceRevision
          ? assembled.pendingTranslation : null);
      if (!unit) return null;
      const translatedText = String(value.translatedText || '').trim();
      const nextStatus = translatedText ? value.status || 'translated' : 'error';
      if (translatedText) {
        unit.translatedText = translatedText;
        unit.previousTranslatedText = '';
        if (nextStatus === 'translated') {
          unit.translatedRevision = value.translatedRevision || value.sourceRevision;
          unit.translatedTargetLanguage = value.translatedTargetLanguage || value.targetLanguage;
        }
      }
      unit.status = nextStatus;
      unit.error = value.error || null;
      unit.provider = value.provider;
      unit.model = value.model;
      unit.translatedAt = value.translatedAt || now();
      const allUnits = [...assembled.segments, assembled.pendingTranslation].filter(Boolean);
      const hasPending = allUnits.some((segment) => ['pending', 'translating', 'updating'].includes(segment.status));
      const hasError = allUnits.some((segment) => segment.status === 'error');
      session.artifacts.rawTranslation = rawTranslationArtifact(session, {
        ...assembled,
        targetLanguage: session.targetLanguage,
        generationState: hasPending ? 'running' : hasError ? 'error' : 'idle',
        generatedAt: unit.translatedText ? now() : session.artifacts.rawTranslation?.generatedAt,
      });
      await this.save(session);
      return session.artifacts.rawTranslation;
    });
  }

  async settleRawTranslation(sessionId) {
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      const current = session.artifacts.rawTranslation;
      if (!current) return null;
      const segments = (Array.isArray(current.segments) ? current.segments : []).map((segment) => segment.status === 'translating'
        ? { ...segment, status: rawUnitNeedsTranslation(segment) ? (segment.translatedText ? 'updating' : 'pending') : 'translated' }
        : segment);
      const pendingTranslation = current.pendingTranslation?.status === 'translating'
        ? {
          ...current.pendingTranslation,
          status: rawUnitNeedsTranslation(current.pendingTranslation)
            ? (current.pendingTranslation.translatedText ? 'updating' : 'pending') : 'translated',
        }
        : current.pendingTranslation || null;
      const targetChanged = current.targetLanguage !== session.targetLanguage;
      const sourceChanged = current.sourceFingerprint !== fingerprint(session.artifacts.rawTranscript?.content || '');
      const allUnits = [...segments, pendingTranslation].filter(Boolean);
      const pending = allUnits.some(rawUnitNeedsTranslation);
      const stale = targetChanged || sourceChanged || pending;
      const next = {
        ...current,
        segments,
        pendingTranslation,
        generationState: allUnits.some((segment) => segment.status === 'error') ? 'error' : 'idle',
        stale,
        staleReason: targetChanged ? 'Translation target language changed'
          : stale ? current.staleReason || 'Translation needs a manual retry' : null,
      };
      if (rawTranslationEquivalent(current, next)) return current;
      // Pending units describe saved work for the next click. Once this job
      // settles, they must not keep the UI in a fictitious running state.
      session.artifacts.rawTranslation = { ...next, updatedAt: now() };
      await this.save(session);
      return session.artifacts.rawTranslation;
    });
  }

  dependencyFor(session, key, content = '') {
    if (key === 'cleanedTranscript') {
      return { key: 'rawTranscript', fingerprint: fingerprint(session.artifacts.rawTranscript?.content || '') };
    }
    if (['translation', 'cleanedTranslation'].includes(key)) {
      return { key: 'cleanedTranscript', fingerprint: fingerprint(session.artifacts.cleanedTranscript?.content || '') };
    }
    if (key === 'rawTranslation') return { key: 'rawTranscript', fingerprint: fingerprint(session.artifacts.rawTranscript?.content || '') };
    if (key === 'notesTranslation') return { key: 'notes', fingerprint: fingerprint(session.artifacts.notes?.content || '') };
    if (key === 'outlineTranslation') return { key: 'outline', fingerprint: fingerprint(session.artifacts.outline?.content || '') };
    if (['keyPoints', 'qa', 'structuredAnalysis', 'notes', 'outline'].includes(key)) {
      const sourceKey = session.artifacts.cleanedTranscript?.content ? 'cleanedTranscript' : 'rawTranscript';
      return { key: sourceKey, fingerprint: fingerprint(session.artifacts[sourceKey]?.content || '') };
    }
    return key === 'rawTranscript' ? { key: 'rawTranscript', fingerprint: fingerprint(content) } : undefined;
  }

  artifactIsValid(session, key) {
    const artifact = session.artifacts?.[key];
    if (artifact?.source === 'manual-edit' && ['cleanedTranscript', 'notes', 'outline'].includes(key)) return true;
    if (!artifact?.content || artifact.stale) return false;
    if (key === 'cleanedTranscript') {
      const sourceKey = 'rawTranscript';
      const source = session.artifacts.rawTranscript?.content;
      return Boolean(source) && (!artifact.generationState || artifact.generationState === 'complete')
        && artifact.dependsOn?.key === sourceKey
        && artifact.dependsOn.fingerprint === fingerprint(source)
        && artifact.pipelineRevision === CORRECTION_REVISION
        && artifact.materialContextFingerprint === correctionMaterialsFingerprint(session.materials);
    }
    if (['translation', 'cleanedTranslation'].includes(key)) {
      const cleaned = session.artifacts.cleanedTranscript?.content;
      return Boolean(cleaned) && artifact.dependsOn?.key === 'cleanedTranscript'
        && artifact.dependsOn.fingerprint === fingerprint(cleaned)
        && artifact.targetLanguage === session.targetLanguage;
    }
    if (key === 'rawTranslation') {
      const raw = session.artifacts.rawTranscript?.content;
      return Boolean(raw) && artifact.dependsOn?.key === 'rawTranscript'
        && artifact.dependsOn.fingerprint === fingerprint(raw)
        && artifact.targetLanguage === session.targetLanguage;
    }
    if (['notesTranslation', 'outlineTranslation'].includes(key)) {
      const sourceKey = key === 'notesTranslation' ? 'notes' : 'outline';
      const source = session.artifacts[sourceKey]?.content;
      return Boolean(source) && artifact.dependsOn?.key === sourceKey
        && artifact.dependsOn.fingerprint === fingerprint(source)
        && artifact.targetLanguage === session.targetLanguage;
    }
    if (['keyPoints', 'qa', 'structuredAnalysis', 'notes', 'outline'].includes(key)) {
      const cleaned = session.artifacts.cleanedTranscript;
      const sourceKey = cleaned?.content && !cleaned.stale ? 'cleanedTranscript' : 'rawTranscript';
      const source = session.artifacts[sourceKey]?.content;
      return Boolean(source) && artifact.dependsOn?.key === sourceKey
        && artifact.dependsOn.fingerprint === fingerprint(source);
    }
    return true;
  }

  markStale(artifact, reason) {
    if (!artifact) return artifact;
    return { ...artifact, stale: true, staleReason: reason, invalidatedAt: now() };
  }

  invalidateMaterialDependents(session) {
    const dependents = {
      cleanedTranscript: ['translation', 'cleanedTranslation', 'keyPoints', 'qa', 'structuredAnalysis', 'notes', 'outline'],
      notes: ['notesTranslation'],
      outline: ['outlineTranslation'],
    };
    const pending = ['cleanedTranscript', 'notes', 'outline'];
    const visited = new Set();
    for (const key of pending) {
      if (visited.has(key)) continue;
      visited.add(key);
      const artifact = session.artifacts[key];
      // A manual document remains authoritative. Its dependents still have the
      // same source bytes, so invalidation does not cross that manual edit.
      if (!artifact || artifact.source === 'manual-edit') continue;
      session.artifacts[key] = this.markStale(artifact, 'Course materials changed');
      pending.push(...(dependents[key] || []));
    }
  }

  invalidateRawDependents(session) {
    const previousRawTranslation = session.artifacts.rawTranslation;
    if (previousRawTranslation?.targetLanguage === session.targetLanguage) {
      const assembled = assembleRawUnits(session.artifacts.rawTranscript?.content || '', previousRawTranslation, {
        finalizeTail: !dictationIsActive(session.dictation),
        sourceSegments: session.paragraphization?.segments || [],
        targetLanguage: session.targetLanguage,
      });
      const needsTranslation = [...assembled.segments, assembled.pendingTranslation].filter(Boolean).some(rawUnitNeedsTranslation);
      session.artifacts.rawTranslation = {
        ...rawTranslationArtifact(session, {
          ...assembled,
          targetLanguage: session.targetLanguage,
          generationState: 'idle',
        }),
        stale: needsTranslation,
        staleReason: needsTranslation ? 'Raw transcript changed' : null,
        invalidatedAt: needsTranslation ? now() : null,
      };
    } else {
      session.artifacts.rawTranslation = this.markStale(previousRawTranslation, 'Raw transcript changed');
    }
    const keys = [
      'cleanedTranscript', 'cleanedTranslation', 'translation', 'keyPoints', 'qa',
      'structuredAnalysis', 'notes', 'notesTranslation', 'outline', 'outlineTranslation',
    ];
    for (const key of keys) {
      session.artifacts[key] = this.markStale(session.artifacts[key], 'Raw transcript changed');
    }
  }

  invalidateHighQualityDependents(session) {
    // Retained only for the explicit compatibility endpoint. Version C's RAG
    // pipeline never depends on this optional comparison artifact.
  }

  async processing(sessionId, value) {
    return this.mutate(sessionId, async () => {
      const session = await this.get(sessionId);
      session.processing = value;
      return this.save(session);
    });
  }
}

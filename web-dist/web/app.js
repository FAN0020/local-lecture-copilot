import {
  closeSessionContextMenu,
  confirmAndDeleteSession,
  deletionConfirmationCopy,
  openSessionContextMenu,
} from './session-deletion.js';
import { applyTranslations, getLocale, setLocale, t } from './i18n.js';
import { EditableDocument } from './editable-document.js';
import { escapeHtml, markdown as renderMarkdown } from './markdown.js';
import { blockSourceText, buildRawAlignmentUnits, groupRawDisplayBlocks } from './raw-display.js';
import { MicrophoneTimeoutError, requestMicrophone } from './microphone.js';
import { SilenceAutoStopMonitor } from './silence.js';
import { SpeechBoundarySegmenter } from './speech-segmenter.js';
import { bindSessionTitleInput, SessionTitleDraft } from './session-title.js';
import { TranscriptFollowController } from './transcript-follow.js';
import { apiFetch, audioSource, connectAudio } from './transport.js';
import { inferenceModeChanged, readInferenceMode, saveInferenceMode } from './inference-mode.js';
import { SessionPoller, sessionRefreshMarker } from './session-poller.js';
import { flushPcmWorklet } from './pcm-worklet-client.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const DEFAULT_STT_MODEL = 'base';
const DEFAULT_RAW_TRANSLATION_MODEL = 'qwen2.5:1.5b-instruct';
const ASR_MODEL_SELECTORS = Object.freeze({
  provisional: '#asr-model-provisional',
  revised: '#asr-model-revised',
  highQuality: '#asr-model-high-quality',
});

const state = {
  sessions: [],
  session: null,
  settings: { storagePath: '', storageKind: 'filesystem', canChooseDirectory: false, appLanguage: 'zh-CN', asrModels: null },
  health: { defaultSttModel: DEFAULT_STT_MODEL, sttModels: ['tiny', 'base', 'small', 'medium', 'large', 'turbo'], languages: ['auto', 'en', 'zh'], ollamaModels: [], sttReady: false, sttRuntime: { models: {} } },
  tab: 'raw',
  study: 'notes',
  dirty: false,
  preview: false,
  showingOriginal: false,
  bilingualView: localStorage.getItem('lecture-copilot-document-view') !== 'original',
  bilingualSaving: false,
  rawDisplayBlocks: [],
  dictationStatus: 'idle',
  recordingSessionId: null,
  dictationStream: null,
  audioContext: null,
  audioNode: null,
  audioSink: null,
  silenceMonitor: null,
  speechSegmenter: null,
  dictationSequence: 0,
  dictationQueue: Promise.resolve(),
  dictationBacklog: 0,
  dictationRetainedBytes: 0,
  dictationRetainedChunks: 0,
  dictationError: null,
  recordingStarted: 0,
  recordingTimer: null,
  busy: false,
  translationRenderMarker: '',
  modelPollTimer: null,
  runtimeDiagnosticsTimer: null,
  modelStateSnapshot: {},
  lastProcessingStatus: null,
};
const translationRequests = new Map();
const liveTranslationRequests = new Set();
const artifactRequests = new Map();
const activeObjectUrls = new Set();
const sessionTitle = new SessionTitleDraft();
let autosaveTimer = null;
let autosavePromise = null;

const INLINE_EDITABLE_ARTIFACTS = new Set(['rawTranscript', 'cleanedTranscript', 'notes', 'outline']);

const TAB_CONFIG = {
  raw: { key: 'rawTranscript', headingKey: 'document.rawTranscript', emptyTitleKey: 'empty.rawTitle', emptyKey: 'empty.rawDescription' },
  cleaned: { key: 'cleanedTranscript', stage: 'cleanup', headingKey: 'document.cleanedTranscript', emptyTitleKey: 'empty.cleanedTitle', emptyKey: 'empty.cleanedDescription' },
  notes: { key: 'notes', stage: 'notes', headingKey: 'document.courseAwareNotes', emptyTitleKey: 'empty.notesTitle', emptyKey: 'empty.notesDescription' },
  outline: { key: 'outline', stage: 'outline', headingKey: 'document.conceptOutline', emptyTitleKey: 'empty.outlineTitle', emptyKey: 'empty.outlineDescription' },
};

const STUDY_CONFIG = {
  notes: TAB_CONFIG.notes,
  structuredAnalysis: { key: 'structuredAnalysis', stage: 'analysis', headingKey: 'document.structuredAnalysis', emptyTitleKey: 'empty.analysisTitle', emptyKey: 'empty.analysisDescription' },
  keyPoints: { key: 'keyPoints', stage: 'key-points', headingKey: 'document.keyPoints', emptyTitleKey: 'empty.keyPointsTitle', emptyKey: 'empty.keyPointsDescription' },
  qa: { key: 'qa', stage: 'qa', headingKey: 'document.studyQa', emptyTitleKey: 'empty.qaTitle', emptyKey: 'empty.qaDescription' },
};

const STAGE_LABELS = {
  'raw-translation': 'stage.translation', 'cleaned-translation': 'stage.translation',
  'notes-translation': 'stage.translation', 'outline-translation': 'stage.translation',
  revision: 'stage.revision', 'high-quality': 'stage.highQuality', transcription: 'stage.transcription', cleanup: 'stage.cleanup', translation: 'stage.translation',
  'key-points': 'stage.keyPoints', qa: 'stage.qa', analysis: 'stage.analysis', notes: 'stage.notes', outline: 'stage.outline', dictation: 'stage.dictation',
};

const editableDocument = new EditableDocument($('#artifact-editor'), {
  onChange: (_value, details) => scheduleAutosave(details),
});
const rawTranscriptFollow = new TranscriptFollowController();
let rawTranscriptFollowVersion = '';
const sessionPoller = new SessionPoller({
  refresh: () => refreshSession({ preserveEditor: true, skipUnchanged: true }),
  shouldContinue: () => sessionHasActiveWork(),
  delay: () => document.hidden ? 10_000 : dictationInProgress() || serverDictationInProgress() ? 1000 : 2500,
});

function configHeading(config) { return t(config.headingKey); }
function configEmptyTitle(config) { return t(config.emptyTitleKey); }
function configEmpty(config) { return t(config.emptyKey); }

function serverDictationInProgress(session = state.session) {
  return ['recording', 'finalizing'].includes(session?.dictation?.status);
}

function rawTranscriptContainer(preferred = null) {
  const bilingual = $('#bilingual-view');
  const originalOnly = $('#document-editor-host');
  if (bilingual && !bilingual.classList.contains('hidden')) return bilingual;
  if (originalOnly && !originalOnly.classList.contains('hidden')) return originalOnly;
  return preferred;
}

function rawTranscriptVersion(artifact, content) {
  const source = state.showingOriginal
    ? String(content || '')
    : artifact?.contentFingerprint || String(content || '');
  return `${state.session?.id || ''}:${state.showingOriginal ? 'original' : 'current'}:${source}`;
}

function rawTranscriptLiveSourceActive() {
  return dictationInProgress()
    || serverDictationInProgress()
    || (state.session?.processing?.stage === 'dictation' && state.session.processing.status === 'running')
    || ['recording', 'background'].includes(state.session?.asr?.status);
}

function shouldFollowRawTranscriptLatest(artifact) {
  const source = String(artifact?.source || '');
  return rawTranscriptLiveSourceActive() || source.includes('dictation') || source === 'high-quality-asr';
}

function translationKeyForCurrent() {
  if (state.tab === 'raw') return 'rawTranslation';
  if (state.tab === 'cleaned') return 'cleanedTranslation';
  if (state.tab === 'notes' && state.study === 'notes') return 'notesTranslation';
  if (state.tab === 'outline') return 'outlineTranslation';
  return null;
}

function currentTranslation() {
  const key = translationKeyForCurrent();
  return key ? state.session?.artifacts?.[key] : null;
}

function translationStageForKey(key) {
  return ({ rawTranslation: 'raw-translation', cleanedTranslation: 'cleaned-translation', notesTranslation: 'notes-translation', outlineTranslation: 'outline-translation' })[key] || null;
}

function currentTranslationFailed() {
  const stage = translationStageForKey(translationKeyForCurrent());
  return Boolean(stage && state.session?.processing?.stage === stage && state.session.processing.status === 'error');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function relativeDate(value) {
  const date = new Date(value);
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return date.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return t('dates.yesterday');
  if (days < 7) return date.toLocaleDateString(getLocale(), { weekday: 'short' });
  return date.toLocaleDateString(getLocale(), { month: 'short', day: 'numeric' });
}

function contentMeasure(content) {
  const text = String(content || '').trim();
  const tokens = text.split(/\s+/).filter(Boolean);
  const cjkCharacters = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length || 0;
  if (cjkCharacters >= Math.max(4, tokens.length * 2)) return t('units.characters', { count: cjkCharacters.toLocaleString(getLocale()) });
  return t(tokens.length === 1 ? 'units.word' : 'units.words', { count: tokens.length.toLocaleString(getLocale()) });
}

function markdown(content) {
  return renderMarkdown(content, t('document.noContent'));
}

function markTranslationRendered(translation) {
  if (localStorage.getItem('lecture-copilot-translation-debug') !== '1' || !translation) return;
  const marker = translation.updatedAt || translation.generatedAt || translation.contentFingerprint || '';
  if (!marker || marker === state.translationRenderMarker) return;
  state.translationRenderMarker = marker;
  performance.clearMarks('lecture-copilot-translation-rendered');
  performance.mark('lecture-copilot-translation-rendered', {
    detail: { sessionId: state.session?.id, updatedAt: marker },
  });
}

async function api(path, options = {}) {
  const response = await apiFetch(path, options);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body.error || body || `Request failed (${response.status})`);
  return body;
}

function toast(message, type = 'info') {
  const element = document.createElement('div');
  element.className = `toast ${type === 'error' ? 'error' : ''}`;
  element.textContent = message;
  $('#toast-region').append(element);
  setTimeout(() => element.remove(), type === 'error' ? 6500 : 3200);
}

function icon(name) {
  return `<svg><use href="#i-${name}"/></svg>`;
}

function closeMenus() {
  for (const [menuId, buttonId] of [['#session-menu', '#session-menu-button'], ['#document-menu', '#document-menu-button']]) {
    $(menuId).classList.add('hidden');
    $(buttonId).setAttribute('aria-expanded', 'false');
  }
  closeSessionContextMenu($('#session-context-menu'));
  $$('.session-item.context-target').forEach((item) => item.classList.remove('context-target'));
}

function dictationInProgress() {
  return ['starting', 'recording', 'finalizing'].includes(state.dictationStatus);
}

function toggleMenu(menuId, buttonId) {
  const menu = $(menuId);
  const opening = menu.classList.contains('hidden');
  closeMenus();
  menu.classList.toggle('hidden', !opening);
  $(buttonId).setAttribute('aria-expanded', String(opening));
}

async function loadHealth() {
  try {
    state.health = await api('/api/health');
  } catch (error) {
    toast(t('status.providerCheckFailed', { message: error.message }), 'error');
  }
  populateOptions();
  state.modelStateSnapshot = Object.fromEntries(Object.entries(state.health.sttRuntime?.modelStates || {}).map(([id, model]) => [id, model.state]));
  renderProviderStatus();
  if (hasActiveModelInstall()) startModelPolling();
}

function renderProviderStatus() {
  const ready = state.health.ollamaReady && state.health.sttReady;
  $('#provider-dot').className = `status-dot ${ready ? 'ready' : 'warning'}`;
  const stt = state.health.sttRuntime || {};
  const installedModels = stt.installedModels?.join(', ') || t('status.localModel');
  const whisperCopy = state.health.sttReady
    ? t((stt.installedModels?.length || 1) === 1 ? 'status.managedWhisperReady' : 'status.managedWhisperReadyPlural', { models: installedModels })
    : escapeHtml(stt.message || t('status.managedWhisperUnavailable'));
  const ollamaCopy = state.health.ollamaReady
    ? t(state.health.ollamaModels.length === 1 ? 'status.ollamaReady' : 'status.ollamaReadyPlural', { count: state.health.ollamaModels.length })
    : t('status.startOllama');
  $('#provider-status').innerHTML = `<span class="status-dot ${state.health.sttReady ? 'ready' : 'warning'}"></span><span>${whisperCopy}<br>${ollamaCopy}</span>`;
}

function renderInferenceModeSettings() {
  const settings = readInferenceMode();
  $('#inference-mode').value = settings.mode;
  $('#cloud-controller-url').value = settings.controllerUrl;
  $('#cloud-access-code').value = settings.accessCode;
  $('#cloud-mode-fields').classList.toggle('hidden', settings.mode !== 'cloud');
}

async function loadSettings() {
  try {
    state.settings = await api('/api/settings');
    applyAppLanguage(state.settings.appLanguage);
    const field = $('#storage-path');
    if (field && !field.matches(':focus')) field.value = state.settings.storagePath || '';
    $('#app-language').value = state.settings.appLanguage || 'zh-CN';
    $('#choose-storage').classList.toggle('hidden', !state.settings.canChooseDirectory);
    renderAsrModelSelectors({ preserveSelection: false });
    renderWhisperModelList();
  } catch (error) {
    toast(t('status.storageUnavailable', { message: error.message }), 'error');
  }
}

function applyAppLanguage(locale, { rerender = true } = {}) {
  state.settings.appLanguage = setLocale(locale);
  applyTranslations(document);
  $('#app-language').value = state.settings.appLanguage;
  populateOptions();
  renderProviderStatus();
  if (rerender) render({ preserveEditor: true });
}

function populateOptions({ modelsOnly = false } = {}) {
  if (!modelsOnly) $('#language-select').innerHTML = state.health.languages.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(t(`language.${item}`))}</option>`).join('');
  const modelSelect = $('#stt-model-select');
  const selectedModel = modelSelect.value || state.session?.sttModel || state.health.defaultSttModel || DEFAULT_STT_MODEL;
  const registry = state.health.sttRuntime?.registry?.length
    ? state.health.sttRuntime.registry
    : state.health.sttModels.map((id) => ({ id, label: id, bytes: 0 }));
  modelSelect.innerHTML = registry.map((model) => {
    const details = sttModelDetails(model.id);
    const suffix = details.state === 'ready' ? ''
      : details.state === 'downloading' ? ` — ${Math.round(details.progress || 0)}%`
        : details.state === 'verifying' ? ` — ${t('actions.verifying')}`
          : details.state === 'failed' ? ` — ${t('actions.retry')}` : ` — ${t('actions.install')}`;
    return `<option value="${escapeHtml(model.id)}" ${details.state === 'ready' ? '' : 'disabled'}>${escapeHtml(model.label || model.id)}${escapeHtml(suffix)}</option>`;
  }).join('');
  if (registry.some((model) => model.id === selectedModel)) modelSelect.value = selectedModel;
  if (!modelsOnly) renderLlmModelSelectors();
  renderSelectedModelStatus();
  renderAsrModelSelectors();
  renderWhisperModelList();
}

function renderLlmModelSelectors({ preserveSelection = true } = {}) {
  const installed = new Set(state.health.ollamaModels || []);
  for (const [selector, field, fallback] of [
    ['#llm-model-select', 'llmModel', 'qwen3.5:4b'],
    ['#live-translation-model-select', 'liveTranslationModel', DEFAULT_RAW_TRANSLATION_MODEL],
  ]) {
    const select = $(selector);
    const selected = (preserveSelection ? select.value : '') || state.session?.[field] || fallback;
    const choices = [...new Set([selected, ...(field === 'liveTranslationModel' ? [DEFAULT_RAW_TRANSLATION_MODEL] : []), ...installed])];
    const options = choices.map((model) => {
      const status = !installed.has(model) ? t('status.notInstalled')
        : field === 'liveTranslationModel' && model === DEFAULT_RAW_TRANSLATION_MODEL ? t('settings.lightweightRecommended') : '';
      return `<option value="${escapeHtml(model)}">${escapeHtml(model)}${status ? ` — ${escapeHtml(status)}` : ''}</option>`;
    }).join('');
    if (select.innerHTML !== options) select.innerHTML = options;
    select.value = selected;
    select.disabled = !state.session;
  }
  renderRawTranslationModelStatus();
}

function renderRawTranslationModelStatus() {
  const select = $('#live-translation-model-select');
  const model = select.value || state.session?.liveTranslationModel || DEFAULT_RAW_TRANSLATION_MODEL;
  const missing = !(state.health.ollamaModels || []).includes(model);
  select.setAttribute('aria-invalid', String(missing));
  $('#live-translation-model-status').textContent = missing
    ? t('settings.rawTranslationModelMissing', { model }) : t('settings.rawTranslationModelReady', { model });
}

function configuredAsrModels() {
  return state.settings.asrModels || state.health.asrPipeline?.models || {};
}

function selectedAsrModels() {
  return Object.fromEntries(Object.entries(ASR_MODEL_SELECTORS).map(([stage, selector]) => [
    stage,
    $(selector)?.value || configuredAsrModels()[stage] || '',
  ]));
}

function renderAsrModelSelectors({ preserveSelection = true } = {}) {
  const registry = state.health.sttRuntime?.registry?.length
    ? state.health.sttRuntime.registry
    : (state.health.sttModels || []).map((id) => ({ id, label: id }));
  const configured = configuredAsrModels();
  for (const [stage, selector] of Object.entries(ASR_MODEL_SELECTORS)) {
    const select = $(selector);
    if (!select) continue;
    const previous = preserveSelection ? select.value : '';
    select.innerHTML = registry.map((metadata) => {
      const model = sttModelDetails(metadata.id);
      const suffix = model.state === 'ready' ? '' : ` — ${t('status.notInstalled')}`;
      return `<option value="${escapeHtml(model.id)}" ${model.state === 'ready' ? '' : 'disabled'}>${escapeHtml(model.label || model.id)}${escapeHtml(suffix)}</option>`;
    }).join('');
    const preferred = [previous, configured[stage], state.health.asrPipeline?.models?.[stage]]
      .find((modelId) => modelId && sttModelDetails(modelId).state === 'ready');
    const fallback = registry.find((metadata) => sttModelDetails(metadata.id).state === 'ready')?.id;
    if (preferred || fallback) select.value = preferred || fallback;
    select.disabled = state.busy || ['recording', 'finalizing'].includes(state.dictationStatus);
  }
}

function sttModelDetails(modelId) {
  const stateValue = state.health.sttRuntime?.modelStates?.[modelId];
  if (stateValue) return stateValue;
  const metadata = state.health.sttRuntime?.registry?.find((model) => model.id === modelId) || { id: modelId, label: modelId, bytes: 0 };
  const installed = state.health.sttRuntime?.models?.[modelId] ?? true;
  return { ...metadata, state: installed ? 'ready' : 'missing', installed, canInstall: !installed, progress: installed ? 100 : 0 };
}

function modelStateCopy(model) {
  if (model.state === 'ready') return t(model.source === 'bundled' ? 'status.whisperReadyBundled' : 'status.whisperReadyInstalled', { bytes: formatBytes(model.bytes) });
  if (model.state === 'downloading') return t('status.whisperDownloading', { progress: Math.round(model.progress || 0), downloaded: formatBytes(model.downloadedBytes), total: formatBytes(model.totalBytes || model.bytes) });
  if (model.state === 'verifying') return t('status.whisperVerifying');
  if (model.state === 'failed') return model.error ? t('status.whisperInstallFailed', { error: model.error }) : t('status.whisperInstallFailedShort');
  return t('status.whisperNotInstalled', { bytes: formatBytes(model.bytes) });
}

function renderSelectedModelStatus() {
  const model = sttModelDetails($('#stt-model-select').value || state.health.defaultSttModel || DEFAULT_STT_MODEL);
  const button = $('#install-stt-model');
  const active = ['downloading', 'verifying'].includes(model.state);
  button.classList.toggle('hidden', model.state === 'ready');
  button.disabled = active || state.busy || ['recording', 'finalizing'].includes(state.dictationStatus);
  button.textContent = model.state === 'failed' ? t('actions.retry') : model.state === 'verifying' ? t('actions.verifying') : model.state === 'downloading' ? `${Math.round(model.progress || 0)}%` : t('actions.install');
  const copy = $('#stt-model-status');
  const pipelineModels = state.health.asrPipeline?.models;
  const pipelineCopy = state.health.asrPipeline?.enabled && pipelineModels
    ? t('status.asrPipelineModels', { provisional: pipelineModels.provisional, revised: pipelineModels.revised, highQuality: pipelineModels.highQuality }) : '';
  copy.textContent = [modelStateCopy(model), pipelineCopy].filter(Boolean).join(' · ');
  copy.classList.toggle('error', model.state === 'failed');
}

function renderWhisperModelList() {
  const list = $('#whisper-model-list');
  if (!list) return;
  const registry = state.health.sttRuntime?.registry || [];
  const stageModels = selectedAsrModels();
  list.innerHTML = registry.map((metadata) => {
    const model = sttModelDetails(metadata.id);
    const active = ['downloading', 'verifying'].includes(model.state);
    const selectedStages = Object.entries(stageModels).filter(([, modelId]) => modelId === model.id).map(([stage]) => stage);
    const badges = selectedStages.length ? `<span class="whisper-model-badges">${selectedStages.map((stage) => `<span class="whisper-model-badge">${escapeHtml(t(`settings.stageBadge.${stage}`))}</span>`).join('')}</span>` : '';
    const action = model.state === 'ready' ? '' : `<button type="button" data-install-model="${escapeHtml(model.id)}" ${active ? 'disabled' : ''}>${model.state === 'failed' ? t('actions.retry') : active ? model.state === 'verifying' ? t('actions.verifying') : `${Math.round(model.progress || 0)}%` : t('actions.install')}</button>`;
    const progress = active ? `<progress class="model-progress" max="100" value="${model.state === 'verifying' ? 100 : Number(model.progress || 0)}"></progress>` : '';
    return `<div class="whisper-model-row ${selectedStages.length ? 'selected' : ''}">
      <div class="whisper-model-copy"><strong>${escapeHtml(model.label || model.id)}</strong><span>${escapeHtml(modelDescription(model))} · ${formatBytes(model.bytes)}</span></div>
      <div class="whisper-model-actions">${badges}<span class="whisper-model-state ${escapeHtml(model.state)}">${escapeHtml(model.state === 'ready' ? model.source === 'bundled' ? t('status.whisperBundled') : t('status.whisperReady') : model.state === 'downloading' ? t('status.downloading') : model.state === 'verifying' ? t('actions.verifying') : model.state === 'failed' ? t('status.failed') : t('status.notInstalled'))}</span>${action}</div>
      ${progress}
    </div>`;
  }).join('');
  $('#whisper-model-location').textContent = state.health.sttRuntime?.installRoot ? t('settings.downloadedModels', { path: state.health.sttRuntime.installRoot }) : '';
}

function modelDescription(model) {
  const key = `whisper.description.${model.id}`;
  const translated = t(key);
  return translated === key ? model.description || '' : translated;
}

function hasActiveModelInstall() {
  return Object.values(state.health.sttRuntime?.modelStates || {}).some((model) => ['downloading', 'verifying'].includes(model.state));
}

async function refreshSttModels() {
  const runtime = await api('/api/stt/models');
  state.health.sttRuntime = runtime;
  state.health.sttReady = runtime.ready;
  if (runtime.registry?.length) state.health.sttModels = runtime.registry.map((model) => model.id);
  populateOptions({ modelsOnly: true });
  renderProviderStatus();

  for (const [id, model] of Object.entries(runtime.modelStates || {})) {
    const previous = state.modelStateSnapshot[id];
    if (['downloading', 'verifying'].includes(previous) && model.state === 'ready') toast(t('status.whisperDownloadReady', { model: model.label || id }));
    if (['downloading', 'verifying'].includes(previous) && model.state === 'failed') toast(t('status.whisperDownloadFailed', { model: model.label || id, error: model.error || t('status.downloadError') }), 'error');
  }

  state.modelStateSnapshot = Object.fromEntries(Object.entries(runtime.modelStates || {}).map(([id, model]) => [id, model.state]));
  if (state.session) renderDocument(true);
  return runtime;
}

function startModelPolling() {
  clearTimeout(state.modelPollTimer);
  const poll = async () => {
    try {
      await refreshSttModels();
    } catch (error) {
      console.error('Could not refresh Whisper model installation:', error);
    }
    if (hasActiveModelInstall()) state.modelPollTimer = setTimeout(poll, document.hidden ? 10_000 : 1500);
    else state.modelPollTimer = null;
  };
  state.modelPollTimer = setTimeout(poll, 250);
}

async function installSttModel(modelId) {
  const model = sttModelDetails(modelId);
  if (model.state === 'ready') return;
  try {
    const result = await api(`/api/stt/models/${encodeURIComponent(modelId)}/install`, { method: 'POST' });
    if (result.model) {
      state.health.sttRuntime.modelStates ||= {};
      state.health.sttRuntime.modelStates[modelId] = result.model;
      state.modelStateSnapshot[modelId] = result.model.state;
    }
    populateOptions({ modelsOnly: true });
    toast(t('status.installingWhisper', { model: model.label || modelId }));
    startModelPolling();
  } catch (error) {
    toast(error.message, 'error');
    await refreshSttModels().catch(() => {});
  }
}

async function loadSessions(selectStored = false) {
  state.sessions = await api('/api/sessions');
  renderSessions();
  if (selectStored && !state.session) {
    const stored = localStorage.getItem('lecture-copilot-session');
    const target = state.sessions.find((item) => item.id === stored) || state.sessions[0];
    if (target) await selectSession(target.id, true);
  }
}

function renderSessions() {
  const dictating = dictationInProgress();
  $('#session-count').textContent = state.sessions.length;
  $('#session-list').innerHTML = state.sessions.length ? state.sessions.map((session) => `
    <button class="session-item ${state.session?.id === session.id ? 'active' : ''}" data-session-id="${session.id}" aria-haspopup="menu" ${dictating && state.session?.id !== session.id ? 'disabled' : ''}>
      <strong>${escapeHtml(sessionTitle.titleFor(session))}</strong>
      <span>${relativeDate(session.updatedAt)}<i></i>${session.hasTranscript ? t('state.transcribed') : session.audio ? t('state.audioReady') : t('state.new')}</span>
    </button>`).join('') : `<div class="document-placeholder"><p>${escapeHtml(t('state.noLectures'))}</p></div>`;
  $('#new-session').disabled = dictating;
}

async function createSession() {
  if (dictationInProgress()) {
    toast(t('status.finishDictationCreate'));
    return;
  }
  if (!await settleEditor()) return;
  const date = new Date();
  const localDate = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  const session = await api('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      automaticTitle: {
        date: localDate,
        label: date.toLocaleDateString(getLocale(), { month: 'short', day: 'numeric' }),
      },
    }),
  });
  state.sessions.unshift(session);
  await selectSession(session.id, true);
  $('#session-title').focus();
  $('#session-title').select();
  toast(t('status.lectureCreated'));
  return session;
}

async function createAndStart(action) {
  const session = await createSession();
  if (!session) return;
  if (action === 'record') return toggleRecording();
  if (action === 'upload') $('#audio-input').click();
}

async function settleEditor() {
  if (!state.dirty) return true;
  await flushAutosave();
  return !state.dirty;
}

async function selectSession(id, force = false) {
  if (id !== state.session?.id && dictationInProgress()) {
    toast(t('status.finishDictationSwitch'));
    return;
  }
  if (!force && !await settleEditor()) return;
  stopPolling();
  state.session = await api(`/api/sessions/${encodeURIComponent(id)}`);
  state.dirty = false;
  state.preview = false;
  state.showingOriginal = false;
  state.rawDisplayBlocks = [];
  rawTranscriptFollow.reset();
  rawTranscriptFollowVersion = '';
  state.lastProcessingStatus = null;
  state.translationRenderMarker = '';
  if (!['starting', 'recording', 'finalizing'].includes(state.dictationStatus)) {
    state.dictationStatus = ['recording', 'finalizing', 'error'].includes(state.session.dictation?.status) ? 'error' : 'idle';
  }
  localStorage.setItem('lecture-copilot-session', id);
  render();
  await loadSessions();
  if (sessionHasActiveWork()) startPolling();
  if (state.session.artifacts.rawTranscript?.content) {
    void setLiveTranslation(true)
      .then(() => ensureCurrentTranslation())
      .catch(() => ensureCurrentTranslation());
  }
  if (window.innerWidth <= 820) $('#app').classList.remove('sidebar-open');
}

function rawTranslationNeedsRefresh(session = state.session) {
  const source = session?.artifacts?.rawTranscript;
  const translation = session?.artifacts?.rawTranslation;
  if (!source?.content || translation?.generationState === 'error') return false;
  if (!translation || translation.stale || translation.targetLanguage !== session.targetLanguage
    || translation.sourceFingerprint !== source.contentFingerprint) return true;
  const units = [...(translation.segments || []), translation.pendingTranslation].filter(Boolean);
  return units.some((unit) => !unit.translatedText && unit.status !== 'error');
}

async function refreshSession({ preserveEditor = false, skipUnchanged = false } = {}) {
  if (!state.session) return;
  const sessionId = state.session.id;
  const refreshed = await api(`/api/sessions/${encodeURIComponent(sessionId)}`);
  if (state.session?.id !== sessionId) return;
  const unchanged = skipUnchanged && sessionRefreshMarker(state.session) === sessionRefreshMarker(refreshed);
  state.session = refreshed;
  if (!unchanged) render({ preserveEditor });
  if (state.tab === 'raw' && rawTranslationNeedsRefresh(refreshed)) void ensureCurrentTranslation();
}

function currentConfig() {
  if (state.tab === 'notes') return STUDY_CONFIG[state.study];
  return TAB_CONFIG[state.tab];
}

function currentArtifact() {
  if (!state.session) return null;
  return state.session.artifacts[currentConfig().key];
}

function render({ preserveEditor = false } = {}) {
  const hasSession = Boolean(state.session);
  $('#app').classList.toggle('session-empty', !hasSession);
  $('#empty-state').classList.toggle('hidden', hasSession);
  $('#workspace').classList.toggle('hidden', !hasSession);
  $('#session-title').disabled = !hasSession;
  $('#session-menu-button').disabled = !hasSession;
  $$('[data-action="toggle-context"]').forEach((button) => { button.disabled = !hasSession; });
  if (!hasSession) {
    sessionTitle.clear();
    closeMenus();
    $('#session-title').value = t('state.noSession');
    $('#save-indicator').textContent = t('state.selectOrCreate');
    renderSessions();
    return;
  }
  sessionTitle.sync(state.session);
  state.session.title = sessionTitle.canonicalTitle;
  renderSessionTitle();
  $('#save-indicator').textContent = state.dirty ? t('state.unsavedChanges') : t('state.savedLocally', { date: relativeDate(state.session.updatedAt) });
  $('#language-select').value = state.session.language;
  const requestedSttModel = state.session.sttModel;
  const selectedSttModel = state.health.sttRuntime?.models?.[requestedSttModel] === false
    ? state.health.sttRuntime.installedModels?.[0] || state.session.sttModel
    : requestedSttModel;
  $('#stt-model-select').value = selectedSttModel;
  renderLlmModelSelectors({ preserveSelection: $('#settings-dialog').open });
  $('#target-language').value = state.session.targetLanguage;
  $$('[data-tab]').forEach((button) => {
    const selected = button.dataset.tab === state.tab;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  $('#study-select').value = state.study;
  $('#study-nav').classList.toggle('hidden', state.tab !== 'notes');
  $('#document-heading').classList.toggle('hidden', state.tab === 'notes');
  for (const [tab, config] of Object.entries(TAB_CONFIG)) {
    const marker = $(`#${tab}-state`);
    const stage = state.session.processing?.stage;
    const status = state.session.processing?.status;
    const tabConfigs = tab === 'notes' ? Object.values(STUDY_CONFIG) : [config];
    const matches = tabConfigs.some((item) => stage === item.stage)
      || (tab === 'raw' && ['transcription', 'revision'].includes(stage))
      || (tab === 'cleaned' && stage === 'high-quality');
    const requestRunning = tabConfigs.some((item) => artifactRequests.has(`${state.session.id}:${item.key}`));
    const running = requestRunning || (status === 'running' && matches);
    const error = status === 'error' && matches;
    marker?.classList.toggle('running', running);
    marker?.classList.toggle('error', error);
    if (marker) {
      marker.textContent = error ? '!' : '';
      marker.setAttribute('aria-label', error ? t('document.failed', { input: configHeading(config) }) : running ? t('document.processing', { input: configHeading(config) }) : '');
      if (running || error) marker.setAttribute('role', 'img');
      else marker.removeAttribute('role');
    }
  }
  renderAudio();
  renderDocument(preserveEditor);
  renderMaterials();
  renderPipeline();
  renderProcessing();
  renderMetadata();
  renderSessions();
  renderSelectedModelStatus();
}

function renderAudio() {
  const container = $('#audio-summary');
  const recordings = (state.session.recordingSegments || []).filter((segment) => segment.audio);
  const primaryIsRecording = state.session.audio && recordings.some((segment) => segment.audio.id === state.session.audio.id);
  const items = [
    ...(!state.session.audio || primaryIsRecording ? [] : [{ audio: state.session.audio, url: `/api/sessions/${encodeURIComponent(state.session.id)}/audio/content` }]),
    ...recordings.map((segment) => ({
      audio: segment.audio,
      url: `/api/sessions/${encodeURIComponent(state.session.id)}/recordings/${encodeURIComponent(segment.id)}/audio/content`,
    })),
  ];
  container.classList.toggle('hidden', items.length === 0);
  const signature = JSON.stringify(items.map(({ audio, url }) => [url, audio.id, audio.bytes, audio.filename]));
  if (container.dataset.audioSignature === signature) return;
  container.dataset.audioSignature = signature;
  container.innerHTML = items.map(({ audio, url }) => `<div class="audio-item">${icon('audio')}<div><strong>${escapeHtml(audio.filename)}</strong><br>${formatBytes(audio.bytes)} · ${escapeHtml(audio.mimeType || 'audio')}</div><audio controls preload="metadata" data-audio-path="${url}" ${audioSource(url) ? `src="${audioSource(url)}"` : ''}></audio></div>`).join('');
  connectAudio(container);
}

function inputSummary(config, artifact) {
  const transcript = state.session.artifacts.cleanedTranscript?.content ? t('input.cleaned') : t('input.raw');
  if (config.key === 'rawTranscript') return artifact?.source === 'manual-edit' ? t('document.editedFromOriginal') : t('document.localWhisper', { model: artifact?.model || state.session.sttModel || 'Whisper' });
  if (config.key === 'cleanedTranscript') {
    const highQualitySource = artifact?.sourceArtifact === 'highQualityTranscript'
      || state.session.artifacts.highQualityTranscript?.generationState === 'complete';
    return t(highQualitySource ? 'document.fromHighQualityAsr' : 'document.fromRaw');
  }
  if (config.key === 'translation') return t('document.translationInput', { transcript, target: artifact?.targetLanguage || state.session.targetLanguage });
  if (['notes', 'outline'].includes(config.key)) {
    const used = artifact?.materialIds?.length ?? state.session.materials.filter((material) => !material.extractionError).length;
    return used ? t(used === 1 ? 'document.materialsInput' : 'document.materialsInputPlural', { transcript, count: used }) : t('document.transcriptOnly', { transcript });
  }
  return t('document.fromTranscript', { transcript });
}

function stageMatches(config) {
  if (artifactRequests.has(`${state.session.id}:${config.key}`)) {
    return { stage: config.stage, status: 'running', message: t('status.processingStage', { stage: configHeading(config) }) };
  }
  const processing = state.session.processing;
  if (config.key === 'cleanedTranscript' && processing?.stage === 'high-quality') return processing;
  const stage = config.key === 'rawTranscript'
    ? (processing?.stage === 'revision' ? 'revision' : 'transcription') : config.stage;
  return Boolean(stage && processing?.stage === stage) ? processing : null;
}

function rawEditorBlocks(content, displayBlocks = null) {
  if (displayBlocks?.length) {
    const canonical = String(content || '');
    let cursor = 0;
    const aligned = displayBlocks.map((block, index) => {
      const sources = [...(block.segments || []).map((segment) => segment.sourceText), block.pendingText].filter(Boolean);
      let start = -1;
      let end = cursor;
      for (const source of sources) {
        const found = canonical.indexOf(source, end);
        if (found < 0) continue;
        if (start < 0) start = found;
        end = found + source.length;
      }
      if (start < 0) return {
        id: block.id,
        text: `${blockSourceText(block)}${block.pendingText ? `${blockSourceText(block) ? ' ' : ''}${block.pendingText}` : ''}`,
        joinBefore: index ? ' ' : '',
      };
      const between = canonical.slice(cursor, start);
      const result = {
        id: block.id,
        text: canonical.slice(start, end),
        joinBefore: index ? (between.includes('\n\n') ? '\n\n' : between || ' ') : between,
      };
      cursor = end;
      return result;
    });
    if (cursor < canonical.length && aligned.length) aligned.at(-1).text += canonical.slice(cursor);
    return aligned;
  }
  const structure = state.session.paragraphization;
  if (!structure?.paragraphs?.length || state.showingOriginal) return String(content || '').split(/\n{2,}/).map((text, index) => ({
    id: `raw_paragraph_${index}`,
    text,
    joinBefore: index ? '\n\n' : '',
  }));
  const byId = new Map((structure.segments || []).map((segment) => [segment.id, segment.text]));
  return structure.paragraphs.map((paragraph, index) => ({
    id: paragraph.id,
    text: paragraph.segmentIds.map((id) => byId.get(id) || '').filter(Boolean).join(' '),
    joinBefore: index ? '\n\n' : '',
    segmentCount: paragraph.segmentIds.length,
    canMerge: index > 0,
  }));
}

function rawBlockDecoration(block) {
  if (state.showingOriginal || (!block.segmentCount && !block.canMerge)) return null;
  const actions = document.createElement('span');
  actions.className = 'paragraph-actions';
  if (block.segmentCount > 1) {
    const split = document.createElement('button');
    split.type = 'button';
    split.dataset.paragraphSplit = block.id;
    split.textContent = t('actions.splitParagraph');
    actions.append(split);
  }
  if (block.canMerge) {
    const merge = document.createElement('button');
    merge.type = 'button';
    merge.dataset.paragraphMerge = block.id;
    merge.textContent = t('actions.mergePrevious');
    actions.append(merge);
  }
  return actions.childElementCount ? actions : null;
}

function mountCurrentEditor(host, content, {
  blocks = null,
  bilingual = false,
  decorateBlock = null,
  renderKeySuffix = '',
  sourceLabel = '',
} = {}) {
  const config = currentConfig();
  const format = ['notes', 'outline'].includes(config.key) ? 'markdown' : 'plain';
  const rawBlocks = config.key === 'rawTranscript' ? rawEditorBlocks(content, blocks) : undefined;
  editableDocument.mount(host, {
    identity: `${state.session.id}:${config.key}:${state.showingOriginal ? 'original' : 'current'}`,
    value: content,
    format,
    readOnly: state.showingOriginal,
    renderKey: config.key === 'rawTranscript'
      ? `${bilingual ? 'bilingual' : 'single'}:${rawBlocks.map((block) => block.id).join(',')}:${renderKeySuffix}`
      : format,
    blocks: rawBlocks,
    pairedBlocks: config.key === 'rawTranscript' && bilingual && Boolean(decorateBlock),
    sourceLabel,
    decorateBlock: config.key === 'rawTranscript' ? (decorateBlock || (!bilingual ? rawBlockDecoration : undefined)) : undefined,
  });
}

function renderDocument(preserveEditor = false) {
  const config = currentConfig();
  const artifact = currentArtifact();
  const processing = stageMatches(config);
  const hasRaw = Boolean(state.session.artifacts.rawTranscript?.content);
  const dictating = dictationInProgress();
  const isProcessing = aiWorkInProgress();
  const dictationBlocked = isProcessing;
  const selectedModelReady = sttModelDetails($('#stt-model-select').value || state.session.sttModel).state === 'ready';
  const content = state.showingOriginal ? artifact?.originalContent : artifact?.content;
  const hasDocument = Boolean(artifact) && content !== undefined && content !== null;
  const hasContent = Boolean(content);
  const inlineEditable = INLINE_EDITABLE_ARTIFACTS.has(config.key);
  const bilingual = state.bilingualView && inlineEditable && Boolean(translationKeyForCurrent()) && hasContent && !state.showingOriginal;
  const rawTranscript = config.key === 'rawTranscript';
  const rawFollowSnapshot = rawTranscript ? rawTranscriptFollow.capture(rawTranscriptContainer()) : null;
  const rawFollowVersion = rawTranscript ? rawTranscriptVersion(artifact, content) : '';
  const rawFollowLatest = rawTranscript
    && rawFollowVersion !== rawTranscriptFollowVersion
    && shouldFollowRawTranscriptLatest(artifact);
  const heading = configHeading(config);
  $('#document-heading').textContent = state.showingOriginal ? t('document.originalHeading', { heading }) : heading;
  const revisionCount = artifact?.revisions?.length || 0;
  $('#document-meta').textContent = hasContent
    ? `${artifact?.stale ? t('document.outOfDate') : ''}${contentMeasure(content)} · ${inputSummary(config, artifact)}${revisionCount ? ` · ${t(revisionCount === 1 ? 'units.revision' : 'units.revisions', { count: revisionCount })}` : ''}`
    : processing?.status === 'running' ? t('document.processing', { input: inputSummary(config, artifact) })
      : processing?.status === 'error' ? t('document.failed', { input: inputSummary(config, artifact) })
        : t('document.notGenerated', { input: inputSummary(config, artifact) });
  $('#document-placeholder').classList.toggle('hidden', hasDocument);
  $('#document-placeholder').classList.toggle('processing', !hasDocument && processing?.status === 'running');
  $('#document-placeholder').classList.toggle('error', !hasDocument && processing?.status === 'error');
  $('#document-placeholder h2').textContent = processing?.status === 'running' ? t('document.creating', { heading })
    : processing?.status === 'error' ? t('document.failed', { input: heading })
      : configEmptyTitle(config);
  const processingMessage = processing?.status === 'running' ? t('status.processingStage', { stage: heading }) : processing?.message;
  $('#document-placeholder p').textContent = processing?.status === 'running' ? t('document.processingSavedSeparately', { message: processingMessage })
    : processing?.status === 'error' ? t('document.failedRetry', { message: processing.message })
      : configEmpty(config);
  const editorHost = $('#document-editor-host');
  editorHost.classList.toggle('hidden', !hasDocument || !inlineEditable || bilingual);
  if (hasDocument && inlineEditable && !bilingual) mountCurrentEditor(editorHost, content);
  const showPreview = hasDocument && !inlineEditable;
  $('#artifact-preview').classList.toggle('hidden', !showPreview || bilingual);
  const bilingualView = $('#bilingual-view');
  bilingualView.classList.toggle('hidden', !bilingual);
  if (bilingual) renderBilingualView(bilingualView, content);
  if (rawTranscript && hasDocument && inlineEditable) {
    rawTranscriptFollow.restore(rawTranscriptContainer(bilingual ? bilingualView : editorHost), rawFollowSnapshot, { followLatest: rawFollowLatest });
    rawTranscriptFollowVersion = rawFollowVersion;
  }
  if (showPreview) $('#artifact-preview').innerHTML = markdown(content);
  $('#preview-button').classList.add('hidden');
  const hasOriginal = currentConfig().key === 'rawTranscript' && artifact?.originalContent && artifact.originalContent !== artifact.content;
  $('#original-button').classList.toggle('hidden', !hasOriginal);
  $('#original-button').textContent = state.showingOriginal ? t('actions.backToCurrent') : t('actions.viewOriginal');
  const bilingualToggle = $('#bilingual-toggle');
  const supportsBilingual = inlineEditable && Boolean(translationKeyForCurrent()) && hasContent;
  bilingualToggle.classList.toggle('hidden', !supportsBilingual);
  bilingualToggle.setAttribute('aria-pressed', String(bilingual));
  bilingualToggle.disabled = state.bilingualSaving;
  bilingualToggle.textContent = bilingual ? t('actions.originalOnly') : t('actions.bilingual');
  $('[data-action="copy"]').classList.toggle('hidden', !hasContent);
  $('#export-button').classList.toggle('hidden', !hasContent);
  $('#document-menu-button').classList.toggle('hidden', !hasContent);
  $('#transcribe-button').disabled = isProcessing || dictating || serverDictationInProgress() || !state.session.audio || !selectedModelReady;
  $('#transcribe-button').classList.toggle('hidden', !state.session.audio);
  $('span', $('#transcribe-button')).textContent = hasRaw ? t('actions.retranscribeAudio') : t('actions.transcribeAudio');
  const canRetryDictation = ['recording', 'finalizing', 'error'].includes(state.session.dictation?.status) && state.session.dictation.chunks?.length;
  $('#retry-dictation-button').classList.toggle('hidden', !canRetryDictation);
  $('#retry-dictation-button').disabled = isProcessing || state.dictationStatus === 'finalizing';
  renderDictationControl(dictationBlocked);
  $('[data-action="upload-audio"]').disabled = isProcessing || dictating;
  $('#language-select').disabled = isProcessing || dictating;
  $('#stt-model-select').disabled = isProcessing || dictating;
  renderSelectedModelStatus();
  $('#session-menu-button').disabled = isProcessing;
  const emptyAction = $('#empty-action');
  const showEmptyAction = config.key === 'rawTranscript' && !hasContent && processing?.status !== 'running';
  emptyAction.classList.toggle('hidden', !showEmptyAction);
  emptyAction.disabled = isProcessing;
  emptyAction.dataset.nextAction = state.session.audio ? 'transcribe' : 'upload';
  $('span', emptyAction).textContent = state.session.audio ? t('actions.transcribeAudio') : t('actions.uploadAudioVideo');
  renderAiActions({ config, artifact, processing, hasContent, supportsBilingual, isProcessing });
  $$('[data-action="upload-material"]').forEach((button) => { button.disabled = isProcessing; });
  $$('[data-delete-material]').forEach((button) => { button.disabled = isProcessing; });
}

function renderAiActions({ config, artifact, processing, hasContent, supportsBilingual, isProcessing }) {
  const recording = dictationInProgress() || serverDictationInProgress();
  const hasRaw = Boolean(state.session.artifacts.rawTranscript?.content);
  const raw = config.key === 'rawTranscript';
  const blocked = isProcessing || recording;
  const reviseButton = $('#revise-button');
  reviseButton.classList.toggle('hidden', !raw);
  reviseButton.disabled = blocked || !(state.session.transcriptSegments || []).length;
  reviseButton.textContent = state.session.processing?.stage === 'revision' && state.session.processing.status === 'running'
    ? t('actions.improving') : t('actions.improveTranscript');
  const generateButton = $('#generate-button');
  generateButton.classList.toggle('hidden', !config.stage);
  const valid = hasContent && !artifact?.stale && (artifact?.dependsOn || artifact?.source === 'manual-edit');
  generateButton.disabled = blocked || !hasRaw || (valid && processing?.status !== 'error');
  generateButton.textContent = processing?.status === 'running' ? t('actions.generating')
    : processing?.status === 'error' ? t('actions.retry')
      : artifact?.stale ? t('actions.update') : valid ? t('actions.upToDate') : t('actions.generate');
  const translation = currentTranslation();
  const translationPending = Boolean(translation?.pendingText?.trim())
    || [...(translation?.segments || []), translation?.pendingTranslation]
      .filter(Boolean).some((segment) => segment.status !== 'translated');
  const translated = translation && !translation.stale && translation.targetLanguage === state.session.targetLanguage
    && translation.content && !translationPending && translation.generationState !== 'error' && !currentTranslationFailed();
  const translateButton = $('#translate-button');
  translateButton.classList.toggle('hidden', raw || !supportsBilingual || !state.bilingualView || state.showingOriginal);
  const translationActive = translation?.generationState === 'running'
    || translation?.segments?.some((segment) => segment.status === 'translating')
    || translation?.pendingTranslation?.status === 'translating';
  const translationBlocked = isProcessing || recording;
  translateButton.disabled = translationBlocked || translationActive || Boolean(artifact?.stale) || Boolean(translated);
  translateButton.textContent = translationActive ? t('translation.translating')
    : translated ? t('actions.translationSaved')
      : translation?.stale ? t('actions.updateTranslation') : t('actions.translate');
}

async function setLiveTranslation(enabled) {
  const sessionId = state.session?.id;
  if (!sessionId) return;
  const session = await api(`/api/sessions/${encodeURIComponent(sessionId)}/live-translation`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
  });
  if (state.session?.id === sessionId) state.session = session;
}

async function toggleBilingual() {
  if (state.bilingualSaving || !state.session || !await settleEditor()) return;
  const sessionId = state.session.id;
  const enabled = !state.bilingualView;
  state.bilingualSaving = true;
  renderDocument(true);
  try {
    if (enabled) await setLiveTranslation(true);
    if (state.session?.id !== sessionId) return;
    state.bilingualView = enabled;
    localStorage.setItem('lecture-copilot-document-view', enabled ? 'bilingual' : 'original');
    state.preview = false;
    if (enabled) void ensureCurrentTranslation();
    if (sessionHasActiveWork()) startPolling();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    state.bilingualSaving = false;
    if (state.session?.id === sessionId) renderDocument(true);
  }
}

async function reviseTranscript() {
  if (!state.session || dictationInProgress() || serverDictationInProgress() || aiWorkInProgress() || !await settleEditor()) return;
  await withBusy(t('actions.improving'), async () => {
    state.session = await api(`/api/sessions/${encodeURIComponent(state.session.id)}/asr/revise`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    render({ preserveEditor: true });
  });
}

function translationStateCopy(translation, { raw = false } = {}) {
  if (translation?.generationState === 'running'
    || translation?.segments?.some((segment) => segment.status === 'translating')
    || translation?.pendingTranslation?.status === 'translating') return t('translation.translating');
  // Raw is rendered continuously while dictation changes its source. Avoid a
  // stale banner/placeholder that flickers with every source update; a retry
  // action is rendered separately only when one is actually available.
  if (translation?.stale) return raw ? t('translation.pending') : t('translation.outOfDate');
  if (translation?.generationState === 'error'
    || translation?.segments?.some((segment) => segment.status === 'error')
    || translation?.pendingTranslation?.status === 'error'
    || currentTranslationFailed()) return t('translation.retryable');
  return raw ? t('translation.pending') : t('translation.manualHint');
}

function renderBilingualView(container, sourceContent) {
  const translation = currentTranslation();
  const labels = `<div class="bilingual-labels"><span>${escapeHtml(t('translation.original'))}</span><span>${escapeHtml(`${t('translation.translation')} · ${state.session.targetLanguage}`)}</span></div>`;
  editableDocument.captureSelection();
  const setContent = (html) => {
    container.innerHTML = html;
  };
  if (state.tab === 'raw') {
    // Raw translation units are the stable sentence-level source of truth.
    // Paragraphization segments may be finer-grained (or span several units),
    // so aligning by paragraph index falsely shows completed translations as
    // pending after a long dictation. Fall back to paragraph segments only
    // before the first translation snapshot exists.
    const translationMatchesSource = translation?.sourceFingerprint === state.session.artifacts.rawTranscript?.contentFingerprint;
    const sourceSegments = translationMatchesSource && translation?.segments?.length
      ? translation.segments.map((segment, index) => ({ ...segment, id: segment.id || `raw_unit_${index}`, sourceText: segment.sourceText }))
      : (state.session.paragraphization?.segments || []).map((segment, index) => ({
        id: segment.id || `raw_unit_${index}`,
        sourceText: segment.text,
      }));
    if (!sourceSegments.length && translationMatchesSource && translation?.segments?.length) sourceSegments.push(...translation.segments);
    const semanticGroups = state.session.paragraphization?.status === 'provisional'
      ? []
      : (state.session.paragraphization?.paragraphs || [])
        .filter((paragraph) => paragraph.manualLocked)
        .map((paragraph) => paragraph.segmentIds || []);
    const blocks = groupRawDisplayBlocks(sourceSegments, translation?.pendingText || '', state.rawDisplayBlocks, {
      semanticGroups,
      pendingTranslation: translation?.pendingTranslation || null,
    });
    state.rawDisplayBlocks = blocks;
    const alignmentUnits = buildRawAlignmentUnits(blocks);
    const renderTranslation = (unit) => {
      if (unit.displayTranslatedText) {
        const revisionSuffix = unit.hasPreviousTranslation
          ? `<span class="translation-revision-state${unit.hasRevisionError ? ' error' : ''}">${escapeHtml(t(unit.hasRevisionError ? 'translation.revisionFailed' : 'translation.beingRevised'))}</span>`
          : '';
        return `${escapeHtml(unit.displayTranslatedText)}${revisionSuffix}`;
      }
      if (unit.status === 'error') return `<span class="translation-state error">${escapeHtml(t('translation.failed'))}</span>`;
      return `<span class="translation-state">${escapeHtml(translationStateCopy(translation, { raw: true }))}</span>`;
    };
    const unitById = new Map(alignmentUnits.map((unit) => [unit.id, unit]));
    const translationLabel = t('translation.translation');
    const decorateBlock = (block) => {
      const unit = unitById.get(block.id);
      const cell = document.createElement('article');
      cell.className = 'raw-translation-cell';
      cell.dataset.alignmentId = block.id;
      cell.dataset.label = translationLabel;
      cell.innerHTML = renderTranslation(unit);
      return cell;
    };
    const alignmentRenderKey = alignmentUnits
      .map((unit) => `${unit.id}:${unit.status}:${unit.displayTranslatedText}:${unit.hasPreviousTranslation}:${unit.hasRevisionError}`)
      .join('|');
    const retry = translation?.generationState === 'error' || currentTranslationFailed() || sourceSegments.some((segment) => segment.status === 'error')
      ? `<button class="translation-retry" data-action="retry-translation">${escapeHtml(t('actions.retryTranslation'))}</button>` : '';
    setContent(`${labels}<div class="raw-alignment-rows" data-editor-host></div>${retry}`);
    mountCurrentEditor($('[data-editor-host]', container), sourceContent, {
      blocks: alignmentUnits,
      bilingual: true,
      decorateBlock,
      renderKeySuffix: `${getLocale()}:${state.session.targetLanguage}:${translation?.updatedAt || ''}:${alignmentRenderKey}`,
      sourceLabel: t('translation.original'),
    });
    markTranslationRendered(translation);
    return;
  }
  const translatedContent = translation?.content;
  const staleNotice = translation?.stale
    ? `<div class="translation-notice"><span>${escapeHtml(t('translation.outOfDate'))}</span><button data-action="retry-translation">${escapeHtml(t('actions.retryTranslation'))}</button></div>` : '';
  const translationBody = translatedContent
    ? `${staleNotice}${markdown(translatedContent)}`
    : `<div class="translation-empty"><span>${escapeHtml(translationStateCopy(translation))}</span>${translation?.generationState === 'error' || translation?.stale || currentTranslationFailed() ? `<button data-action="retry-translation">${escapeHtml(t('actions.retryTranslation'))}</button>` : ''}</div>`;
  setContent(`${labels}<div class="bilingual-columns"><div class="editable-source-column" data-editor-host data-label="${escapeHtml(t('translation.original'))}"></div><article class="translated-document" data-label="${escapeHtml(t('translation.translation'))}">${translationBody}</article></div>`);
  mountCurrentEditor($('[data-editor-host]', container), sourceContent, { bilingual: true });
  markTranslationRendered(translation);
}

function renderDictationControl(dictationBlocked) {
  const isProcessing = dictationBlocked;
  const status = state.dictationStatus;
  const starting = status === 'starting';
  const recording = status === 'recording';
  const finalizing = status === 'finalizing';
  const transitioning = starting || finalizing;
  const background = state.session?.asr?.status === 'background';
  const control = $('#dictation-control');
  control.classList.toggle('idle', !recording && !transitioning);
  control.classList.toggle('recording', recording);
  control.classList.toggle('finalizing', transitioning);
  $('#dictation-status').classList.toggle('hidden', !recording && !transitioning && !background);
  $('#dictation-indicator').innerHTML = transitioning || background ? '<span class="spinner"></span>' : '<span class="record-dot"></span>';
  $('#dictation-state-label').textContent = starting ? t('recording.starting')
    : finalizing ? t('recording.processingRemaining')
      : background ? t('recording.backgroundAsr') : t('recording.recording');
  $('#record-timer').classList.toggle('hidden', !recording);
  const backlog = $('#dictation-backlog');
  const asrBacklog = state.session?.asr?.backlog;
  const stageBacklog = asrBacklog ? [
    [asrBacklog.transcription?.queued, 'recording.transcriptionQueued'],
    [asrBacklog.transcription?.active, 'recording.transcriptionActive'],
    [asrBacklog.refinement?.queued, 'recording.refinementQueued'],
    [asrBacklog.refinement?.active, 'recording.refinementActive'],
  ].filter(([count]) => Number(count) > 0).map(([count, key]) => t(key, { count: Number(count) })) : [];
  const highQualityPending = Number(asrBacklog?.highQuality?.total ?? state.session?.asr?.pending?.highQuality ?? 0);
  const backlogText = state.dictationError
    ? t('recording.transcriptionDelayed')
    : stageBacklog.length ? stageBacklog.join(' · ')
      : !asrBacklog && state.dictationBacklog > 1
      ? t('recording.chunksQueued', { count: state.dictationBacklog })
      : !asrBacklog && state.dictationBacklog === 1 ? t('recording.transcribing')
        : highQualityPending ? t('recording.highQualityPending', { count: highQualityPending }) : '';
  backlog.textContent = backlogText;
  backlog.classList.toggle('hidden', (!recording && !background) || !backlogText);
  $('#record-button').classList.toggle('hidden', transitioning);
  // Keep the idle action clickable when Whisper is unavailable so the click
  // can explain the missing runtime/model and open Settings. Stop must also
  // remain available if provider readiness changes during an active recording.
  $('#record-button').disabled = (isProcessing && !recording) || transitioning;
  $('#record-label').textContent = recording ? t('actions.stop') : t('actions.startDictation');
  $('#record-button').setAttribute('aria-label', recording ? t('actions.stopDictation') : t('actions.startDictation'));
}

function renderMaterials() {
  const list = $('#material-list');
  $('#material-empty').classList.toggle('hidden', state.session.materials.length > 0);
  list.innerHTML = state.session.materials.map((material) => `
    <div class="material-item ${material.extractionError ? 'error' : ''}">
      ${icon('file')}
      <div><strong>${escapeHtml(material.filename)}</strong><span>${material.extractionError ? escapeHtml(material.extractionError) : `${t('units.characters', { count: Number(material.characterCount || 0).toLocaleString(getLocale()) })} · ${escapeHtml(material.extractor || t('context.processing'))}`}</span></div>
      <button class="icon-button" data-delete-material="${material.id}" title="${escapeHtml(t('context.removeMaterial'))}" aria-label="${escapeHtml(t('context.removeMaterialAria', { filename: material.filename }))}">${icon('trash')}</button>
    </div>`).join('');
  $('#material-drop').classList.toggle('hidden', state.session.materials.length >= 5);
  $('#material-drop').classList.toggle('compact', state.session.materials.length > 0);
}

function pipelineState(completed, runningStage, aliases = []) {
  return runningStage && aliases.includes(runningStage) ? 'running' : completed ? 'complete' : '';
}

function renderPipeline() {
  const session = state.session;
  const stages = [
    { name: t('pipeline.audioSource'), detail: session.audio ? session.audio.filename : t('pipeline.recordOrUpload'), complete: session.audio, aliases: ['upload'] },
    { name: t('pipeline.rawTranscript'), detail: session.artifacts.rawTranscript ? t('pipeline.preservedHistory') : t('pipeline.localWhisper'), complete: session.artifacts.rawTranscript, aliases: ['transcription'] },
    { name: t('pipeline.processedTranscript'), detail: session.artifacts.cleanedTranscript?.stale ? t('pipeline.cleanupOutOfDate') : session.artifacts.cleanedTranscript ? t('pipeline.cleanupSaved') : t('pipeline.independentP1'), complete: session.artifacts.cleanedTranscript && !session.artifacts.cleanedTranscript.stale, aliases: ['cleanup', 'translation', 'key-points', 'qa', 'analysis'] },
    { name: t('pipeline.groundedNotes'), detail: session.materials.length ? t(session.materials.length === 1 ? 'pipeline.attachedMaterial' : 'pipeline.attachedMaterials', { count: session.materials.length }) : t('pipeline.transcriptOnly'), complete: session.artifacts.notes, aliases: ['notes'] },
    { name: t('pipeline.conceptOutline'), detail: session.artifacts.outline ? t('pipeline.hierarchySaved') : t('pipeline.independentP2'), complete: session.artifacts.outline, aliases: ['outline'] },
  ];
  const running = session.processing?.status === 'running' ? session.processing.stage : null;
  $('#pipeline-list').innerHTML = stages.map((stage, index) => {
    const status = pipelineState(stage.complete, running, stage.aliases);
    return `<li class="pipeline-item ${status}"><span class="pipeline-node">${status === 'complete' ? icon('check') : status === 'running' ? '<span class="spinner"></span>' : index + 1}</span><span class="pipeline-copy"><strong>${escapeHtml(stage.name)}</strong><span>${escapeHtml(stage.detail)}</span></span><small>${status === 'complete' ? t('pipeline.saved') : status === 'running' ? t('pipeline.running') : ''}</small></li>`;
  }).join('');
  const completed = stages.filter((item) => item.complete).length;
  $('#pipeline-summary').textContent = t('context.savedCount', { completed, total: stages.length });
}

function renderProcessing() {
  const value = state.session.processing;
  const banner = $('#processing-banner');
  const previousStatus = state.lastProcessingStatus;
  const nextStatus = value?.status || null;
  state.lastProcessingStatus = nextStatus;
  const visible = value?.stage !== 'dictation' && ['running', 'error'].includes(value?.status);
  banner.classList.toggle('hidden', !visible);
  banner.classList.toggle('error', value?.status === 'error');
  const details = $('#processing-details');
  if (visible && (nextStatus === 'running' || (nextStatus === 'error' && previousStatus === 'running'))) details.open = true;
  if (nextStatus === 'success' && previousStatus === 'running') details.open = false;
  if (!visible) return;
  const statusIcon = value.status === 'running' ? '<span class="spinner"></span>' : '⚠';
  const stage = t(STAGE_LABELS[value.stage] || value.stage);
  const message = value.status === 'running' ? t('status.processingStage', { stage }) : value.message;
  banner.innerHTML = `${statusIcon}<span><strong>${escapeHtml(stage)}</strong> — ${escapeHtml(message)}</span>`;
}

function renderMetadata() {
  $('#session-metadata').innerHTML = `
    <dt>${t('meta.created')}</dt><dd>${new Date(state.session.createdAt).toLocaleString(getLocale())}</dd>
    <dt>${t('meta.language')}</dt><dd>${escapeHtml(t(`language.${state.session.language}`))}</dd>
    <dt>${t('meta.whisper')}</dt><dd>${escapeHtml(state.session.sttModel)}</dd>
    <dt>${t('meta.aiModel')}</dt><dd>${escapeHtml(state.session.llmModel)}</dd>
    <dt>${t('meta.sessionId')}</dt><dd>${escapeHtml(state.session.id.slice(-8))}</dd>`;
}

async function patchSession(values) {
  state.session = await api(`/api/sessions/${encodeURIComponent(state.session.id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values),
  });
  render();
  await loadSessions();
}

function renderSessionTitle() {
  const input = $('#session-title');
  input.value = sessionTitle.value;
  input.toggleAttribute('aria-invalid', Boolean(sessionTitle.error));
  input.toggleAttribute('aria-busy', sessionTitle.saving);
}

async function commitSessionTitle() {
  const request = sessionTitle.prepareSave();
  renderSessionTitle();
  if (!request) return;

  let updated;
  try {
    updated = await api(`/api/sessions/${encodeURIComponent(request.sessionId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: request.draftTitle }),
    });
  } catch (error) {
    const activeFailure = sessionTitle.rejectSave(request, error);
    if (activeFailure) renderSessionTitle();
    if (activeFailure || !sessionTitle.requestWasSuperseded(request)) {
      toast(t('status.titleSaveFailed', { message: error.message }), 'error');
    }
    return;
  }

  if (!sessionTitle.acceptSave(request, updated)) return;
  if (state.session?.id === request.sessionId) state.session = updated;
  state.sessions = state.sessions.map((session) => session.id === request.sessionId
    ? { ...session, title: updated.title, updatedAt: updated.updatedAt }
    : session);
  render();
  await loadSessions().catch((error) => toast(error.message, 'error'));
}

async function uploadAudio(file) {
  if (!state.session) return;
  await withBusy(t('status.uploadingAudio'), async () => {
    state.session = await api(`/api/sessions/${encodeURIComponent(state.session.id)}/audio`, {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) },
      body: file,
    });
    render();
    await loadSessions();
    toast(t('status.audioSaved'));
  });
}

const DICTATION_SAMPLE_RATE = 16_000;

function resamplePcm(input, sourceRate, targetRate = DICTATION_SAMPLE_RATE) {
  if (sourceRate === targetRate) return input;
  const ratio = sourceRate / targetRate;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(input.length - 1, left + 1);
    const mix = position - left;
    output[index] = input[left] * (1 - mix) + input[right] * mix;
  }
  return output;
}

function wavBlob(samples, sampleRate = DICTATION_SAMPLE_RATE) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function enqueueDictationChunk({ samples, startMs, endMs, hasSpeech, reason }) {
  const sessionId = state.recordingSessionId;
  if (!sessionId) return;
  const sequence = state.dictationSequence;
  state.dictationSequence += 1;
  const chunk = wavBlob(resamplePcm(samples, state.audioContext.sampleRate));
  const query = new URLSearchParams({
    sequence: String(sequence),
    startMs: String(Math.round(startMs)),
    endMs: String(Math.round(endMs)),
    speech: hasSpeech ? '1' : '0',
    boundary: reason || 'unknown',
  });
  state.dictationBacklog += 1;
  state.dictationRetainedBytes += chunk.size;
  state.dictationRetainedChunks += 1;
  render({ preserveEditor: true });
  state.dictationQueue = state.dictationQueue
    .catch(() => {})
    .then(async () => {
      const session = await api(`/api/sessions/${encodeURIComponent(sessionId)}/dictation/chunks?${query}`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: chunk,
      });
      if (state.session?.id === sessionId) state.session = session;
      state.dictationError = null;
      render({ preserveEditor: true });
      await loadSessions();
    })
    .catch(async (error) => {
      state.dictationError = error.message;
      toast(t('status.retryLive', { message: error.message }), 'error');
      await refreshSession({ preserveEditor: true }).catch(() => {});
    })
    .finally(() => {
      state.dictationBacklog = Math.max(0, state.dictationBacklog - 1);
      state.dictationRetainedBytes = Math.max(0, state.dictationRetainedBytes - chunk.size);
      state.dictationRetainedChunks = Math.max(0, state.dictationRetainedChunks - 1);
      render({ preserveEditor: true });
    });
}

function flushPcm(final = false) {
  if (final) state.speechSegmenter?.flush('stop');
}

async function stopDictation({ automatic = false } = {}) {
  if (state.dictationStatus !== 'recording') return;
  const sessionId = state.recordingSessionId || state.session.id;
  state.dictationStatus = 'finalizing';
  state.silenceMonitor?.stop();
  clearInterval(state.recordingTimer);
  state.session.processing = { stage: 'dictation', status: 'running', message: t('recording.processingRemaining') };
  render();
  await flushPcmWorklet(state.audioNode).catch(() => toast(t('status.audioFlushFailed'), 'error'));
  state.audioNode?.disconnect();
  state.audioSink?.disconnect();
  flushPcm(true);
  state.dictationStream?.getTracks().forEach((track) => track.stop());
  await state.audioContext?.close().catch(() => {});
  try {
    await state.dictationQueue;
    state.session = await api(`/api/sessions/${encodeURIComponent(sessionId)}/dictation/finalize`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    state.dictationStatus = 'complete';
    startPolling();
    toast(t(automatic ? 'status.dictationAutoStopped' : 'status.dictationComplete'));
    await loadSessions();
  } catch (error) {
    state.dictationStatus = 'error';
    state.dictationError = error.message;
    toast(t('status.dictationAttention', { message: error.message }), 'error');
    await refreshSession().catch(() => {});
  } finally {
    state.dictationStream = null;
    state.recordingSessionId = null;
    state.audioContext = null;
    state.audioNode = null;
    state.audioSink = null;
    state.silenceMonitor = null;
    state.speechSegmenter = null;
    state.dictationBacklog = 0;
    render();
  }
}

async function toggleRecording() {
  if (state.dictationStatus === 'recording') return stopDictation();
  if (['starting', 'finalizing'].includes(state.dictationStatus) || aiWorkInProgress()) return;
  if (!await settleEditor()) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.AudioWorkletNode) {
    toast(t('status.liveAudioUnavailable'), 'error');
    return;
  }
  if (!state.health.sttReady) {
    toast(state.health.sttRuntime?.message || t('status.whisperNotReady'), 'error');
    $('#settings-dialog').showModal();
    return;
  }
  const liveModel = configuredAsrModels().provisional;
  const unavailableModel = sttModelDetails(liveModel).state !== 'ready' ? liveModel : null;
  if (unavailableModel) {
    toast(t('status.installBeforeDictation', { model: sttModelDetails(unavailableModel).label || unavailableModel }), 'error');
    await loadSettings();
    await refreshSttModels().catch(() => {});
    $('#settings-dialog').showModal();
    return;
  }
  const sessionId = state.session?.id;
  if (!sessionId) return;
  state.dictationStatus = 'starting';
  state.recordingSessionId = sessionId;
  render();
  let stream;
  let context;
  let source;
  let node;
  let sink;
  try {
    stream = await requestMicrophone(
      navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices),
      { audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } },
    );
    context = new AudioContext();
    await context.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, 'lecture-pcm-processor');
    sink = context.createGain();
    sink.gain.value = 0;
    await patchSession({ language: $('#language-select').value });
    await setLiveTranslation(true);
    const dictation = await api(`/api/sessions/${encodeURIComponent(sessionId)}/dictation/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: state.session.language }),
    });
    node.port.onmessage = (event) => {
      if (!['recording', 'finalizing'].includes(state.dictationStatus) || !(event.data instanceof Float32Array)) return;
      const samples = event.data;
      if (state.dictationStatus === 'recording') state.silenceMonitor?.process(samples, context.sampleRate);
      state.speechSegmenter?.process(samples, context.sampleRate);
    };
    source.connect(node);
    node.connect(sink);
    sink.connect(context.destination);
    state.dictationStream = stream;
    state.audioContext = context;
    state.audioNode = node;
    state.audioSink = sink;
    state.silenceMonitor = new SilenceAutoStopMonitor({
      onSilence: () => {
        if (state.dictationStatus === 'recording') void stopDictation({ automatic: true });
      },
    }).start();
    state.speechSegmenter = new SpeechBoundarySegmenter({ onSegment: enqueueDictationChunk });
    state.dictationSequence = 0;
    state.dictationQueue = Promise.resolve();
    state.dictationBacklog = 0;
    state.dictationError = null;
    state.dictationStatus = 'recording';
    state.session.dictation = dictation;
    state.recordingStarted = Date.now();
    state.tab = 'raw';
    updateRecordTimer();
    state.recordingTimer = setInterval(updateRecordTimer, 1000);
    startPolling();
    render();
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    state.silenceMonitor?.stop();
    state.silenceMonitor = null;
    state.speechSegmenter = null;
    await context?.close().catch(() => {});
    state.dictationStatus = 'idle';
    state.recordingSessionId = null;
    state.dictationError = error.message;
    const permission = error.name === 'NotAllowedError'
      ? t('status.microphoneDenied')
      : error instanceof MicrophoneTimeoutError
        ? t('status.microphoneTimedOut')
        : error.message;
    toast(t('status.startDictationFailed', { message: permission }), 'error');
    await refreshSession().catch(() => {});
  }
}

function updateRecordTimer() {
  const elapsed = Math.floor((Date.now() - state.recordingStarted) / 1000);
  $('#record-timer').textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
}

async function transcribe() {
  const selectedModel = $('#stt-model-select').value;
  if (sttModelDetails(selectedModel).state !== 'ready') {
    toast(t('status.installBeforeTranscribe', { model: sttModelDetails(selectedModel).label || selectedModel }), 'error');
    return;
  }
  await patchSession({ language: $('#language-select').value, sttModel: $('#stt-model-select').value });
  await withBusy(`Transcribing locally with Whisper ${state.session.sttModel}…`, async () => {
    startPolling();
    await api(`/api/sessions/${encodeURIComponent(state.session.id)}/transcribe`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: state.session.sttModel, language: state.session.language }),
    });
    state.tab = 'raw';
    await refreshSession();
    await loadSessions();
    toast(t('status.rawSaved'));
  });
}

async function retryDictation() {
  state.dictationStatus = 'finalizing';
  render();
  await withBusy(t('status.retryingDictation'), async () => {
    state.session = await api(`/api/sessions/${encodeURIComponent(state.session.id)}/dictation/finalize`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    state.dictationStatus = 'complete';
    state.tab = 'raw';
    await loadSessions();
    toast(t('status.dictationRecovered'));
  });
  if (state.session?.dictation?.status === 'error') state.dictationStatus = 'error';
}

async function runWorkflow() {
  await withBusy(t('status.workflowBuilding'), async () => {
    startPolling();
    await api(`/api/sessions/${encodeURIComponent(state.session.id)}/workflows/lecture-notes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    state.tab = 'notes';
    state.study = 'notes';
    state.preview = false;
    await refreshSession();
    await loadSessions();
    toast(t('status.workflowSaved'));
  });
}

async function withBusy(message, action) {
  if (state.busy) return;
  state.busy = true;
  $('#processing-banner').classList.remove('hidden', 'error');
  $('#processing-banner').innerHTML = `<span class="spinner"></span><span>${escapeHtml(message)}</span>`;
  renderDocument(true);
  try {
    await action();
  } catch (error) {
    toast(error.message, 'error');
    await refreshSession({ preserveEditor: true }).catch(() => {});
  } finally {
    state.busy = false;
    if (sessionHasActiveWork()) startPolling();
    else stopPolling();
    render({ preserveEditor: true });
  }
}

function aiWorkInProgress() {
  return state.busy || artifactRequests.size > 0
    || [...translationRequests.keys()].some((key) => !liveTranslationRequests.has(key))
    || (state.session?.processing?.status === 'running' && state.session.processing.stage !== 'dictation')
    || state.session?.asr?.status === 'background';
}

function sessionHasActiveWork() {
  return aiWorkInProgress() || dictationInProgress() || serverDictationInProgress()
    || state.session?.processing?.status === 'running'
    || (state.session?.liveTranslation?.enabled && ['pending', 'running'].includes(state.session.liveTranslation.status))
    || (state.session?.liveTranslation?.enabled && state.session.artifacts.rawTranslation?.generationState === 'running')
    || liveTranslationRequests.size > 0;
}

function startPolling() {
  sessionPoller.start();
}

function stopPolling() {
  sessionPoller.stop();
}

async function logRuntimeDiagnostics() {
  if (!state.health.runtimeDebug) return;
  try {
    const runtime = await api('/api/debug/runtime');
    const heap = performance.memory || {};
    console.log([
      '[RUNTIME-MEM]',
      'renderer=1',
      `heapMB=${((heap.usedJSHeapSize || 0) / 1048576).toFixed(1)}`,
      `heapLimitMB=${((heap.jsHeapSizeLimit || 0) / 1048576).toFixed(1)}`,
      `domNodes=${document.getElementsByTagName('*').length}`,
      `audioBytesMB=${(state.dictationRetainedBytes / 1048576).toFixed(1)}`,
      `audioChunks=${state.dictationRetainedChunks}`,
      `blobUrls=${activeObjectUrls.size}`,
      `smallTurboHqQ=${runtime.whisper.queued}`,
      `whisperActive=${runtime.whisper.active}`,
      `translationQ=${runtime.llm.queued}`,
      `llmActive=${runtime.llm.active}`,
      `llmRequestsSinceReset=${runtime.llm.lifecycle?.models?.[0]?.requestsSinceReset || 0}`,
      `llmResetPending=${Boolean(runtime.llm.lifecycle?.resetPending)}`,
      `segments=${runtime.segments}`,
    ].join(' '));
  } catch (error) {
    console.warn('[RUNTIME-MEM] renderer diagnostics failed:', error.message);
  }
}

function startRuntimeDiagnostics() {
  clearInterval(state.runtimeDiagnosticsTimer);
  state.runtimeDiagnosticsTimer = null;
  if (!state.health.runtimeDebug) return;
  state.runtimeDiagnosticsTimer = setInterval(() => { void logRuntimeDiagnostics(); }, 10_000);
  void logRuntimeDiagnostics();
}

function renderSaveState() {
  if (!state.session) return;
  $('#save-indicator').textContent = state.dirty
    ? t('state.unsavedChanges')
    : t('state.savedLocally', { date: relativeDate(state.session.updatedAt) });
}

function scheduleAutosave({ dirty }) {
  state.dirty = dirty;
  renderSaveState();
  clearTimeout(autosaveTimer);
  autosaveTimer = dirty ? setTimeout(() => { void flushAutosave(); }, 450) : null;
}

async function persistEditorSnapshot({ keepalive = false } = {}) {
  if (!state.session || state.showingOriginal || !INLINE_EDITABLE_ARTIFACTS.has(currentConfig().key)) return;
  const sessionId = state.session.id;
  const config = currentConfig();
  const identity = editableDocument.identity;
  const content = editableDocument.value();
  const baseContent = editableDocument.baseValue;
  const artifact = await api(`/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(config.key)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, baseContent }),
    keepalive,
  });
  if (state.session?.id !== sessionId || editableDocument.identity !== identity) return;
  state.session.artifacts[config.key] = artifact;
  editableDocument.acceptSaved(artifact.content);
  state.dirty = editableDocument.dirty;
  renderSaveState();
  if (!keepalive) {
    await refreshSession({ preserveEditor: true });
    await loadSessions();
  }
}

async function flushAutosave({ keepalive = false } = {}) {
  clearTimeout(autosaveTimer);
  autosaveTimer = null;
  if (autosavePromise) {
    await autosavePromise;
    if (!state.dirty || keepalive) return;
  }
  if (!state.dirty) return;
  const run = (async () => {
    try {
      do {
        await persistEditorSnapshot({ keepalive });
      } while (!keepalive && state.dirty);
    } catch (error) {
      state.dirty = true;
      renderSaveState();
      toast(error.message, 'error');
    }
  })();
  autosavePromise = run;
  try {
    await run;
  } finally {
    if (autosavePromise === run) autosavePromise = null;
  }
}

async function saveArtifact() {
  await flushAutosave();
}

async function uploadMaterials(files) {
  for (const file of files) {
    await withBusy(t('status.audioExtracting', { filename: file.name }), async () => {
      try {
        await api(`/api/sessions/${encodeURIComponent(state.session.id)}/materials`, {
          method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) }, body: file,
        });
        toast(t('status.materialExtracted', { filename: file.name }));
      } finally {
        await refreshSession({ preserveEditor: true });
      }
    });
  }
}

async function deleteMaterial(materialId) {
  const material = state.session.materials.find((item) => item.id === materialId);
  if (!material || !window.confirm(t('dialog.removeMaterial', { filename: material.filename }))) return;
  state.session = await api(`/api/sessions/${encodeURIComponent(state.session.id)}/materials/${encodeURIComponent(materialId)}`, { method: 'DELETE' });
  render();
  toast(t('status.materialRemoved'));
}

function confirmSessionDeletion(session) {
  const dialog = $('#delete-session-dialog');
  const copy = deletionConfirmationCopy(session);
  $('#delete-session-heading').textContent = copy.heading;
  $('#delete-session-description').textContent = copy.description;
  dialog.returnValue = 'cancel';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'delete'), { once: true });
  });
}

function clearSelectedSession() {
  stopPolling();
  rawTranscriptFollow.reset();
  rawTranscriptFollowVersion = '';
  state.session = null;
  sessionTitle.clear();
  state.dirty = false;
  state.preview = false;
  state.showingOriginal = false;
  state.lastProcessingStatus = null;
  state.dictationStatus = 'idle';
  localStorage.removeItem('lecture-copilot-session');
}

async function deleteSession(sessionId) {
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  if (state.session?.id === sessionId && !await settleEditor()) return;
  if (state.session?.id === sessionId && ['recording', 'finalizing'].includes(state.dictationStatus)) {
    toast(t('status.stopBeforeDelete'), 'error');
    return;
  }
  let result;
  try {
    result = await confirmAndDeleteSession({
      session,
      sessions: state.sessions,
      selectedId: state.session?.id,
      confirmDelete: confirmSessionDeletion,
      remove: (id) => api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    });
  } catch (error) {
    toast(t('status.deleteFailed', { title: session.title, message: error.message }), 'error');
    return;
  }
  if (result.status === 'cancelled') return;
  const wasSelected = state.session?.id === sessionId;
  state.sessions = result.sessions;
  if (!wasSelected) {
    renderSessions();
    toast(t('status.deleted', { title: session.title }));
    return;
  }
  clearSelectedSession();
  if (!result.selectedId) {
    render();
    toast(t('status.deleted', { title: session.title }));
    return;
  }
  try {
    await selectSession(result.selectedId, true);
  } catch (error) {
    await loadSessions(false).catch(() => {});
    const fallback = state.sessions[0];
    if (fallback) await selectSession(fallback.id, true).catch(() => { clearSelectedSession(); render(); });
    else render();
    toast(t('status.nextSessionFailed', { message: error.message }), 'error');
  }
  toast(t('status.deleted', { title: session.title }));
}

async function ensureCurrentTranslation({ force = false } = {}) {
  const key = translationKeyForCurrent();
  const sourceArtifact = currentArtifact();
  if (!key || !state.session || !sourceArtifact?.content || sourceArtifact.stale) return;
  const recording = dictationInProgress() || serverDictationInProgress();
  const liveRaw = recording && key === 'rawTranslation';
  if ((recording && !liveRaw) || (!liveRaw && aiWorkInProgress()) || !await settleEditor()) return;
  const artifact = state.session.artifacts[key];
  const valid = artifact && !artifact.stale && artifact.targetLanguage === state.session.targetLanguage
    && (artifact.content || (key === 'rawTranslation' && artifact.sourceFingerprint));
  const rawPending = key === 'rawTranslation' && rawTranslationNeedsRefresh(state.session);
  if (valid && !rawPending && !force && artifact.generationState !== 'error') return;
  const sessionId = state.session.id;
  const requestKey = `${sessionId}:${key}`;
  if (translationRequests.has(requestKey)) return translationRequests.get(requestKey);
  if (liveRaw) liveTranslationRequests.add(requestKey);
  const request = (async () => {
    if (state.session?.id === sessionId) {
      state.session.artifacts[key] = { ...(artifact || {}), generationState: 'running' };
      if (!liveRaw) state.session.processing = { stage: translationStageForKey(key) || 'translation', status: 'running' };
      render({ preserveEditor: true });
      startPolling();
    }
    try {
      const translated = await api(`/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(key)}/ensure`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(liveRaw ? { newOnly: true } : {}),
      });
      if (state.session?.id !== sessionId) return;
      state.session.artifacts[key] = translated;
      await refreshSession({ preserveEditor: true });
    } catch (error) {
      if (state.session?.id !== sessionId) return;
      toast(error.message, 'error');
      await refreshSession({ preserveEditor: true }).catch(() => {});
    }
  })().finally(() => {
    translationRequests.delete(requestKey);
    liveTranslationRequests.delete(requestKey);
    if (state.session?.id === sessionId) {
      if (!sessionHasActiveWork()) stopPolling();
      render({ preserveEditor: true });
    }
  });
  translationRequests.set(requestKey, request);
  return request;
}

async function ensureCurrentArtifact({ force = false } = {}) {
  const config = currentConfig();
  if (!state.session || !config?.stage || !state.session.artifacts.rawTranscript?.content) return;
  if (dictationInProgress() || serverDictationInProgress() || aiWorkInProgress() || !await settleEditor()) return;
  const artifact = state.session.artifacts[config.key];
  if (artifact?.source === 'manual-edit' && INLINE_EDITABLE_ARTIFACTS.has(config.key) && !force) return artifact;
  if (artifact?.content && artifact.dependsOn && !artifact.stale && !force) return artifact;
  const sessionId = state.session.id;
  const requestKey = `${sessionId}:${config.key}`;
  if (artifactRequests.has(requestKey)) return artifactRequests.get(requestKey);
  const request = (async () => {
    if (state.session?.id === sessionId) {
      state.session.processing = { stage: config.stage, status: 'running', message: t('status.processingStage', { stage: configHeading(config) }) };
      render({ preserveEditor: true });
      startPolling();
    }
    try {
      const generated = await api(`/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(config.key)}/ensure`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      if (state.session?.id !== sessionId) return generated;
      state.session.artifacts[config.key] = generated;
      state.preview = false;
      await refreshSession({ preserveEditor: true });
      await loadSessions();
      return generated;
    } catch (error) {
      if (state.session?.id !== sessionId) return null;
      toast(error.message, 'error');
      await refreshSession({ preserveEditor: true }).catch(() => {});
      return null;
    } finally {
      if (artifactRequests.get(requestKey) === request) artifactRequests.delete(requestKey);
      if (state.session?.id === sessionId) {
        if (state.session.processing?.status !== 'running') stopPolling();
        render({ preserveEditor: true });
      }
    }
  })();
  artifactRequests.set(requestKey, request);
  return request;
}

async function switchTab(tab) {
  if (tab === state.tab || !await settleEditor()) return;
  state.tab = tab;
  state.dirty = false;
  state.preview = false;
  state.showingOriginal = false;
  render();
}

async function switchStudy(study) {
  if (study === state.study || !await settleEditor()) return;
  state.study = study;
  state.dirty = false;
  state.preview = false;
  render();
}

function toggleContext() {
  if (!state.session) return;
  closeMenus();
  $('#app').classList.toggle('context-closed');
  const expanded = !$('#app').classList.contains('context-closed');
  $('#context-panel').toggleAttribute('inert', !expanded);
  $('#context-panel').setAttribute('aria-hidden', String(!expanded));
  $$('[data-action="toggle-context"]').forEach((button) => button.setAttribute('aria-expanded', String(expanded)));
}

function bindEvents() {
  $('#session-list').addEventListener('contextmenu', (event) => {
    const item = event.target.closest('[data-session-id]');
    if (!item) return;
    closeMenus();
    item.classList.add('context-target');
    openSessionContextMenu({ event, menu: $('#session-context-menu'), sessionId: item.dataset.sessionId, viewport: window });
  });
  $('#session-menu-button').addEventListener('click', (event) => {
    event.stopPropagation();
    toggleMenu('#session-menu', '#session-menu-button');
  });
  $('#document-menu-button').addEventListener('click', (event) => {
    event.stopPropagation();
    toggleMenu('#document-menu', '#document-menu-button');
  });
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) {
      if (!event.target.closest('.menu-surface')) closeMenus();
      return;
    }
    const action = button.dataset.action;
    const contextSessionId = $('#session-context-menu').dataset.sessionId;
    if (action !== 'install-stt-model') closeMenus();
    if (button.dataset.sessionId) return selectSession(button.dataset.sessionId);
    if (button.dataset.tab) return switchTab(button.dataset.tab);
    if (button.dataset.installModel) return installSttModel(button.dataset.installModel);
    if (button.dataset.deleteMaterial) return deleteMaterial(button.dataset.deleteMaterial);
    if (button.dataset.paragraphSplit) return paragraphAction('split', { paragraphId: button.dataset.paragraphSplit });
    if (button.dataset.paragraphMerge) return paragraphAction('merge-previous', { paragraphId: button.dataset.paragraphMerge });
    if (action === 'toggle-bilingual') return toggleBilingual();
    if (action === 'generate-translation' || action === 'retry-translation') return ensureCurrentTranslation({ force: true });
    if (action === 'revise-transcript') return reviseTranscript();
    if (action === 'delete-session') return deleteSession(contextSessionId);
    if (action === 'new-session') return createSession();
    if (action === 'new-and-record') return createAndStart('record');
    if (action === 'new-and-upload') return createAndStart('upload');
    if (action === 'toggle-sidebar') return $('#app').classList.toggle('sidebar-open');
    if (action === 'toggle-context') return toggleContext();
    if (action === 'record') return toggleRecording();
    if (action === 'install-stt-model') return installSttModel($('#stt-model-select').value);
    if (action === 'retry-dictation') return retryDictation();
    if (action === 'upload-audio') return $('#audio-input').click();
    if (action === 'upload-material') return $('#material-input').click();
    if (action === 'transcribe') return transcribe();
    if (action === 'empty-action') return button.dataset.nextAction === 'transcribe' ? transcribe() : $('#audio-input').click();
    if (action === 'generate-current' || action === 'retry-artifact') return ensureCurrentArtifact({ force: true });
    if (action === 'save-artifact') return saveArtifact();
    if (action === 'copy') {
      const content = state.showingOriginal ? currentArtifact()?.originalContent : currentArtifact()?.content;
      if (!content) return toast(t('status.nothingToCopy'));
      await navigator.clipboard.writeText(content);
      return toast(t('status.copied'));
    }
    if (action === 'export') {
      const content = state.showingOriginal ? currentArtifact()?.originalContent : currentArtifact()?.content;
      if (!content) return toast(t('status.nothingToExport'));
      const slug = state.session.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'lecture';
      const objectUrl = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
      activeObjectUrls.add(objectUrl);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = `${slug}-${currentConfig().key}.md`;
      link.click();
      setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
        activeObjectUrls.delete(objectUrl);
      }, 1000);
      return toast(t('status.exportReady'));
    }
    if (action === 'toggle-preview') { state.preview = !state.preview; renderDocument(); return; }
    if (action === 'toggle-original') {
      if (!await settleEditor()) return;
      state.showingOriginal = !state.showingOriginal;
      state.preview = false;
      state.dirty = false;
      renderDocument();
    }
  });

  $('#new-session').addEventListener('click', createSession);
  $('#settings-button').addEventListener('click', async () => {
    renderInferenceModeSettings();
    await loadHealth();
    await loadSettings();
    await refreshSttModels().catch((error) => toast(t('status.modelSettingsUnavailable', { message: error.message }), 'error'));
    $('#settings-dialog').showModal();
  });
  $('#save-settings').addEventListener('click', async (event) => {
    event.preventDefault();
    const requestedPath = $('#storage-path').value.trim();
    const requestedTargetLanguage = $('#target-language').value.trim();
    const requestedLlmModel = $('#llm-model-select').value;
    const requestedLiveTranslationModel = $('#live-translation-model-select').value;
    const storageChanged = requestedPath && requestedPath !== state.settings.storagePath;
    const previousInference = readInferenceMode();
    const requestedInference = {
      mode: $('#inference-mode').value,
      controllerUrl: $('#cloud-controller-url').value.trim(),
      accessCode: $('#cloud-access-code').value.trim(),
    };
    if (requestedInference.mode === 'cloud' && (!requestedInference.controllerUrl || requestedInference.accessCode.length < 16)) {
      toast('Cloud mode requires the Netlify controller URL and an access code of at least 16 characters.', 'error');
      return;
    }
    if (storageChanged && !await settleEditor()) return;
    try {
      const result = await api('/api/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(storageChanged ? { storagePath: requestedPath } : {}),
          appLanguage: $('#app-language').value,
          asrModels: selectedAsrModels(),
        }),
      });
      state.settings = result;
      state.health.asrPipeline ||= {};
      state.health.asrPipeline.models = { ...result.asrModels };
      if (storageChanged) {
        state.session = null;
        state.dirty = false;
        localStorage.removeItem('lecture-copilot-session');
        await loadSessions(true);
        toast(t('settings.storageChanged'));
      }
      if (state.session) await patchSession({ llmModel: requestedLlmModel, liveTranslationModel: requestedLiveTranslationModel, targetLanguage: requestedTargetLanguage });
      saveInferenceMode(requestedInference);
      if (inferenceModeChanged(previousInference, requestedInference)) {
        $('#settings-dialog').close();
        await globalThis.lectureCopilotHost?.release?.();
        location.reload();
        return;
      }
      $('#settings-dialog').close();
      toast(t('settings.saved'));
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  $('#inference-mode').addEventListener('change', () => {
    $('#cloud-mode-fields').classList.toggle('hidden', $('#inference-mode').value !== 'cloud');
  });
  $('#live-translation-model-select').addEventListener('change', renderRawTranslationModelStatus);
  $('#app-language').addEventListener('change', async (event) => {
    const previous = state.settings.appLanguage;
    const next = event.target.value;
    applyAppLanguage(next);
    try {
      const updated = await api('/api/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appLanguage: next }),
      });
      state.settings = { ...state.settings, ...updated };
    } catch (error) {
      applyAppLanguage(previous);
      toast(error.message, 'error');
    }
  });
  $('#choose-storage').addEventListener('click', async (event) => {
    event.preventDefault();
    if (!window.desktop?.chooseWorkspace) return;
    const selected = await window.desktop.chooseWorkspace();
    if (selected) $('#storage-path').value = selected;
  });
  bindSessionTitleInput($('#session-title'), {
    onFocus: () => {
      sessionTitle.beginEditing();
      renderSessionTitle();
    },
    onInput: (value) => sessionTitle.update(value),
    onCommit: commitSessionTitle,
  });
  $('#language-select').addEventListener('change', () => patchSession({ language: $('#language-select').value }));
  $('#stt-model-select').addEventListener('change', async () => {
    const modelId = $('#stt-model-select').value;
    const model = sttModelDetails(modelId);
    renderSelectedModelStatus();
    if (model.state === 'ready') await patchSession({ sttModel: modelId });
  });
  Object.values(ASR_MODEL_SELECTORS).forEach((selector) => $(selector).addEventListener('change', renderWhisperModelList));
  $('#study-select').addEventListener('change', (event) => switchStudy(event.target.value));
  $('#audio-input').addEventListener('change', (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (file) uploadAudio(file).catch((error) => toast(error.message, 'error'));
  });
  $('#material-input').addEventListener('change', (event) => {
    const files = [...event.target.files];
    event.target.value = '';
    if (files.length) uploadMaterials(files);
  });
  const drop = $('#material-drop');
  for (const type of ['dragenter', 'dragover']) drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.add('dragover'); });
  for (const type of ['dragleave', 'drop']) drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.remove('dragover'); });
  drop.addEventListener('drop', (event) => { if (event.dataTransfer.files.length) uploadMaterials([...event.dataTransfer.files]); });
  document.addEventListener('keydown', (event) => {
    const contextMenu = $('#session-context-menu');
    if (!contextMenu.classList.contains('hidden') && ['Enter', ' '].includes(event.key) && document.activeElement?.dataset.action === 'delete-session') {
      const sessionId = contextMenu.dataset.sessionId;
      event.preventDefault();
      closeMenus();
      deleteSession(sessionId);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); createSession(); }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveArtifact(); }
    if (event.key === 'Escape') {
      closeMenus();
      $('#app').classList.remove('sidebar-open');
      if (window.innerWidth < 1200 && !$('#app').classList.contains('context-closed')) toggleContext();
    }
  });
  $('.document-tabs').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const tabs = $$('[data-tab]');
    const index = tabs.findIndex((tab) => tab.dataset.tab === state.tab);
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(index + direction + tabs.length) % tabs.length];
    event.preventDefault();
    switchTab(next.dataset.tab);
    next.focus();
  });
  window.addEventListener('beforeunload', () => { if (state.dirty) void flushAutosave({ keepalive: true }); });
  window.addEventListener('pagehide', () => {
    if (state.dirty) void flushAutosave({ keepalive: true });
    clearInterval(state.runtimeDiagnosticsTimer);
    stopPolling();
    for (const objectUrl of activeObjectUrls) URL.revokeObjectURL(objectUrl);
    activeObjectUrls.clear();
  });
  window.addEventListener('pageshow', () => { if (sessionHasActiveWork()) startPolling(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.dirty) void flushAutosave({ keepalive: true });
    sessionPoller.wake();
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth <= 860) $('#app').classList.remove('sidebar-open');
    if (window.innerWidth < 1280 && !$('#app').classList.contains('context-closed')) toggleContext();
  });
}

async function paragraphAction(action, input) {
  if (!state.session) return;
  try {
    if (!await settleEditor()) return;
    state.session = await api(`/api/sessions/${encodeURIComponent(state.session.id)}/paragraphs/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    render({ preserveEditor: true });
    toast(t(action === 'split' ? 'status.paragraphSplit' : 'status.paragraphMerged'));
  } catch (error) { toast(error.message, 'error'); }
}

async function init() {
  bindEvents();
  renderInferenceModeSettings();
  $('#app').classList.add('context-closed');
  const contextExpanded = !$('#app').classList.contains('context-closed');
  $('#context-panel').toggleAttribute('inert', !contextExpanded);
  $('#context-panel').setAttribute('aria-hidden', String(!contextExpanded));
  $$('[data-action="toggle-context"]').forEach((button) => button.setAttribute('aria-expanded', String(contextExpanded)));
  await Promise.all([loadHealth(), loadSettings(), loadSessions(false)]);
  startRuntimeDiagnostics();
  await loadSessions(true);
  render();
}

export const appReady = init();
appReady.catch((error) => {
  console.error(error);
  toast(t('status.workspaceStartFailed', { message: error.message }), 'error');
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await fs.readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const html = await fs.readFile(new URL('../web/index.html', import.meta.url), 'utf8');

function functionSource(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1);
  const remaining = source.slice(start);
  const next = remaining.slice(1).search(/^(?:async )?function /m);
  return next < 0 ? remaining : remaining.slice(0, next + 1);
}

test('navigating documents or study views never starts model work, even with bilingual enabled', async () => {
  const state = { tab: 'raw', study: 'notes', bilingualView: true, session: { artifacts: { rawTranscript: { content: 'A lecture.' } } } };
  let generated = 0;
  let translated = 0;
  const context = vm.createContext({
    state,
    settleEditor: async () => true,
    render() {},
    TAB_CONFIG: { cleaned: { stage: 'cleanup' }, notes: { stage: 'notes' }, outline: { stage: 'outline' } },
    ensureCurrentArtifact: async () => { generated += 1; },
    ensureCurrentTranslation: async () => { translated += 1; },
  });
  vm.runInContext(`${functionSource('switchTab')}\n${functionSource('switchStudy')}`, context);
  for (const tab of ['cleaned', 'notes', 'outline']) await context.switchTab(tab);
  for (const study of ['structuredAnalysis', 'keyPoints', 'qa']) await context.switchStudy(study);
  assert.equal(state.tab, 'outline');
  assert.equal(state.study, 'qa');
  assert.equal(generated, 0);
  assert.equal(translated, 0);
});

test('model generation entry points are invoked only by explicit click actions', () => {
  const beforeHandlers = source.slice(0, source.indexOf('function bindEvents()'));
  assert.equal((beforeHandlers.match(/ensureCurrentArtifact\(/g) || []).length, 1, 'only its declaration may precede event binding');
  assert.equal((beforeHandlers.match(/ensureCurrentTranslation\(/g) || []).length, 1, 'only its declaration may precede event binding');
  assert.match(html, /id="revise-button"[^>]*data-action="revise-transcript"/);
  assert.match(html, /id="generate-button"[^>]*data-action="generate-current"/);
  assert.match(html, /id="translate-button"[^>]*data-action="generate-translation"/);
  const toggle = source.slice(source.indexOf("if (action === 'toggle-bilingual')"), source.indexOf("if (action === 'generate-translation'"));
  assert.doesNotMatch(toggle, /ensureCurrentTranslation/);
  const settings = source.slice(source.indexOf("$('#save-settings').addEventListener"));
  assert.doesNotMatch(settings, /ensureCurrentArtifact\(|ensureCurrentTranslation\(/);
});

test('recording blocks derived translation, document generation, and audio refinement', async () => {
  let requests = 0;
  const context = vm.createContext({
    state: { session: { artifacts: { rawTranscript: { content: 'Draft.' } } } },
    currentConfig: () => ({ key: 'cleanedTranscript', stage: 'cleanup' }),
    currentArtifact: () => ({ content: 'Draft.' }),
    translationKeyForCurrent: () => 'cleanedTranslation',
    dictationInProgress: () => true,
    api: async () => { requests += 1; },
  });
  for (const name of ['ensureCurrentArtifact', 'ensureCurrentTranslation', 'reviseTranscript']) {
    vm.runInContext(functionSource(name), context);
    await context[name]();
  }
  assert.equal(requests, 0);
});

test('manual refinement calls the dedicated endpoint and retains normal error handling', async () => {
  const requests = [];
  const context = vm.createContext({
    state: { session: { id: 'lecture-1' } },
    dictationInProgress: () => false,
    serverDictationInProgress: () => false,
    aiWorkInProgress: () => false,
    settleEditor: async () => true,
    withBusy: async (_message, action) => action(),
    t: (key) => key,
    api: async (path, options) => { requests.push({ path, method: options.method }); return { id: 'lecture-1', processing: { stage: 'revision', status: 'running' } }; },
    render() {},
  });
  vm.runInContext(functionSource('reviseTranscript'), context);
  await context.reviseTranscript();
  assert.deepEqual(requests, [{ path: '/api/sessions/lecture-1/asr/revise', method: 'POST' }]);
  assert.equal(context.state.session.processing.status, 'running');
});

test('live capture requires only the lightweight model and keeps stop available', () => {
  const recording = functionSource('toggleRecording');
  assert.match(recording, /configuredAsrModels\(\)\.provisional/);
  assert.doesNotMatch(recording, /Object\.values\(configuredAsrModels\(\)\)/);
  assert.ok(recording.indexOf("state.dictationStatus === 'recording'") < recording.indexOf('aiWorkInProgress()'));
});

test('partially translated or stale documents retain an enabled manual translation action', () => {
  const elements = new Map();
  let translation;
  const artifact = { content: 'First sentence. Another sentence.' };
  const context = vm.createContext({
    state: { bilingualView: true, session: { targetLanguage: 'Chinese', artifacts: { rawTranscript: artifact } } },
    dictationInProgress: () => false,
    serverDictationInProgress: () => false,
    currentTranslation: () => translation,
    currentTranslationFailed: () => false,
    t: (key) => key,
    $: (selector) => {
      if (!elements.has(selector)) elements.set(selector, { classList: { toggle() {} } });
      return elements.get(selector);
    },
  });
  vm.runInContext(functionSource('renderAiActions'), context);
  for (const fields of [
    { stale: true },
    { segments: [{ status: 'translated' }, { status: 'pending' }] },
    { pendingText: 'Another sentence' },
    { generationState: 'error' },
  ]) {
    translation = { targetLanguage: 'Chinese', content: '已翻译第一句。', ...fields };
    context.renderAiActions({ config: { key: 'rawTranscript' }, artifact, hasContent: true, supportsBilingual: true, isProcessing: false });
    assert.equal(elements.get('#translate-button').disabled, false);
  }
  translation = { targetLanguage: 'Chinese', content: '已完成。', segments: [{ status: 'translated' }] };
  context.renderAiActions({ config: { key: 'rawTranscript' }, artifact, hasContent: true, supportsBilingual: true, isProcessing: false });
  assert.equal(elements.get('#translate-button').disabled, true);
});

test('Bilingual explicitly enables or pauses new-speech translation without ensuring a saved artifact', async () => {
  const requests = [];
  const state = { bilingualView: false, session: { id: 'lecture-1' } };
  const context = vm.createContext({
    state,
    settleEditor: async () => true,
    renderDocument() {},
    sessionHasActiveWork: () => false,
    localStorage: { setItem() {} },
    api: async (path, options) => {
      const body = JSON.parse(options.body);
      requests.push({ path, method: options.method, body });
      return { id: 'lecture-1', liveTranslation: { enabled: body.enabled } };
    },
    toast(message) { throw new Error(message); },
  });
  vm.runInContext(`${functionSource('setLiveTranslation')}\n${functionSource('toggleBilingual')}`, context);
  await context.toggleBilingual();
  assert.equal(state.bilingualView, true);
  assert.equal(state.session.liveTranslation.enabled, true);
  await context.toggleBilingual();
  assert.equal(state.bilingualView, false);
  assert.deepEqual(requests, [true, false].map((enabled) => ({
    path: '/api/sessions/lecture-1/live-translation', method: 'POST', body: { enabled },
  })));
  const recording = functionSource('toggleRecording');
  assert.ok(recording.indexOf('await setLiveTranslation(state.bilingualView)') < recording.indexOf('/dictation/start'));
});

test('a live Raw translation request preserves dictation processing and never blocks Stop', async () => {
  let complete;
  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  const requests = [];
  const state = { health: { ollamaReady: true }, session: { id: 'lecture-1', targetLanguage: 'Chinese', processing: { stage: 'dictation', status: 'running' }, artifacts: {} } };
  const translationRequests = new Map();
  const liveTranslationRequests = new Set();
  const context = vm.createContext({
    state, translationRequests, liveTranslationRequests,
    translationKeyForCurrent: () => 'rawTranslation',
    currentArtifact: () => ({ content: 'New speech.' }),
    dictationInProgress: () => true,
    aiWorkInProgress: () => false,
    settleEditor: async () => true,
    render() {},
    startPolling() {},
    refreshSession: async () => {},
    sessionHasActiveWork: () => true,
    api: (path, options) => {
      requests.push({ path, method: options.method, body: JSON.parse(options.body) });
      started();
      return new Promise((resolve) => { complete = resolve; });
    },
    toast(message) { throw new Error(message); },
  });
  vm.runInContext(functionSource('ensureCurrentTranslation'), context);
  const request = context.ensureCurrentTranslation({ force: true });
  await requestStarted;
  assert.equal(state.session.processing.stage, 'dictation');
  assert.equal(liveTranslationRequests.size, 1);
  assert.deepEqual(requests, [{ path: '/api/sessions/lecture-1/artifacts/rawTranslation/ensure', method: 'POST', body: { newOnly: true } }]);
  complete({ content: '新语音。' });
  await request;
  assert.equal(liveTranslationRequests.size, 0);
  assert.equal(translationRequests.size, 0);

  context.artifactRequests = new Map();
  translationRequests.set('lecture-1:rawTranslation', Promise.resolve());
  liveTranslationRequests.add('lecture-1:rawTranslation');
  vm.runInContext(functionSource('aiWorkInProgress'), context);
  assert.equal(context.aiWorkInProgress(), false);
  translationRequests.set('lecture-1:notesTranslation', Promise.resolve());
  assert.equal(context.aiWorkInProgress(), true);
});

test('new-speech translation can be requested while recording but improvement stays disabled', () => {
  const elements = new Map();
  const artifact = { content: 'New speech.' };
  const context = vm.createContext({
    state: { bilingualView: true, session: { artifacts: { rawTranscript: artifact }, liveTranslation: { enabled: true } } },
    dictationInProgress: () => true,
    currentTranslation: () => null,
    currentTranslationFailed: () => false,
    t: (key) => key,
    $: (selector) => {
      if (!elements.has(selector)) elements.set(selector, { classList: { toggle() {} } });
      return elements.get(selector);
    },
  });
  vm.runInContext(functionSource('renderAiActions'), context);
  context.renderAiActions({ config: { key: 'rawTranscript' }, artifact, hasContent: true, supportsBilingual: true, isProcessing: false });
  assert.equal(elements.get('#translate-button').disabled, false);
  assert.equal(elements.get('#translate-button').textContent, 'actions.translateNewSpeech');
  assert.equal(elements.get('#revise-button').disabled, true);
  context.renderAiActions({ config: { key: 'cleanedTranscript', stage: 'cleanup' }, artifact, hasContent: true, supportsBilingual: true, isProcessing: false });
  assert.equal(elements.get('#translate-button').disabled, true);
  assert.equal(elements.get('#generate-button').disabled, true);
});

test('polling follows queued new-speech translation after Stop and stops when it finishes', () => {
  const state = { session: { artifacts: {}, liveTranslation: { enabled: true, status: 'pending' } } };
  const context = vm.createContext({
    state,
    liveTranslationRequests: new Set(),
    aiWorkInProgress: () => false,
    dictationInProgress: () => false,
    serverDictationInProgress: () => false,
  });
  vm.runInContext(functionSource('sessionHasActiveWork'), context);
  assert.equal(context.sessionHasActiveWork(), true);
  state.session.liveTranslation.status = 'idle';
  assert.equal(context.sessionHasActiveWork(), false);
});

test('Raw translation defaults to the lightweight model without falling back to the installed document model', () => {
  const elements = new Map();
  const state = { health: { ollamaModels: ['qwen3.5:4b'] }, session: { llmModel: 'qwen3.5:4b' } };
  const context = vm.createContext({
    state,
    DEFAULT_RAW_TRANSLATION_MODEL: 'qwen2.5:1.5b-instruct',
    escapeHtml: (value) => value,
    t: (key, values = {}) => `${key}${values.model ? `: ${values.model}` : ''}`,
    $: (selector) => {
      if (!elements.has(selector)) elements.set(selector, { value: '', innerHTML: '', attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } });
      return elements.get(selector);
    },
  });
  vm.runInContext(`${functionSource('renderLlmModelSelectors')}\n${functionSource('renderRawTranslationModelStatus')}`, context);
  context.renderLlmModelSelectors({ preserveSelection: false });
  const raw = elements.get('#live-translation-model-select');
  assert.equal(raw.value, 'qwen2.5:1.5b-instruct');
  assert.equal(raw.attributes['aria-invalid'], 'true');
  assert.match(elements.get('#live-translation-model-status').textContent, /rawTranslationModelMissing: qwen2\.5:1\.5b-instruct/);
  assert.equal(elements.get('#llm-model-select').value, 'qwen3.5:4b');

  state.session.liveTranslationModel = 'custom-small:latest';
  context.renderLlmModelSelectors({ preserveSelection: false });
  assert.equal(raw.value, 'custom-small:latest');
  assert.match(raw.innerHTML, /custom-small:latest/);
  state.health.ollamaModels.push('custom-small:latest');
  context.renderLlmModelSelectors({ preserveSelection: false });
  assert.equal(raw.attributes['aria-invalid'], 'false');
  assert.match(elements.get('#live-translation-model-status').textContent, /rawTranslationModelReady/);

  raw.value = 'qwen3.5:4b';
  context.renderLlmModelSelectors({ preserveSelection: true });
  assert.equal(raw.value, 'qwen3.5:4b', 'an explicit unsaved model selection survives renderer updates');
  assert.match(html, /id="live-translation-model-select"/);
  assert.match(source, /liveTranslationModel: requestedLiveTranslationModel/);
});

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WhisperModelManager } from '../src/providers/whisper-models.js';
import { startServer } from '../src/server.js';

const providers = {
  stt: { async transcribe() { throw new Error('not used'); } },
  llm: { async listModels() { return []; }, async generate() { throw new Error('not used'); } },
  materials: { async extract() { throw new Error('not used'); } },
};

test('server releases its socket even when Ollama bootstrap shutdown fails', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-server-stop-failure-'));
  const runtime = await startServer({
    ...providers, port: 0, dataRoot: root, settingsPath: path.join(root, 'settings.json'),
    ollamaBootstrap: { async stop() { throw new Error('cleanup failure'); } },
  });
  t.after(async () => {
    runtime.server.closeAllConnections();
    runtime.server.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await assert.rejects(runtime.stop(), /shutdown failed/i);
  assert.equal(runtime.server.listening, false);
});

test('desktop Ollama bootstrap status is exposed and a failed first run can be retried', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-server-ollama-bootstrap-'));
  let status = 'failed';
  let starts = 0;
  let stops = 0;
  const ollamaBootstrap = {
    snapshot() { return { status, automatic: true, model: 'qwen3.5:4b', error: status === 'failed' ? 'offline' : null }; },
    ensureReady() { starts += 1; status = 'checking'; },
    stop() { stops += 1; },
  };
  const runtime = await startServer({
    ...providers,
    ollamaBootstrap,
    port: 0,
    dataRoot: root,
    settingsPath: path.join(root, 'settings.json'),
  });
  t.after(async () => {
    await runtime.stop().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });

  const health = await fetch(`${runtime.url}/api/health`).then((response) => response.json());
  assert.equal(health.ollamaBootstrap.status, 'failed');
  const retriedResponse = await fetch(`${runtime.url}/api/ollama/bootstrap`, { method: 'POST' });
  assert.equal(retriedResponse.status, 202);
  assert.equal((await retriedResponse.json()).status, 'checking');
  assert.equal(starts, 1);
  await runtime.stop();
  assert.equal(stops, 1);
});

test('new lectures default to English and expose the focused transcription language choices', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-server-language-default-'));
  const runtime = await startServer({ ...providers, port: 0, dataRoot: root, settingsPath: path.join(root, 'settings.json') });
  t.after(async () => {
    await runtime.stop().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });

  const health = await fetch(`${runtime.url}/api/health`).then((response) => response.json());
  assert.deepEqual(health.languages.slice(0, 4), ['en', 'zh', 'ms', 'auto']);
  const session = await fetch(`${runtime.url}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'English by default' }),
  }).then((response) => response.json());
  assert.equal(session.language, 'en');
});

test('packaged Base-only Whisper runtime enables staged Version C dictation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-server-base-only-'));
  const stt = {
    async status() {
      return {
        ready: true,
        installedModels: ['base'],
        models: { base: true },
        modelStates: { base: { id: 'base', state: 'ready' } },
      };
    },
    async transcribe(_audioPath, options) {
      return { content: `${options.stage} speech.`, language: 'en', segments: [], provider: 'base-only-test', model: options.model };
    },
  };
  const runtime = await startServer({ ...providers, stt, port: 0, dataRoot: root, settingsPath: path.join(root, 'settings.json') });
  t.after(async () => {
    await runtime.stop().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const session = await fetch(`${runtime.url}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Base-only live test', language: 'en' }),
  }).then((response) => response.json());
  const started = await fetch(`${runtime.url}/api/sessions/${session.id}/dictation/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language: 'en' }),
  });
  assert.equal(started.status, 201);
  const dictation = await started.json();
  assert.equal(dictation.stagedAsr, true);
  assert.deepEqual(dictation.asrModels, { provisional: 'base', revised: 'base', highQuality: 'base' });
});

function silentWav(samples = 16_000) {
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

test('workspace settings can be viewed, changed, and restored after restart', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-server-root-'));
  const moved = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-server-moved-'));
  const settingsPath = path.join(root, 'app-settings.json');

  let first = await startServer({ ...providers, port: 0, dataRoot: root, settingsPath });
  let restarted;
  t.after(async () => {
    await first?.stop().catch(() => {});
    await restarted?.stop().catch(() => {});
    await Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(moved, { recursive: true, force: true })]);
  });
  const settings = await fetch(`${first.url}/api/settings`).then((response) => response.json());
  assert.equal(settings.storagePath, path.resolve(root));
  assert.equal(settings.appLanguage, 'zh-CN');
  const created = await fetch(`${first.url}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Persisted before move' }),
  }).then((response) => response.json());
  const changed = await fetch(`${first.url}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ storagePath: moved }),
  }).then((response) => response.json());
  assert.equal(changed.storagePath, path.resolve(moved));
  const movedSessions = await fetch(`${first.url}/api/sessions`).then((response) => response.json());
  assert.equal(movedSessions.some((session) => session.id === created.id), true);

  await first.stop();
  first = null;
  restarted = await startServer({ ...providers, port: 0, defaultDataRoot: root, settingsPath });
  const restored = await fetch(`${restarted.url}/api/settings`).then((response) => response.json());
  assert.equal(restored.storagePath, path.resolve(moved));
  assert.equal(restored.appLanguage, 'zh-CN');
});

test('transcription stage models persist, reject unavailable choices, and drive restarted runtime calls', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-server-asr-settings-'));
  const settingsPath = path.join(root, 'app-settings.json');
  const allModels = ['tiny', 'base', 'small', 'large'];
  const installed = new Set(['tiny', 'base', 'small']);
  const calls = [];
  const stt = {
    async status() {
      return {
        ready: true,
        registry: allModels.map((id) => ({ id, label: id })),
        installedModels: allModels.filter((id) => installed.has(id)),
        models: Object.fromEntries(allModels.map((id) => [id, installed.has(id)])),
        modelStates: Object.fromEntries(allModels.map((id) => [id, { id, state: installed.has(id) ? 'ready' : 'missing' }])),
      };
    },
    async startModelInstall(id) {
      installed.add(id);
      return { id, state: 'ready', installed: true };
    },
    async transcribe(_audioPath, options) {
      calls.push({ ...options });
      return { content: `${options.stage}:${options.model}`, language: 'en', segments: [], provider: 'settings-test', model: options.model };
    },
  };
  const llm = {
    async listModels() { return ['settings-test:1b']; },
    async generate({ model }) { return { content: 'translated', provider: 'settings-test', model }; },
  };

  let runtime = await startServer({ ...providers, stt, llm, port: 0, dataRoot: root, settingsPath });
  t.after(async () => {
    await runtime?.stop().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const firstSelection = { provisional: 'tiny', revised: 'base', highQuality: 'small' };
  const selected = await fetch(`${runtime.url}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ asrModels: firstSelection }),
  });
  assert.equal(selected.status, 200);
  assert.deepEqual((await selected.json()).asrModels, firstSelection);

  const switchedSelection = { provisional: 'base', revised: 'small', highQuality: 'tiny' };
  const switched = await fetch(`${runtime.url}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ asrModels: switchedSelection }),
  });
  assert.equal(switched.status, 200);
  assert.deepEqual((await switched.json()).asrModels, switchedSelection);

  const unavailable = await fetch(`${runtime.url}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ asrModels: { ...switchedSelection, highQuality: 'large' } }),
  });
  assert.equal(unavailable.status, 400);
  assert.equal((await unavailable.json()).code, 'STT_MODEL_NOT_INSTALLED');
  assert.deepEqual(await fetch(`${runtime.url}/api/settings`).then((response) => response.json()).then((value) => value.asrModels), switchedSelection);

  await fetch(`${runtime.url}/api/stt/models/large/install`, { method: 'POST' });
  assert.deepEqual(await fetch(`${runtime.url}/api/settings`).then((response) => response.json()).then((value) => value.asrModels), switchedSelection);

  await runtime.stop();
  runtime = null;
  runtime = await startServer({ ...providers, stt, llm, port: 0, dataRoot: root, settingsPath });
  const reopened = await fetch(`${runtime.url}/api/settings`).then((response) => response.json());
  assert.deepEqual(reopened.asrModels, switchedSelection);

  const session = await fetch(`${runtime.url}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Selected ASR runtime', language: 'en' }),
  }).then((response) => response.json());
  const started = await fetch(`${runtime.url}/api/sessions/${session.id}/dictation/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language: 'en' }),
  }).then((response) => response.json());
  assert.deepEqual(started.asrModels, switchedSelection);
  const chunk = await fetch(`${runtime.url}/api/sessions/${session.id}/dictation/chunks?sequence=0&startMs=0&endMs=1000&speech=1&boundary=stop`, {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: silentWav(),
  });
  assert.equal(chunk.status, 200);
  const finalized = await fetch(`${runtime.url}/api/sessions/${session.id}/dictation/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(finalized.status, 200);
  await runtime.handler.idle();
  assert.deepEqual(calls.map(({ stage }) => stage), ['provisional']);
  const improved = await fetch(`${runtime.url}/api/sessions/${session.id}/asr/revise`, { method: 'POST' });
  assert.equal(improved.status, 202);
  await runtime.handler.idle();
  assert.deepEqual(calls.map(({ stage }) => stage), ['provisional', 'revised']);
  const quality = await fetch(`${runtime.url}/api/sessions/${session.id}/artifacts/highQualityTranscript/ensure`, { method: 'POST' });
  assert.equal(quality.status, 200);
  assert.deepEqual(calls.slice(-3).map(({ stage, model }) => [stage, model]).sort(), [
    ['highQuality', 'tiny'],
    ['provisional', 'base'],
    ['revised', 'small'],
  ].sort());
});

test('app language persists across restart without changing lecture-processing languages', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-server-language-'));
  const settingsPath = path.join(root, 'app-settings.json');

  let first = await startServer({ ...providers, port: 0, dataRoot: root, settingsPath });
  let restarted;
  t.after(async () => {
    await first?.stop().catch(() => {});
    await restarted?.stop().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const session = await fetch(`${first.url}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Language separation', language: 'zh', targetLanguage: 'Japanese' }),
  }).then((response) => response.json());
  await first.store.setArtifact(session.id, 'rawTranscript', { content: 'Raw source.', source: 'manual-edit' }, { preserve: true });
  await first.store.setArtifact(session.id, 'cleanedTranscript', { content: 'Cleaned source.', source: 'manual-edit' });
  await first.store.setArtifact(session.id, 'notes', { content: '# Notes', source: 'manual-edit' });
  await first.store.setArtifact(session.id, 'outline', { content: '# Outline', source: 'manual-edit' });
  await first.store.saveRawTranslation(session.id, {
    targetLanguage: 'Japanese',
    segments: [{ id: 'raw-unit', sourceText: 'Raw source.', sourceRevision: 'raw-source', translatedText: '原文。', status: 'translated' }],
  }, { expectedTargetLanguage: 'Japanese' });
  for (const [key, content] of [
    ['cleanedTranslation', '整文。'],
    ['notesTranslation', '# ノート'],
    ['outlineTranslation', '# アウトライン'],
  ]) {
    await first.store.setArtifact(session.id, key, { content, source: 'manual-edit', targetLanguage: 'Japanese' });
  }
  const artifactsBeforeLocaleChange = structuredClone((await first.store.get(session.id)).artifacts);

  const changed = await fetch(`${first.url}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appLanguage: 'zh-CN' }),
  }).then((response) => response.json());
  assert.equal(changed.appLanguage, 'zh-CN');
  const unchangedSession = await fetch(`${first.url}/api/sessions/${session.id}`).then((response) => response.json());
  assert.equal(unchangedSession.language, 'zh');
  assert.equal(unchangedSession.targetLanguage, 'Japanese');
  assert.deepEqual(unchangedSession.artifacts, artifactsBeforeLocaleChange);

  await first.stop();
  first = null;
  restarted = await startServer({ ...providers, port: 0, defaultDataRoot: root, settingsPath });
  const restored = await fetch(`${restarted.url}/api/settings`).then((response) => response.json());
  assert.equal(restored.appLanguage, 'zh-CN');
  const reopened = await fetch(`${restarted.url}/api/sessions/${session.id}`).then((response) => response.json());
  assert.equal(reopened.language, 'zh');
  assert.equal(reopened.targetLanguage, 'Japanese');
});

test('Whisper model installation is started through the backend API', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-server-model-api-'));
  const model = { id: 'base', label: 'Base', state: 'missing', installed: false, canInstall: true };
  const stt = {
    async transcribe() { throw new Error('not used'); },
    async status() {
      return {
        ready: true,
        models: { tiny: true, base: model.state === 'ready' },
        modelStates: { tiny: { id: 'tiny', state: 'ready' }, base: { ...model } },
        installedModels: model.state === 'ready' ? ['tiny', 'base'] : ['tiny'],
      };
    },
    async startModelInstall(id) {
      assert.equal(id, 'base');
      model.state = 'downloading';
      model.canInstall = false;
      return { ...model, progress: 0 };
    },
  };
  const runtime = await startServer({ ...providers, stt, port: 0, dataRoot: root, settingsPath: path.join(root, 'settings.json') });
  t.after(async () => {
    await runtime.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  const startedResponse = await fetch(`${runtime.url}/api/stt/models/base/install`, { method: 'POST' });
  assert.equal(startedResponse.status, 202);
  const started = await startedResponse.json();
  assert.equal(started.model.state, 'downloading');
  const status = await fetch(`${runtime.url}/api/stt/models`).then((response) => response.json());
  assert.equal(status.modelStates.base.state, 'downloading');
});

test('completed model installation is returned by status refresh without changing ASR selections', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-server-model-complete-'));
  const installRoot = path.join(root, 'user data', 'models', 'whisper.cpp');
  const content = Buffer.from('installed-small-model');
  const small = {
    id: 'small',
    label: 'Small',
    description: 'test model',
    filename: 'ggml-small.bin',
    bytes: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    url: 'https://example.invalid/small',
  };
  const manager = new WhisperModelManager({
    bundledModelRoot: path.join(root, 'packaged runtime', 'models'),
    installRoot,
    registry: [small],
    logger: { error() {} },
    downloader: async ({ destination }) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await fs.writeFile(destination, content);
    },
  });
  const stt = {
    async transcribe() { throw new Error('not used'); },
    async startModelInstall(id) { return manager.startInstall(id); },
    async status() {
      const status = await manager.status();
      return {
        ...status,
        ready: true,
        registry: [{ id: 'base', label: 'Base' }, ...status.registry],
        models: { base: true, ...status.models },
        modelStates: { base: { id: 'base', state: 'ready', installed: true }, ...status.modelStates },
        installedModels: ['base', ...status.installedModels],
      };
    },
  };
  const runtime = await startServer({ ...providers, stt, port: 0, dataRoot: root, settingsPath: path.join(root, 'settings.json') });
  t.after(async () => {
    await runtime.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  const selectionBefore = await fetch(`${runtime.url}/api/settings`).then((response) => response.json()).then((settings) => settings.asrModels);

  const started = await fetch(`${runtime.url}/api/stt/models/small/install`, { method: 'POST' });
  assert.equal(started.status, 202);
  assert.equal((await started.json()).model.state, 'downloading');

  let refreshed;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    refreshed = await fetch(`${runtime.url}/api/stt/models`).then((response) => response.json());
    if (refreshed.modelStates.small.state === 'ready') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(refreshed.modelStates.small.state, 'ready');
  assert.equal(refreshed.modelStates.small.path, path.join(installRoot, small.filename));
  assert.equal(await fs.readFile(path.join(installRoot, small.filename), 'utf8'), content.toString());
  const installRecord = JSON.parse(await fs.readFile(path.join(installRoot, `${small.filename}.install.json`), 'utf8'));
  assert.deepEqual(
    { id: installRecord.id, filename: installRecord.filename, bytes: installRecord.bytes, sha256: installRecord.sha256 },
    { id: small.id, filename: small.filename, bytes: small.bytes, sha256: small.sha256 },
  );
  assert.deepEqual(
    await fetch(`${runtime.url}/api/settings`).then((response) => response.json()).then((settings) => settings.asrModels),
    selectionBefore,
  );
});

test('no-speech finalization returns a JSON error without hanging the HTTP server', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-server-no-speech-'));
  const models = ['base', 'small', 'medium', 'turbo', 'large'];
  const stt = {
    async status() {
      return {
        ready: true,
        installedModels: models,
        models: Object.fromEntries(models.map((model) => [model, true])),
        modelStates: Object.fromEntries(models.map((model) => [model, { id: model, state: 'ready' }])),
      };
    },
    async transcribe() { throw new Error('Energy VAD should skip silent inference'); },
  };
  const runtime = await startServer({
    ...providers,
    stt,
    port: 0,
    dataRoot: root,
    settingsPath: path.join(root, 'settings.json'),
  });
  t.after(async () => {
    await runtime.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  const session = await fetch(`${runtime.url}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Silent lecture', language: 'en' }),
  }).then((response) => response.json());
  await fetch(`${runtime.url}/api/sessions/${session.id}/dictation/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'base', language: 'en' }),
  });
  const chunk = await fetch(`${runtime.url}/api/sessions/${session.id}/dictation/chunks?sequence=0&startMs=0&endMs=1000&speech=0&boundary=stop`, {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: silentWav(),
  });
  assert.equal(chunk.status, 200);

  const finalized = await fetch(`${runtime.url}/api/sessions/${session.id}/dictation/finalize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(finalized.status, 422);
  assert.deepEqual(await finalized.json(), {
    error: 'Recording was saved, but Whisper found no speech.',
    code: 'NO_SPEECH',
  });
  assert.equal((await fetch(`${runtime.url}/api/health`)).status, 200);
});

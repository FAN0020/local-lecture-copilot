import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { SessionStore } from '../src/store.js';
import { LocalMaterialExtractor } from '../src/providers/material.js';

const MODEL_IDS = ['base', 'small', 'medium', 'turbo', 'large'];

function runtimeStatus(installedModels = MODEL_IDS) {
  return {
    ready: true,
    installedModels,
    models: Object.fromEntries(MODEL_IDS.map((id) => [id, installedModels.includes(id)])),
    registry: MODEL_IDS.map((id) => ({ id, label: id })),
    modelStates: Object.fromEntries(MODEL_IDS.map((id) => [id, { id, state: installedModels.includes(id) ? 'ready' : 'missing' }])),
  };
}

function sequenceFromPath(audioPath) {
  return Number(path.basename(audioPath).match(/chunk-(\d+)/)?.[1] || 0);
}

class StagedSTT {
  constructor({ delays = {}, installedModels = MODEL_IDS, fail = () => false } = {}) {
    this.delays = delays;
    this.installedModels = installedModels;
    this.fail = fail;
    this.calls = [];
    this.active = 0;
    this.maxActive = 0;
  }

  async status() { return runtimeStatus(this.installedModels); }

  async transcribe(audioPath, options) {
    const sequence = sequenceFromPath(audioPath);
    this.calls.push({ audioPath, ...options, sequence });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.delays[options.stage]) await new Promise((resolve) => setTimeout(resolve, this.delays[options.stage]));
      if (this.fail({ ...options, sequence })) throw Object.assign(new Error(`${options.stage} ${options.model} unavailable`), { code: 'STT_MODEL_MISSING', status: 503 });
      const prefix = options.stage === 'provisional' ? 'Draft' : options.stage === 'revised' ? 'Revised' : 'Quality';
      const content = `${prefix} segment ${sequence}.`;
      return {
        content,
        language: options.language === 'auto' ? 'en' : options.language,
        segments: [{ start: 0, end: 4, text: content }],
        provider: 'staged-test-stt',
        model: options.model,
      };
    } finally {
      this.active -= 1;
    }
  }
}

class PipelineLLM {
  constructor() { this.rawSources = []; this.calls = []; }
  async listModels() { return ['pipeline-test:1b']; }
  async generate(args) {
    this.calls.push(args);
    if (args.prompt.includes('CURRENT SENTENCE:')) {
      const source = args.prompt.split('\nCURRENT SENTENCE:\n')[1];
      this.rawSources.push(source);
      return { content: `Translated ${source}`, provider: 'pipeline-llm', model: args.model };
    }
    if (args.prompt.startsWith('Transcript:\n')) {
      const target = args.prompt.slice('Transcript:\n'.length);
      return { content: target, provider: 'pipeline-llm', model: args.model };
    }
    if (args.requestType === 'cleanup') return { content: '{"edits":[]}', provider: 'pipeline-llm', model: args.model };
    return { content: '# Generated', provider: 'pipeline-llm', model: args.model };
  }
}

function wavChunk(samples = 32_000) {
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

async function requestResult(handler, endpoint, options = {}) {
  const input = options.body === undefined ? [] : [Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body)];
  const req = Readable.from(input);
  req.url = endpoint;
  req.method = options.method || 'GET';
  req.headers = Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      status: 200,
      headers: {},
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, headers: this.headers, body: Buffer.concat(chunks) }); },
    };
    handler(req, res).catch(reject);
  });
  return { ...response, json: JSON.parse(response.body.toString('utf8')) };
}

async function request(handler, endpoint, options = {}) {
  const response = await requestResult(handler, endpoint, options);
  assert.ok(response.status >= 200 && response.status < 300, `${response.status}: ${JSON.stringify(response.json)}`);
  return response.json;
}

async function waitFor(check, timeout = 2500) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('Timed out waiting for staged ASR state');
}

async function createHarness(t, stt = new StagedSTT(), llm = new PipelineLLM(), settings = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-multistage-asr-'));
  const store = new SessionStore(root);
  await store.init();
  const handler = createApp({ store, stt, llm, materials: new LocalMaterialExtractor(), settings });
  t.after(async () => {
    await handler.idle();
    await handler.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const session = await request(handler, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language: 'en' }) });
  return { root, store, handler, session, stt, llm };
}

async function start(handler, sessionId) {
  return request(handler, `/api/sessions/${sessionId}/dictation/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'base', language: 'en' }),
  });
}

async function sendChunk(handler, sessionId, sequence, startMs = sequence * 2000, endMs = startMs + 2000) {
  return request(handler, `/api/sessions/${sessionId}/dictation/chunks?sequence=${sequence}&startMs=${startMs}&endMs=${endMs}&speech=1&boundary=speech-boundary`, {
    method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wavChunk(),
  });
}

async function seedStagedSegments(store, sessionId, count, { revised = false } = {}) {
  await store.startDictation(sessionId, {
    model: 'base', language: 'en', stagedAsr: true,
    asrModels: { provisional: 'small', revised: 'turbo', highQuality: 'large' },
    asrFallbacks: { provisional: ['small'], revised: ['turbo'], highQuality: ['large'] },
  });
  const chunks = [];
  for (let sequence = 0; sequence < count; sequence += 1) {
    chunks.push(await store.saveDictationChunk(sessionId, sequence, wavChunk(), {
      startMs: sequence * 2000,
      endMs: sequence * 2000 + 2000,
      boundary: 'speech-boundary',
    }));
  }
  for (const [sequence, chunk] of chunks.entries()) {
    const provisional = await store.beginTranscriptStage(sessionId, chunk.segmentId, 'provisional');
    await store.completeTranscriptStage(sessionId, chunk.segmentId, 'provisional', {
      content: `Draft segment ${sequence}.`, language: 'en', provider: 'seed', model: 'small',
    }, { token: provisional.token, sourceRevision: provisional.sourceRevision });
    if (revised) {
      const revision = await store.beginTranscriptStage(sessionId, chunk.segmentId, 'revised');
      await store.completeTranscriptStage(sessionId, chunk.segmentId, 'revised', {
        content: `Revised segment ${sequence}.`, language: 'en', provider: 'seed', model: 'turbo',
      }, { token: revision.token, sourceRevision: revision.sourceRevision });
    }
  }
  return chunks;
}

test('Raw chunks run material RAG automatically while Whisper revision waits for Improve transcript', async (t) => {
  const stt = new StagedSTT();
  const { handler, session, store } = await createHarness(t, stt, new PipelineLLM());
  await start(handler, session.id);
  await sendChunk(handler, session.id, 0);

  const automaticallyRefined = await waitFor(async () => {
    const current = await store.get(session.id);
    return current.artifacts.cleanedTranscript?.pipelineRevision === 'C6-raw-rag-v1'
      && current.activityLog.some((entry) => entry.code === 'revision-retrieval-window') ? current : null;
  });
  assert.equal(automaticallyRefined.artifacts.cleanedTranscript.content, 'Draft segment 0.');
  assert.equal(automaticallyRefined.transcriptSegments[0].stages.revised.status, 'deferred');
  assert.deepEqual(automaticallyRefined.asr.backlog.refinement, { queued: 0, active: 0, total: 0 });
  assert.equal(stt.calls.filter((call) => call.stage === 'revised').length, 0);
  assert.ok(automaticallyRefined.activityLog.some((entry) => entry.code === 'revision-retrieval-window'));

  await request(handler, `/api/sessions/${session.id}/dictation/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  await request(handler, `/api/sessions/${session.id}/asr/revise`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  await handler.idle();

  const manuallyImproved = await store.get(session.id);
  assert.equal(stt.calls.filter((call) => call.stage === 'revised').length, 1);
  assert.equal(manuallyImproved.artifacts.rawTranscript.content, 'Revised segment 0.');
  assert.equal(manuallyImproved.artifacts.cleanedTranscript.content, 'Revised segment 0.');
});

test('Version C keeps stable provisional → manual revised Raw segments and never auto-runs high-quality ASR', async (t) => {
  const stt = new StagedSTT({ delays: { revised: 35, highQuality: 20 } });
  const llm = new PipelineLLM();
  const { handler, session } = await createHarness(t, stt, llm);
  await request(handler, `/api/sessions/${session.id}/live-translation`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"enabled":true}',
  });
  const dictation = await start(handler, session.id);
  assert.deepEqual(dictation.asrModels, { provisional: 'base', revised: 'turbo', highQuality: 'large' });

  await sendChunk(handler, session.id, 0, 0, 2000);
  const provisional = await waitFor(async () => {
    const current = await request(handler, `/api/sessions/${session.id}`);
    return current.transcriptSegments[0].versions.provisional ? current : null;
  });
  assert.equal(provisional.artifacts.rawTranscript.content, 'Draft segment 0.');
  assert.equal(provisional.transcriptSegments.length, 1);
  const stableId = provisional.transcriptSegments[0].id;
  assert.equal(provisional.transcriptSegments[0].start, 0);
  assert.equal(provisional.transcriptSegments[0].end, 2);
  assert.equal(provisional.transcriptSegments[0].boundary, 'speech-boundary');
  const provisionalTranslation = await waitFor(async () => {
    const current = await request(handler, `/api/sessions/${session.id}`);
    const unit = current.artifacts.rawTranslation?.segments?.[0];
    return unit?.sourceText === 'Draft segment 0.' && unit.status === 'translated' ? unit : null;
  });
  assert.equal(provisionalTranslation.translatedText, 'Translated Draft segment 0.');

  assert.equal(provisional.transcriptSegments[0].stages.revised.status, 'deferred');
  assert.equal(stt.calls.some((call) => call.stage === 'revised'), false);

  await request(handler, `/api/sessions/${session.id}/dictation/finalize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await request(handler, `/api/sessions/${session.id}/asr/revise`, { method: 'POST', body: '{}' });
  const revised = await waitFor(async () => {
    const current = await request(handler, `/api/sessions/${session.id}`);
    return current.transcriptSegments[0].versions.revised ? current : null;
  });
  assert.equal(revised.transcriptSegments[0].id, stableId);
  assert.equal(revised.artifacts.rawTranscript.content, 'Revised segment 0.');
  assert.equal(revised.artifacts.rawTranscript.content.includes('Draft'), false);

  assert.equal(stt.calls.some((call) => call.stage === 'highQuality'), false);

  const rawTranslation = await request(handler, `/api/sessions/${session.id}/artifacts/rawTranslation/ensure`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(rawTranslation.segments[0].sourceText, 'Revised segment 0.');
  assert.equal(rawTranslation.segments[0].translatedText, 'Translated Revised segment 0.');
  assert.equal(llm.rawSources.some((source) => source.includes('Draft')), true);
  assert.equal(llm.rawSources.some((source) => source.includes('Revised')), true);

  const cleaned = await request(handler, `/api/sessions/${session.id}/artifacts/cleanedTranscript/ensure`, { method: 'POST', body: '{}' });
  assert.equal(cleaned.content, 'Revised segment 0.');
  assert.equal(cleaned.dependsOn.key, 'rawTranscript');
  assert.equal(cleaned.sourceArtifact, 'rawTranscript');
  assert.equal(cleaned.revisionInput, 'rawTranscript');
  assert.equal(cleaned.retrievalMethod, 'lexical-anchors');
  assert.equal(cleaned.vectorized, false);
  assert.deepEqual(stt.calls.map((call) => [call.stage, call.model]).slice(0, 2), [
    ['provisional', 'base'], ['revised', 'turbo'],
  ]);
});

test('one selected language reaches live, Raw refinement, and high-quality Whisper stages', async (t) => {
  const stt = new StagedSTT();
  const { handler, session } = await createHarness(t, stt);
  await request(handler, `/api/sessions/${session.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language: 'ms' }),
  });
  await request(handler, `/api/sessions/${session.id}/dictation/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'base', language: 'ms' }),
  });
  await sendChunk(handler, session.id, 0);
  await request(handler, `/api/sessions/${session.id}/dictation/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  await request(handler, `/api/sessions/${session.id}/asr/revise`, { method: 'POST', body: '{}' });
  await handler.idle();
  await request(handler, `/api/sessions/${session.id}/artifacts/highQualityTranscript/ensure`, { method: 'POST' });

  const callsByStage = Object.fromEntries(stt.calls.map((call) => [call.stage, call]));
  assert.equal(callsByStage.provisional.language, 'ms');
  assert.equal(callsByStage.revised.language, 'ms');
  assert.equal(callsByStage.highQuality.language, 'ms');
});

test('persisted Version C live and Raw stage settings are passed to Whisper without automatic high-quality work', async (t) => {
  const stt = new StagedSTT();
  const asrModels = { provisional: 'base', revised: 'small', highQuality: 'medium' };
  const settings = { async get() { return { asrModels }; } };
  const { handler, session } = await createHarness(t, stt, new PipelineLLM(), settings);
  const dictation = await start(handler, session.id);
  assert.deepEqual(dictation.asrModels, asrModels);
  await sendChunk(handler, session.id, 0);
  await request(handler, `/api/sessions/${session.id}/dictation/finalize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await request(handler, `/api/sessions/${session.id}/asr/revise`, { method: 'POST', body: '{}' });
  await handler.idle();
  assert.deepEqual(stt.calls.map(({ stage, model }) => [stage, model]).slice(0, 2), [
    ['provisional', 'base'],
    ['revised', 'small'],
  ]);
  assert.equal(stt.calls.some((call) => call.stage === 'highQuality'), false);
});

test('segment projection stays ordered without duplication and stale ASR writes are rejected', async (t) => {
  const { store, session } = await createHarness(t);
  await store.startDictation(session.id, {
    model: 'base', language: 'en', stagedAsr: true,
    asrModels: { provisional: 'small', revised: 'turbo', highQuality: 'large' },
    asrFallbacks: { provisional: ['small'], revised: ['turbo'], highQuality: ['large'] },
  });
  const secondChunk = await store.saveDictationChunk(session.id, 1, wavChunk(), { startMs: 2000, endMs: 4000 });
  const firstChunk = await store.saveDictationChunk(session.id, 0, wavChunk(), { startMs: 0, endMs: 2000 });
  const sessionWithSegments = await store.get(session.id);
  const firstSegment = sessionWithSegments.transcriptSegments.find((segment) => segment.id === firstChunk.segmentId);
  const secondSegment = sessionWithSegments.transcriptSegments.find((segment) => segment.id === secondChunk.segmentId);
  const apply = async (segment, stage, content, force = false) => {
    const begun = await store.beginTranscriptStage(session.id, segment.id, stage, { force });
    return store.completeTranscriptStage(session.id, segment.id, stage, { content, model: stage === 'provisional' ? 'small' : 'turbo', provider: 'test' }, { token: begun.token, sourceRevision: begun.sourceRevision });
  };
  await apply(firstSegment, 'provisional', 'First draft.');
  await apply(secondSegment, 'provisional', 'Second draft.');
  await apply(firstSegment, 'revised', 'First revised.');
  const beforeStale = await store.beginTranscriptStage(session.id, firstSegment.id, 'revised', { force: true });
  const latest = await store.beginTranscriptStage(session.id, firstSegment.id, 'revised', { force: true });
  await assert.rejects(
    store.completeTranscriptStage(session.id, firstSegment.id, 'revised', { content: 'Stale text.' }, { token: beforeStale.token, sourceRevision: beforeStale.sourceRevision }),
    (error) => error.code === 'STALE_ASR_RESULT',
  );
  await store.completeTranscriptStage(session.id, firstSegment.id, 'revised', { content: 'Newest text.', model: 'turbo' }, { token: latest.token, sourceRevision: latest.sourceRevision });
  const restored = await store.get(session.id);
  assert.equal(restored.transcriptSegments.length, 2);
  assert.equal(new Set(restored.transcriptSegments.map((segment) => segment.id)).size, 2);
  assert.equal(restored.artifacts.rawTranscript.content, 'Newest text. Second draft.');
  assert.equal(restored.artifacts.rawTranscript.content.includes('Stale text'), false);
});

test('multiple revised segments use one actual STT process at a time', async (t) => {
  const stt = new StagedSTT({ delays: { revised: 30 } });
  const { store, handler, session } = await createHarness(t, stt, new PipelineLLM());
  await seedStagedSegments(store, session.id, 3);
  await store.finalizeDictation(session.id);
  await request(handler, `/api/sessions/${session.id}/asr/revise`, { method: 'POST', body: '{}' });
  await handler.idle();
  assert.equal(stt.calls.filter((call) => call.stage === 'revised').length, 3);
  assert.equal(stt.maxActive, 1);
});

test('concurrent high-quality artifact ensures are serialized and deduplicated', async (t) => {
  const stt = new StagedSTT({ delays: { highQuality: 30 } });
  const { store, handler, session } = await createHarness(t, stt, new PipelineLLM());
  await seedStagedSegments(store, session.id, 3, { revised: true });
  await store.markDictationFinalizing(session.id);
  await store.finalizeDictation(session.id);
  const endpoint = `/api/sessions/${session.id}/artifacts/highQualityTranscript/ensure`;
  const responses = await Promise.all(Array.from({ length: 5 }, () => requestResult(handler, endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })));
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 200, 200]);
  assert.equal(stt.calls.filter((call) => call.stage === 'highQuality').length, 3);
  assert.equal(stt.maxActive, 1);
});

test('finalize stays responsive and leaves revised and high-quality STT deferred', async (t) => {
  const stt = new StagedSTT({ delays: { revised: 50, highQuality: 50 } });
  const { store, handler, session } = await createHarness(t, stt, new PipelineLLM());
  await seedStagedSegments(store, session.id, 3);
  const startedAt = Date.now();
  await request(handler, `/api/sessions/${session.id}/dictation/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.ok(Date.now() - startedAt < 500, 'finalize waited for background revised/HQ inference');
  await handler.inferenceScheduler.idle();
  const completed = await store.get(session.id);
  assert.equal(completed.transcriptSegments.every((segment) => !segment.versions.revised
    && segment.stages.revised.status === 'deferred'), true);
  assert.equal(stt.calls.filter((call) => call.stage === 'revised').length, 0);
  assert.equal(stt.calls.filter((call) => call.stage === 'highQuality').length, 0);
});

test('repeated session GETs never enqueue deferred Raw revision or high-quality ASR', async (t) => {
  const stt = new StagedSTT({ delays: { revised: 30, highQuality: 30 } });
  const { store, handler, session } = await createHarness(t, stt, new PipelineLLM());
  await seedStagedSegments(store, session.id, 2);
  await store.markDictationFinalizing(session.id);
  await store.finalizeDictation(session.id);
  await Promise.all(Array.from({ length: 30 }, () => request(handler, `/api/sessions/${session.id}`)));
  await handler.inferenceScheduler.idle();
  assert.equal(stt.calls.filter((call) => call.stage === 'revised').length, 0);
  assert.equal(stt.calls.filter((call) => call.stage === 'highQuality').length, 0);
  const restored = await store.get(session.id);
  assert.equal(Math.max(...restored.transcriptSegments.map((segment) => segment.stages.revised.attempt)), 0);
  assert.equal(restored.transcriptSegments.every((segment) => segment.stages.revised.status === 'deferred'), true);
  assert.equal(restored.transcriptSegments.every((segment) => segment.stages.highQuality.status === 'skipped'), true);
});

test('the packaged recording flow can enable live translation before dictation starts', async (t) => {
  const { handler, session } = await createHarness(t);
  const enabled = await requestResult(handler, `/api/sessions/${session.id}/live-translation`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"enabled":true}',
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.json.liveTranslation.enabled, true);
  assert.equal(enabled.json.liveTranslation.status, 'idle');

  const dictation = await start(handler, session.id);
  assert.equal(dictation.status, 'recording');
});

test('the Improve transcript endpoint reruns saved revisions with the selected model', async (t) => {
  let revisedModel = 'base';
  const settings = { async get() { return { asrModels: { provisional: 'base', revised: revisedModel } }; } };
  const { store, handler, session, stt } = await createHarness(t, new StagedSTT(), new PipelineLLM(), settings);
  await start(handler, session.id);
  await sendChunk(handler, session.id, 0);
  await request(handler, `/api/sessions/${session.id}/dictation/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  await handler.idle();

  revisedModel = 'small';
  const response = await requestResult(handler, `/api/sessions/${session.id}/asr/revise`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(response.status, 202);
  assert.equal(response.json.processing.stage, 'revision');
  await handler.idle();

  const current = await store.get(session.id);
  assert.equal(current.transcriptSegments[0].versions.revised.model, 'small');
  assert.equal(stt.calls.filter((call) => call.stage === 'revised').length, 1);
  assert.equal(current.processing.status, 'success');
});

test('a 100-chunk CPU backlog persists audio while queue and retained job counts stay bounded', async (t) => {
  class BlockingSTT extends StagedSTT {
    async transcribe(audioPath, options) {
      const sequence = sequenceFromPath(audioPath);
      this.calls.push({ audioPath, ...options, sequence });
      this.active += 1;
      this.maxActive = Math.max(this.maxActive, this.active);
      try {
        await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
      } finally {
        this.active -= 1;
      }
    }
  }
  const stt = new BlockingSTT();
  const { store, handler, session } = await createHarness(t, stt, new PipelineLLM());
  await start(handler, session.id);
  let maximumQueued = 0;
  for (let sequence = 0; sequence < 100; sequence += 1) {
    await sendChunk(handler, session.id, sequence);
    maximumQueued = Math.max(maximumQueued, handler.inferenceScheduler.snapshot().queued);
  }
  const current = await store.get(session.id);
  const snapshot = handler.inferenceScheduler.snapshot();
  assert.equal(current.dictation.chunks.length, 100);
  assert.equal(current.dictation.chunks.every((chunk) => typeof chunk.storedPath === 'string' && !('buffer' in chunk) && !('audio' in chunk)), true);
  assert.equal(maximumQueued, 8);
  assert.equal(snapshot.active, 1);
  assert.equal(snapshot.queued, 8);
  assert.equal(snapshot.retained, 9);
  assert.equal(snapshot.dropped, 91);
  const runtime = await handler.runtimeSnapshot();
  assert.equal(runtime.audioChunks, 100);
  assert.equal(runtime.audioBytes, 100 * wavChunk().length);
  await handler.close();
  assert.equal(handler.inferenceScheduler.snapshot().retained, 0);
  assert.equal(stt.active, 0);
});

test('blocked background ASR is preempted and requeued without duplicate transcript results', async (t) => {
  class PreemptibleSTT extends StagedSTT {
    constructor() { super(); this.hqRuns = 0; this.hqAborts = 0; this.hqStarted = null; this.resolveHqStarted = null; this.hqStarted = new Promise((resolve) => { this.resolveHqStarted = resolve; }); }
    async transcribe(audioPath, options) {
      if (options.stage !== 'highQuality' || sequenceFromPath(audioPath) !== 0) return super.transcribe(audioPath, options);
      this.calls.push({ audioPath, ...options, sequence: 0 });
      this.hqRuns += 1;
      this.resolveHqStarted();
      if (this.hqRuns > 1) return { content: 'Quality segment 0.', language: 'en', segments: [], provider: 'preempt-test', model: options.model };
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          this.hqAborts += 1;
          reject(Object.assign(new Error('preempted'), { name: 'AbortError', code: 'ABORT_ERR' }));
        }, { once: true });
      });
    }
  }
  const stt = new PreemptibleSTT();
  const { store, handler, session } = await createHarness(t, stt, new PipelineLLM());
  await start(handler, session.id);
  await sendChunk(handler, session.id, 0);
  await request(handler, `/api/sessions/${session.id}/dictation/finalize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const highQualityEnsure = requestResult(handler, `/api/sessions/${session.id}/artifacts/highQualityTranscript/ensure`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  await stt.hqStarted;
  await start(handler, session.id);
  const started = Date.now();
  await sendChunk(handler, session.id, 0);
  const latency = Date.now() - started;
  assert.ok(latency < 500, `provisional request took ${latency}ms while HQ was active`);
  await waitFor(async () => {
    const current = await store.get(session.id);
    return current.transcriptSegments.length === 2 && current.transcriptSegments.at(-1).versions.provisional;
  });
  assert.equal(stt.hqAborts, 1);
  await waitFor(() => stt.hqRuns >= 2);
  const interruptedEnsure = await highQualityEnsure;
  assert.equal(interruptedEnsure.status, 422);
  await request(handler, `/api/sessions/${session.id}/dictation/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  await request(handler, `/api/sessions/${session.id}/artifacts/highQualityTranscript/ensure`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  await handler.inferenceScheduler.idle();
  assert.equal(handler.inferenceScheduler.snapshot().concurrency, 1);
  const completed = await store.get(session.id);
  assert.equal(stt.hqRuns, 3);
  assert.equal(completed.transcriptSegments.length, 2);
  assert.equal(new Set(completed.transcriptSegments.map((segment) => segment.id)).size, 2);
  assert.equal((completed.artifacts.highQualityTranscript.content.match(/Quality segment 0\./gu) || []).length, 2);
});

test('high-quality model failure falls back without losing live text; total failure remains retryable', async (t) => {
  const fallbackStt = new StagedSTT({ fail: ({ stage, model }) => stage === 'highQuality' && model === 'large' });
  const fallbackHarness = await createHarness(t, fallbackStt, new PipelineLLM());
  await start(fallbackHarness.handler, fallbackHarness.session.id);
  await sendChunk(fallbackHarness.handler, fallbackHarness.session.id, 0);
  await request(fallbackHarness.handler, `/api/sessions/${fallbackHarness.session.id}/dictation/finalize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const fallbackArtifact = await request(fallbackHarness.handler, `/api/sessions/${fallbackHarness.session.id}/artifacts/highQualityTranscript/ensure`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const fallback = fallbackArtifact.segments[0];
  assert.equal(fallback.model, 'turbo');

  const failedStt = new StagedSTT({ fail: ({ stage }) => stage === 'highQuality' });
  const failedHarness = await createHarness(t, failedStt, new PipelineLLM());
  await start(failedHarness.handler, failedHarness.session.id);
  await sendChunk(failedHarness.handler, failedHarness.session.id, 0);
  await request(failedHarness.handler, `/api/sessions/${failedHarness.session.id}/dictation/finalize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const comparison = await requestResult(failedHarness.handler, `/api/sessions/${failedHarness.session.id}/artifacts/highQualityTranscript/ensure`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(comparison.status, 503);
  assert.equal(comparison.json.code, 'HIGH_QUALITY_ASR_FAILED');
  const cleaned = await requestResult(failedHarness.handler, `/api/sessions/${failedHarness.session.id}/artifacts/cleanedTranscript/ensure`, { method: 'POST', body: '{}' });
  assert.equal(cleaned.status, 200);
  assert.equal(cleaned.json.content, 'Draft segment 0.');
  assert.equal(cleaned.json.dependsOn.key, 'rawTranscript');
  const preserved = await request(failedHarness.handler, `/api/sessions/${failedHarness.session.id}`);
  assert.equal(preserved.artifacts.rawTranscript.content, 'Draft segment 0.');
});

test('Version C stop/resume survives a store restart without automatic high-quality segments', async (t) => {
  const stt = new StagedSTT();
  const { root, store, handler, session } = await createHarness(t, stt, new PipelineLLM());
  await start(handler, session.id);
  await sendChunk(handler, session.id, 0);
  await request(handler, `/api/sessions/${session.id}/dictation/finalize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await handler.idle();

  const restarted = new SessionStore(root);
  await restarted.init();
  const restartedHandler = createApp({ store: restarted, stt, llm: new PipelineLLM(), materials: new LocalMaterialExtractor() });
  t.after(() => restartedHandler.idle());
  await start(restartedHandler, session.id);
  await sendChunk(restartedHandler, session.id, 0, 0, 2000);
  await request(restartedHandler, `/api/sessions/${session.id}/dictation/finalize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const restored = await restarted.get(session.id);
  assert.equal(restored.recordingSegments.length, 2);
  assert.equal(restored.transcriptSegments.length, 2);
  assert.equal(new Set(restored.transcriptSegments.map((segment) => segment.id)).size, 2);
  assert.equal(restored.artifacts.rawTranscript.content, 'Draft segment 0. Draft segment 0.');
  assert.equal(restored.transcriptSegments.every((segment) => segment.stages.revised.status === 'deferred'), true);
  assert.equal(restored.artifacts.highQualityTranscript, null);
  assert.equal(stt.calls.some((call) => call.stage === 'highQuality'), false);
  await restartedHandler.idle();
  await restartedHandler.close();
});

test('an interrupted staged attempt becomes retryable and finalize recovers from original saved audio', async (t) => {
  const stt = new StagedSTT();
  const { root, store, session } = await createHarness(t, stt, new PipelineLLM());
  await store.startDictation(session.id, {
    model: 'base', language: 'en', stagedAsr: true,
    asrModels: { provisional: 'small', revised: 'turbo', highQuality: 'large' },
    asrFallbacks: { provisional: ['small'], revised: ['turbo'], highQuality: ['large'] },
  });
  const chunk = await store.saveDictationChunk(session.id, 0, wavChunk(), { startMs: 0, endMs: 2000, boundary: 'speech-boundary' });
  await store.beginTranscriptStage(session.id, chunk.segmentId, 'provisional');

  const restarted = new SessionStore(root);
  await restarted.init();
  let recovered = await restarted.get(session.id);
  assert.equal(recovered.dictation.status, 'error');
  assert.equal(recovered.transcriptSegments[0].stages.provisional.status, 'error');
  assert.match(recovered.transcriptSegments[0].stages.provisional.error, /interrupted/i);

  const handler = createApp({ store: restarted, stt, llm: new PipelineLLM(), materials: new LocalMaterialExtractor() });
  t.after(() => handler.idle());
  recovered = await request(handler, `/api/sessions/${session.id}/dictation/finalize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(recovered.dictation.status, 'complete');
  assert.equal(recovered.artifacts.rawTranscript.content, 'Draft segment 0.');
  await handler.idle();
  const final = await restarted.get(session.id);
  assert.equal(final.transcriptSegments[0].stages.revised.status, 'deferred');
  assert.equal(final.artifacts.highQualityTranscript, null);
  assert.equal(stt.calls.some((call) => call.stage === 'highQuality'), false);
});

test('Base-only recordings keep manual revised text without automatically retranslating it', async (t) => {
  const stt = new StagedSTT({ installedModels: ['base'], delays: { revised: 60 } });
  const llm = new PipelineLLM();
  const { handler, session } = await createHarness(t, stt, llm);
  const dictation = await start(handler, session.id);
  assert.equal(dictation.stagedAsr, true);
  assert.deepEqual(dictation.asrModels, { provisional: 'base', revised: 'base', highQuality: 'base' });
  await sendChunk(handler, session.id, 0);
  await waitFor(async () => (await request(handler, `/api/sessions/${session.id}`)).transcriptSegments[0].versions.provisional);
  await request(handler, `/api/sessions/${session.id}/live-translation`, { method: 'POST', body: '{"enabled":true}' });
  assert.equal(llm.rawSources.length, 0);
  await request(handler, `/api/sessions/${session.id}/dictation/finalize`, { method: 'POST', body: '{}' });
  await request(handler, `/api/sessions/${session.id}/asr/revise`, { method: 'POST', body: '{}' });
  await handler.idle();
  const current = await request(handler, `/api/sessions/${session.id}`);
  assert.equal(current.transcriptSegments[0].versions.provisional.content, 'Draft segment 0.');
  assert.equal(current.transcriptSegments[0].versions.revised.content, 'Revised segment 0.');
  assert.deepEqual(llm.rawSources, ['Draft segment 0.']);
  assert.equal(stt.calls.some((call) => call.stage === 'highQuality'), false);
});

test('manual Raw improvement uses a newly selected installed model and refreshes automatic C cleanup', async (t) => {
  let revised = 'base';
  const settings = { async get() { return { asrModels: { provisional: 'base', revised } }; } };
  const { handler, session, stt, llm } = await createHarness(t, new StagedSTT(), new PipelineLLM(), settings);
  await start(handler, session.id);
  await sendChunk(handler, session.id, 0);
  await request(handler, `/api/sessions/${session.id}/dictation/finalize`, { method: 'POST', body: '{}' });
  await handler.idle();
  revised = 'small';
  const response = await requestResult(handler, `/api/sessions/${session.id}/asr/revise`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 202);
  await handler.idle();
  const current = await request(handler, `/api/sessions/${session.id}`);
  assert.equal(current.transcriptSegments[0].versions.revised.model, 'small');
  assert.equal(stt.calls.filter((call) => call.stage === 'revised').length, 1);
  assert.ok(llm.calls.length > 0);
  assert.equal(current.artifacts.cleanedTranscript.content, 'Revised segment 0.');
  assert.equal(current.processing.status, 'success');
});

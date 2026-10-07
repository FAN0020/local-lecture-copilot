import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { SessionStore } from '../src/store.js';
import { LocalMaterialExtractor } from '../src/providers/material.js';
import { createTranslationProfiler } from '../src/translation-profiler.js';

class TestSTT {
  async transcribe(audioPath, options) {
    assert.ok((await fs.stat(audioPath)).size > 0);
    return {
      content: 'Today we define conditional probability. Bayes theorem combines a prior with evidence.',
      language: options.language === 'auto' ? 'en' : options.language,
      segments: [{ start: 0, end: 4, text: 'Today we define conditional probability.' }],
      provider: 'test-stt',
      model: options.model,
    };
  }
}

class LiveTestSTT extends TestSTT {
  constructor() { super(); this.calls = 0; }
  async transcribe(audioPath, options) {
    const result = await super.transcribe(audioPath, options);
    this.calls += 1;
    result.content = this.calls === 1 ? 'Today we define conditional probability.' : 'Bayes theorem combines a prior with evidence.';
    return result;
  }
}

class NoSpeechSTT extends TestSTT {
  async transcribe() {
    throw Object.assign(new Error('Whisper found no speech in this audio'), { status: 422, code: 'NO_SPEECH' });
  }
}

class MultiSegmentSTT extends TestSTT {
  constructor(outputs) { super(); this.outputs = outputs; this.calls = 0; this.active = 0; this.maxActive = 0; }
  async transcribe(audioPath, options) {
    assert.ok((await fs.stat(audioPath)).size > 0);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const content = this.outputs[this.calls++] ?? '';
      return {
        content,
        language: options.language === 'auto' ? 'en' : options.language,
        segments: content ? [{ start: 0, end: 4, text: content }] : [],
        provider: 'multi-segment-test-stt',
        model: options.model,
      };
    } finally {
      this.active -= 1;
    }
  }
}

function wavChunk(samples = 1600) {
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

class TestLLM {
  async listModels() { return ['test-local:1b']; }
  async generate({ prompt, model, requestType }) {
    if (requestType === 'cleanup') {
      const content = prompt.startsWith('Transcript:\n') ? prompt.slice('Transcript:\n'.length) : '{"edits":[]}';
      return { content, provider: 'test-llm', model, metrics: { inputTokens: 20, outputTokens: 10 } };
    }
    let content = '# Generated artifact\n';
    if (prompt.includes('course-aware')) content += 'Bayes theorem connects prior belief and evidence. [M1]\n\n## Source map\n- [M1] week-2.md';
    else if (prompt.includes('hierarchical concept outline')) content += '## Conditional probability\n- depends on: joint probability [M1]';
    else content += prompt.split('\n')[0];
    return { content, provider: 'test-llm', model, metrics: { inputTokens: 20, outputTokens: 10 } };
  }
}

class CountingLLM extends TestLLM {
  constructor() { super(); this.calls = []; }
  async generate(args) {
    this.calls.push(args);
    return super.generate(args);
  }
}

class UnloadTrackingLLM extends TestLLM {
  constructor(delay = 0) {
    super();
    this.delay = delay;
    this.events = [];
    this.unloads = [];
  }

  async generate(args) {
    this.events.push(`generate-start:${args.sessionId || 'unknown'}`);
    if (this.delay) await new Promise((resolve) => setTimeout(resolve, this.delay));
    const result = await super.generate(args);
    this.events.push(`generate-finish:${args.sessionId || 'unknown'}`);
    return result;
  }

  async unload(model) {
    this.unloads.push(model);
    this.events.push(`unload:${model}`);
  }
}

class FailingLLM extends TestLLM {
  async generate() { throw new Error('Local model unavailable'); }
}

class SlowCleanupLLM extends TestLLM {
  constructor(delay = 40) { super(); this.delay = delay; this.cleanupCalls = 0; }
  async generate(args) {
    if (!args.prompt.startsWith('Transcript:\n')) return super.generate(args);
    this.cleanupCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, this.delay));
    const target = args.prompt.slice('Transcript:\n'.length);
    return { content: target, provider: 'slow-cleanup-test', model: args.model, metrics: {} };
  }
}

class BlockingCleanupLLM extends TestLLM {
  constructor() {
    super();
    this.cleanupCalls = 0;
    this.started = new Promise((resolve) => { this.resolveStarted = resolve; });
    this.releaseGate = null;
    this.gate = new Promise((resolve) => { this.releaseGate = resolve; });
  }

  async generate(args) {
    if (!args.prompt.startsWith('Transcript:\n')) return super.generate(args);
    this.cleanupCalls += 1;
    if (this.cleanupCalls === 1) {
      this.resolveStarted();
      await this.gate;
    }
    const target = args.prompt.slice('Transcript:\n'.length);
    return { content: target, provider: 'blocking-cleanup-test', model: args.model, metrics: {} };
  }
}

class SentenceAssemblySTT extends TestSTT {
  constructor(outputs) { super(); this.outputs = outputs; this.calls = 0; }
  async transcribe(audioPath, options) {
    assert.ok((await fs.stat(audioPath)).size > 0);
    const content = this.outputs[this.calls++] ?? '';
    return {
      content,
      language: options.language === 'auto' ? 'en' : options.language,
      segments: content ? [{ start: 0, end: 4, text: content }] : [],
      provider: 'sentence-test-stt',
      model: options.model,
    };
  }
}

class RawTranslationLLM extends TestLLM {
  constructor({ delay = 0, fail = false } = {}) {
    super();
    this.delay = delay;
    this.fail = fail;
    this.rawCalls = [];
    this.active = 0;
    this.maxActive = 0;
  }
  async generate(args) {
    if (!args.prompt.includes('CURRENT SENTENCE:')) return super.generate(args);
    this.rawCalls.push(args);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.delay) await new Promise((resolve) => setTimeout(resolve, this.delay));
      if (this.fail) throw new Error('Translation provider unavailable');
      const source = args.prompt.split('\nCURRENT SENTENCE:\n')[1];
      return { content: `译：${source}`, provider: 'raw-test-llm', model: args.model, metrics: {} };
    } finally {
      this.active -= 1;
    }
  }
}

class TargetAwareTranslationLLM extends TestLLM {
  constructor({ delay = 0 } = {}) {
    super();
    this.delay = delay;
    this.translationCalls = [];
  }
  async generate(args) {
    if (!args.prompt.includes('CURRENT ') || !args.prompt.includes(' BLOCK:')) return super.generate(args);
    this.translationCalls.push(args);
    if (this.delay) await new Promise((resolve) => setTimeout(resolve, this.delay));
    const target = args.prompt.match(/ BLOCK into ([^.]+)\./)?.[1] || 'unknown';
    const source = args.prompt.split(/\n\nCURRENT [^\n]+ BLOCK:\n/).at(-1);
    return { content: `${target}: ${source}`, provider: 'target-aware-test-llm', model: args.model, metrics: {} };
  }
}

async function waitFor(check, timeout = 1500) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
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
  const body = JSON.parse(response.body.toString('utf8'));
  return { ...response, json: body };
}

async function requestRawResult(handler, endpoint, options = {}) {
  const input = options.body === undefined ? [] : [Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body)];
  const req = Readable.from(input);
  req.url = endpoint;
  req.method = options.method || 'GET';
  req.headers = Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      status: 200,
      headers: {},
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.status, headers: this.headers, body: Buffer.concat(chunks) }); },
    };
    handler(req, res).catch(reject);
  });
}

async function request(handler, endpoint, options = {}) {
  const response = await requestResult(handler, endpoint, options);
  const body = response.json;
  assert.equal(response.status >= 200 && response.status < 300, true, `${response.status}: ${JSON.stringify(body)}`);
  return body;
}

const postJson = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };

function ensureArtifact(handler, sessionId, key) {
  return request(handler, `/api/sessions/${sessionId}/artifacts/${key}/ensure`, postJson);
}

function editRaw(handler, sessionId, content) {
  return request(handler, `/api/sessions/${sessionId}/artifacts/rawTranscript`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }),
  });
}

test('realistic API workflow persists audio, P0, independent P1/P2 outputs, and edits', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-api-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const handler = createApp({ store, stt: new TestSTT(), llm: new TestLLM(), materials: new LocalMaterialExtractor() });

  const session = await request(handler, '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Probability — Week 2', llmModel: 'test-local:1b' }),
  });
  await request(handler, `/api/sessions/${session.id}/audio`, {
    method: 'POST', headers: { 'content-type': 'audio/wav', 'x-filename': 'lecture.wav' }, body: Buffer.from('RIFF realistic audio bytes'),
  });
  const raw = await request(handler, `/api/sessions/${session.id}/transcribe`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'base', language: 'auto' }),
  });
  assert.match(raw.content, /Bayes theorem/);
  await request(handler, `/api/sessions/${session.id}/artifacts/rawTranscript`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: `${raw.content} The denominator is the evidence.` }),
  });
  await request(handler, `/api/sessions/${session.id}/materials`, {
    method: 'POST', headers: { 'content-type': 'text/markdown', 'x-filename': 'week-2.md' }, body: '# Week 2\nBayes theorem: posterior is proportional to likelihood times prior.',
  });
  for (const stage of ['cleanup', 'translation', 'key-points', 'qa', 'analysis', 'notes', 'outline']) {
    await request(handler, `/api/sessions/${session.id}/stages/${stage}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(stage === 'translation' ? { targetLanguage: 'Chinese' } : {}),
    });
  }

  const finished = await request(handler, `/api/sessions/${session.id}`);
  for (const key of ['rawTranscript', 'cleanedTranscript', 'cleanedTranslation', 'keyPoints', 'qa', 'structuredAnalysis', 'notes', 'outline']) {
    assert.ok(finished.artifacts[key]?.content, `${key} should be saved`);
  }
  assert.equal(finished.artifacts.rawTranscript.originalContent, raw.content);
  assert.equal(finished.materials.length, 1);
  assert.equal('extractedText' in finished.materials[0], false);
  assert.equal('storedPath' in finished.materials[0], false);
  assert.equal(finished.materials[0].extractionState, 'complete');
  assert.equal(finished.materials[0].retrieval.method, 'lexical-anchors');
  assert.equal(finished.materials[0].retrieval.vectorized, false);
  assert.ok(finished.materials[0].retrieval.chunkCount >= 1);
  assert.deepEqual(finished.activityLog.filter((entry) => entry.scope === 'material').map((entry) => entry.code), [
    'material-upload-stored',
    'material-format-detected',
    'material-extractor-started',
    'material-text-normalized',
    'material-lexical-chunks-ready',
    'material-chunk-prepared',
    'material-extraction-complete',
  ]);
  assert.ok(finished.activityLog.some((entry) => entry.code === 'revision-retrieval-window'));
  assert.ok(finished.activityLog.some((entry) => entry.code === 'revision-complete'));
  assert.match(finished.artifacts.notes.content, /\[M1\]/);
  assert.deepEqual(finished.artifacts.notes.materialIds, [finished.materials[0].id]);

  const restarted = new SessionStore(root);
  await restarted.init();
  const reopened = await restarted.get(session.id);
  assert.equal(reopened.title, 'Probability — Week 2');
  assert.match(reopened.artifacts.outline.content, /Conditional probability/);
  assert.equal(reopened.materials[0].extractedText.includes('posterior'), true);
});

test('saved course material can be re-extracted in place for a fresh RAG index', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-material-reextract-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const handler = createApp({ store, stt: new TestSTT(), llm: new TestLLM(), materials: new LocalMaterialExtractor() });
  const session = await request(handler, '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const uploaded = await request(handler, `/api/sessions/${session.id}/materials`, {
    method: 'POST', headers: { 'content-type': 'text/markdown', 'x-filename': 'week-2.md' },
    body: '# Week 2\nBayes theorem combines a prior, likelihood, and evidence.',
  });

  const extracted = await request(handler, `/api/sessions/${session.id}/materials/${uploaded.id}/extract`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });

  assert.equal(extracted.id, uploaded.id);
  assert.equal(extracted.extractionState, 'complete');
  assert.equal(extracted.extractor, 'plain-text');
  assert.equal(extracted.retrieval.method, 'lexical-anchors');
  assert.equal(extracted.retrieval.vectorized, false);
  const restored = await store.get(session.id);
  assert.equal(restored.materials.length, 1);
  assert.match(restored.materials[0].extractedText, /Bayes theorem/);
  assert.ok(restored.activityLog.some((entry) => entry.code === 'material-reextraction-started' && entry.materialId === uploaded.id));
});

test('explicit Cleaned generation starts cleanup and persists completed regions while later regions process', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-cleanup-progress-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const llm = new SlowCleanupLLM(45);
  const handler = createApp({ store, stt: new TestSTT(), llm, materials: new LocalMaterialExtractor() });
  const session = await request(handler, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const raw = Array.from({ length: 300 }, (_, index) => `Sentence ${index} explains a technical idea with supporting detail.`).join(' ');
  await request(handler, `/api/sessions/${session.id}/artifacts/rawTranscript`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: raw }),
  });
  const generation = ensureArtifact(handler, session.id, 'cleanedTranscript');
  const partial = await waitFor(async () => {
    const current = await request(handler, `/api/sessions/${session.id}`);
    return current.artifacts.cleanedTranscript?.generationState === 'running'
      && current.artifacts.cleanedTranscript.regions?.length ? current : null;
  }, 1200);
  assert.ok(partial.artifacts.cleanedTranscript.regions.length < 3);
  const completed = await generation;
  assert.equal(completed.generationState, 'complete');
  assert.equal(completed.regions.length, 3);
  assert.equal(llm.cleanupCalls, 3);
});

test('live dictation persists chunks and progressively updates the raw transcript before finalization', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-dictation-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const stt = new LiveTestSTT();
  const handler = createApp({ store, stt, llm: new TestLLM(), materials: new LocalMaterialExtractor() });
  const session = await request(handler, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await request(handler, `/api/sessions/${session.id}/dictation/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'tiny', language: 'en' }),
  });
  const partial = await request(handler, `/api/sessions/${session.id}/dictation/chunks?sequence=0`, {
    method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wavChunk(),
  });
  assert.equal(partial.dictation.status, 'recording');
  assert.match(partial.artifacts.rawTranscript.content, /conditional probability/);
  assert.equal(partial.audio, null);
  await request(handler, `/api/sessions/${session.id}/dictation/chunks?sequence=1`, {
    method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wavChunk(),
  });
  const final = await request(handler, `/api/sessions/${session.id}/dictation/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(final.dictation.status, 'complete');
  assert.match(final.artifacts.rawTranscript.content, /conditional probability.*Bayes theorem/);
  assert.equal(final.artifacts.rawTranscript.originalContent, final.artifacts.rawTranscript.content);
  assert.equal(final.audio.mimeType, 'audio/wav');
  await ensureArtifact(handler, session.id, 'rawTranslation');
  // Cleaned processing is lazy; opening the Cleaned tab is represented by
  // requesting its artifact, after which its translation can be generated.
  const cleaned = await ensureArtifact(handler, session.id, 'cleanedTranscript');
  assert.ok(cleaned.content);
  const cleanedTranslation = await ensureArtifact(handler, session.id, 'translation');
  assert.ok(cleanedTranslation.content);
  const restarted = new SessionStore(root);
  await restarted.init();
  const reopened = await restarted.get(session.id);
  assert.equal(reopened.dictation.status, 'complete');
  assert.equal(reopened.artifacts.rawTranscript.content, final.artifacts.rawTranscript.content);
});

test('dictation stop and resume stay in one session, append Raw, preserve segment audio, recover after restart, and invalidate derived artifacts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-multi-segment-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = new SessionStore(root);
  await first.init();
  const stt = new MultiSegmentSTT(['Sentence A.', 'Sentence B.', 'Sentence C.']);
  const handler = createApp({ store: first, stt, llm: new TestLLM(), materials: new LocalMaterialExtractor() });
  const session = await request(handler, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

  const start = async () => request(handler, `/api/sessions/${session.id}/dictation/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const chunk = async () => request(handler, `/api/sessions/${session.id}/dictation/chunks?sequence=0`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wavChunk() });
  const stop = async () => request(handler, `/api/sessions/${session.id}/dictation/finalize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

  await start();
  await chunk();
  const firstStop = await stop();
  assert.equal(firstStop.id, session.id);
  assert.equal(firstStop.artifacts.rawTranscript.content, 'Sentence A.');
  assert.equal(firstStop.recordingSegments.length, 1);
  const firstSegment = (await first.get(session.id)).recordingSegments[0];
  const firstAudio = await first.readFile(firstSegment.audio.storedPath);
  const firstAudioResponse = await requestRawResult(handler, `/api/sessions/${session.id}/recordings/${firstSegment.id}/audio/content`);
  assert.equal(firstAudioResponse.status, 200);
  assert.deepEqual(firstAudioResponse.body, firstAudio);

  await first.setArtifact(session.id, 'cleanedTranscript', { content: 'Cleaned A.', source: 'manual-edit' });
  await first.setArtifact(session.id, 'notes', { content: '# Notes A', source: 'manual-edit' });
  await start();
  await chunk();
  const secondStop = await stop();
  assert.equal(secondStop.id, session.id);
  assert.equal(secondStop.artifacts.rawTranscript.content, 'Sentence A. Sentence B.');
  assert.equal(secondStop.recordingSegments.length, 2);
  assert.notEqual(secondStop.recordingSegments[0].audio.id, secondStop.recordingSegments[1].audio.id);
  const persistedSecond = await first.get(session.id);
  assert.notEqual(persistedSecond.recordingSegments[0].audio.storedPath, persistedSecond.recordingSegments[1].audio.storedPath);
  assert.deepEqual(await first.readFile(firstSegment.audio.storedPath), firstAudio);
  assert.equal(secondStop.artifacts.cleanedTranscript.stale, true);
  assert.equal(secondStop.artifacts.notes.stale, true);
  assert.equal(secondStop.artifacts.rawTranscript.content.includes('Sentence A. Sentence A.'), false);

  // Allow detached Raw translation work to settle before simulating a process
  // restart with a second store instance. Cleaned generation is tab-lazy.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const restarted = new SessionStore(root);
  await restarted.init();
  const reopened = await restarted.get(session.id);
  assert.equal(reopened.id, session.id);
  assert.equal(reopened.recordingSegments.length, 2);
  assert.equal(reopened.artifacts.rawTranscript.content, 'Sentence A. Sentence B.');
  const restartedHandler = createApp({ store: restarted, stt, llm: new TestLLM(), materials: new LocalMaterialExtractor() });
  await request(restartedHandler, `/api/sessions/${session.id}/dictation/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await request(restartedHandler, `/api/sessions/${session.id}/dictation/chunks?sequence=0`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wavChunk() });
  const thirdStop = await request(restartedHandler, `/api/sessions/${session.id}/dictation/finalize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(thirdStop.id, session.id);
  assert.equal(thirdStop.recordingSegments.length, 3);
  assert.equal(thirdStop.artifacts.rawTranscript.content, 'Sentence A. Sentence B. Sentence C.');

  const newSession = await request(restartedHandler, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.notEqual(newSession.id, session.id);
  const otherStt = new MultiSegmentSTT(['Lecture B.']);
  const otherHandler = createApp({ store: restarted, stt: otherStt, llm: new TestLLM(), materials: new LocalMaterialExtractor() });
  await request(otherHandler, `/api/sessions/${newSession.id}/dictation/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await request(otherHandler, `/api/sessions/${newSession.id}/dictation/chunks?sequence=0`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wavChunk() });
  const otherLecture = await request(otherHandler, `/api/sessions/${newSession.id}/dictation/finalize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(otherLecture.id, newSession.id);
  assert.equal(otherLecture.recordingSegments.length, 1);
  assert.equal(otherLecture.artifacts.rawTranscript.content, 'Lecture B.');
});

test('dictation start is idempotently guarded against concurrent recorder pipelines and does not cross sessions', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-dictation-concurrency-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const stt = new MultiSegmentSTT(['One.']);
  const handler = createApp({ store, stt, llm: new TestLLM(), materials: new LocalMaterialExtractor() });
  const first = await request(handler, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const second = await request(handler, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const start = (id) => requestResult(handler, `/api/sessions/${id}/dictation/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const [a, b] = await Promise.all([start(first.id), start(first.id)]);
  assert.equal([a, b].filter((result) => result.status === 201).length, 1);
  const cross = await start(second.id);
  assert.equal(cross.status, 409);
});

test('silent dictation returns a recoverable API error without escaping the HTTP handler', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-silent-dictation-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const handler = createApp({ store, stt: new NoSpeechSTT(), llm: new TestLLM(), materials: new LocalMaterialExtractor() });
  const session = await request(handler, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await request(handler, `/api/sessions/${session.id}/dictation/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await request(handler, `/api/sessions/${session.id}/dictation/chunks?sequence=0`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wavChunk() });

  const stopped = await requestResult(handler, `/api/sessions/${session.id}/dictation/finalize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(stopped.status, 422);
  assert.equal(stopped.json.code, 'NO_SPEECH');
  assert.match(stopped.json.error, /recording was saved/i);

  const current = await request(handler, `/api/sessions/${session.id}`);
  assert.equal(current.recordingSegments.length, 1);
  assert.equal(current.processing.status, 'error');
});

test('Raw live translation starts from provisional text, refreshes completed wording, and never retranslates an unchanged unit', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-raw-translation-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const llm = new RawTranslationLLM();
  const handler = createApp({
    store,
    stt: new SentenceAssemblySTT(["Today we're going to talk about", 'operating systems.', 'They manage resources.']),
    llm,
    materials: new LocalMaterialExtractor(),
  });
  const session = await request(handler, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await request(handler, `/api/sessions/${session.id}/dictation/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

  await request(handler, `/api/sessions/${session.id}/dictation/chunks?sequence=0`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wavChunk() });
  const partial = await request(handler, `/api/sessions/${session.id}/artifacts/rawTranslation/ensure`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(partial.segments.length, 0);
  assert.match(partial.pendingText, /Today we're going to talk about/);
  assert.equal(partial.pendingTranslation.status, 'translated');
  assert.equal(partial.pendingTranslation.translatedText, "译：Today we're going to talk about");
  assert.equal(llm.rawCalls.length, 1);

  await request(handler, `/api/sessions/${session.id}/dictation/chunks?sequence=1`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wavChunk() });
  const first = await request(handler, `/api/sessions/${session.id}/artifacts/rawTranslation/ensure`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(first.segments.length, 1);
  assert.equal(first.segments[0].status, 'translated');
  assert.equal(first.segments[0].id, partial.pendingTranslation.id);
  assert.match(llm.rawCalls[1].prompt, /CURRENT SENTENCE:\nToday we're going to talk about operating systems\./);

  await request(handler, `/api/sessions/${session.id}/dictation/chunks?sequence=2`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wavChunk() });
  const second = await request(handler, `/api/sessions/${session.id}/artifacts/rawTranslation/ensure`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(second.segments.length, 2);
  assert.equal(second.segments.every((segment) => segment.status === 'translated'), true);
  assert.match(llm.rawCalls[2].prompt, /PRECEDING CONTEXT[\s\S]*Today we're going to talk about operating systems\./);
  assert.match(llm.rawCalls[2].prompt, /CURRENT SENTENCE:\nThey manage resources\./);

  await request(handler, `/api/sessions/${session.id}/artifacts/rawTranslation/ensure`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(llm.rawCalls.length, 3);
});

test('appending Raw while manual translation runs preserves the stable unit and defers new text to the next click', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-raw-queue-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const llm = new RawTranslationLLM({ delay: 30 });
  const handler = createApp({ store, stt: new TestSTT(), llm, materials: new LocalMaterialExtractor() });
  const session = await request(handler, '/api/sessions', postJson);
  await editRaw(handler, session.id, 'First sentence.');
  const pending = ensureArtifact(handler, session.id, 'rawTranslation');
  await waitFor(() => llm.rawCalls.length === 1);
  const running = await request(handler, `/api/sessions/${session.id}`);
  assert.equal(running.processing.stage, 'raw-translation');
  assert.equal(running.processing.status, 'running', 'other tabs can observe active manual translation');
  await editRaw(handler, session.id, 'First sentence. Second sentence.');
  await pending;
  assert.equal(llm.rawCalls.length, 1, 'editing does not schedule more inference');
  const awaitingClick = await request(handler, `/api/sessions/${session.id}`);
  assert.equal(awaitingClick.artifacts.rawTranslation.generationState, 'idle');
  assert.equal(awaitingClick.artifacts.rawTranslation.stale, true);
  assert.equal(awaitingClick.artifacts.rawTranslation.segments[0].translatedText, '译：First sentence.');
  assert.equal(awaitingClick.artifacts.rawTranslation.segments[1].status, 'pending');
  assert.equal(awaitingClick.processing.status, 'error');
  const translated = await ensureArtifact(handler, session.id, 'rawTranslation');
  assert.equal(translated.segments[0].translatedText, '译：First sentence.');
  assert.equal(translated.segments[1].translatedText, '译：Second sentence.');
  assert.equal(llm.rawCalls.length, 2, 'each unchanged sentence is translated once');
  assert.equal(llm.maxActive, 1);
});


test('a stale in-flight Raw result is discarded and correction requires an explicit retry', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-raw-stale-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const llm = new RawTranslationLLM({ delay: 35 });
  const handler = createApp({ store, stt: new TestSTT(), llm, materials: new LocalMaterialExtractor() });
  const session = await request(handler, '/api/sessions', postJson);
  await editRaw(handler, session.id, 'Original sentence.');
  const pending = ensureArtifact(handler, session.id, 'rawTranslation');
  await waitFor(() => llm.rawCalls.length === 1);
  await editRaw(handler, session.id, 'Corrected sentence.');
  await pending;
  assert.equal(llm.rawCalls.length, 1);
  const beforeRetry = await request(handler, `/api/sessions/${session.id}`);
  assert.doesNotMatch(beforeRetry.artifacts.rawTranslation?.content || '', /Original sentence/);
  const translated = await ensureArtifact(handler, session.id, 'rawTranslation');
  assert.equal(translated.segments[0].translatedText, '译：Corrected sentence.');
  assert.equal(llm.rawCalls.length, 2);
});

test('Raw translation failure remains retryable and never interrupts later transcription', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-raw-failure-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const llm = new RawTranslationLLM({ fail: true });
  const handler = createApp({
    store,
    stt: new SentenceAssemblySTT(['First sentence.', 'Second sentence.']),
    llm,
    materials: new LocalMaterialExtractor(),
  });
  const session = await request(handler, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await request(handler, `/api/sessions/${session.id}/dictation/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await request(handler, `/api/sessions/${session.id}/dictation/chunks?sequence=0`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wavChunk() });
  await request(handler, `/api/sessions/${session.id}/artifacts/rawTranslation/ensure`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await request(handler, `/api/sessions/${session.id}/dictation/chunks?sequence=1`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wavChunk() });
  const current = await request(handler, `/api/sessions/${session.id}/artifacts/rawTranslation/ensure`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const source = await request(handler, `/api/sessions/${session.id}`);
  assert.match(source.artifacts.rawTranscript.content, /First sentence\. Second sentence\./);
  assert.equal(source.dictation.status, 'recording');
  assert.equal(current.segments.every((segment) => segment.status === 'error'), true);
  assert.equal(current.generationState, 'error');
});

test('changing the Raw target discards in-flight work and waits for a manual retry', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-raw-target-race-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const llm = new RawTranslationLLM({ delay: 40 });
  const handler = createApp({ store, stt: new TestSTT(), llm, materials: new LocalMaterialExtractor() });
  const session = await request(handler, '/api/sessions', postJson);
  await editRaw(handler, session.id, 'Target race sentence.');
  const pending = ensureArtifact(handler, session.id, 'rawTranslation');
  await waitFor(() => llm.rawCalls.length === 1);
  await request(handler, `/api/sessions/${session.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetLanguage: 'Japanese' }) });
  await pending;
  assert.equal(llm.rawCalls.length, 1);
  const awaitingRetry = await request(handler, `/api/sessions/${session.id}`);
  assert.equal(awaitingRetry.artifacts.rawTranslation.generationState, 'idle');
  assert.equal(awaitingRetry.artifacts.rawTranslation.stale, true);
  assert.equal(awaitingRetry.artifacts.rawTranslation.targetLanguage, 'Chinese');
  assert.equal(awaitingRetry.processing.status, 'error');
  const translated = await ensureArtifact(handler, session.id, 'rawTranslation');
  assert.equal(translated.targetLanguage, 'Japanese');
  assert.equal(translated.segments[0].status, 'translated');
  assert.equal(llm.rawCalls.length, 2);
  assert.match(llm.rawCalls[0].prompt, /into Chinese/);
  assert.match(llm.rawCalls[1].prompt, /into Japanese/);
});

test('manual translation excludes another session until completion and preserves session isolation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-raw-session-isolation-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const llm = new RawTranslationLLM({ delay: 30 });
  const handler = createApp({ store, stt: new TestSTT(), llm, materials: new LocalMaterialExtractor() });
  const [first, second] = await Promise.all([
    request(handler, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'First' }) }),
    request(handler, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Second' }) }),
  ]);
  await Promise.all([
    request(handler, `/api/sessions/${first.id}/artifacts/rawTranscript`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'First session sentence.' }) }),
    request(handler, `/api/sessions/${second.id}/artifacts/rawTranscript`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Second session sentence.' }) }),
  ]);

  const pending = ensureArtifact(handler, first.id, 'rawTranslation');
  await waitFor(() => llm.rawCalls.length === 1);
  const blocked = await requestResult(handler, `/api/sessions/${second.id}/artifacts/rawTranslation/ensure`, postJson);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.code, 'PROCESSING_ACTIVE');
  const firstTranslation = await pending;
  const secondTranslation = await ensureArtifact(handler, second.id, 'rawTranslation');

  assert.equal(firstTranslation.segments[0].sourceText, 'First session sentence.');
  assert.equal(secondTranslation.segments[0].sourceText, 'Second session sentence.');
  assert.doesNotMatch(firstTranslation.content, /Second session/);
  assert.doesNotMatch(secondTranslation.content, /First session/);
  assert.equal(llm.maxActive, 1, 'only one manual action runs at a time');
});

test('simultaneous manual actions are rejected before adding expensive work to the queue', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-global-llm-queue-test-'));
  const store = new SessionStore(root);
  await store.init();
  const llm = new RawTranslationLLM({ delay: 40 });
  const handler = createApp({
    store,
    stt: new TestSTT(),
    llm,
    materials: new LocalMaterialExtractor(),
    llmConcurrency: 2,
    llmQueueLimit: 4,
  });
  t.after(async () => {
    await handler.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const sessions = [];
  for (let index = 0; index < 12; index += 1) {
    const session = await request(handler, '/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: `Queue ${index}` }),
    });
    await request(handler, `/api/sessions/${session.id}/artifacts/rawTranscript`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: `Bounded sentence ${index}.` }),
    });
    sessions.push(session);
  }
  const requests = sessions.map((session) => requestResult(handler, `/api/sessions/${session.id}/artifacts/rawTranslation/ensure`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(handler.llmScheduler.snapshot().active <= 2);
  assert.ok(handler.llmScheduler.snapshot().queued <= 4);
  const responses = await Promise.all(requests);
  assert.equal(llm.maxActive, 1);
  assert.equal(responses.filter((response) => response.status === 200).length, 1);
  assert.equal(responses.filter((response) => response.status === 409 && response.json.code === 'PROCESSING_ACTIVE').length, 11);
  assert.equal(handler.llmScheduler.snapshot().retained, 0);
  assert.equal(llm.rawCalls.length, 1);
  const retry = await ensureArtifact(handler, sessions[1].id, 'rawTranslation');
  assert.equal(retry.segments[0].status, 'translated');
});

test('Raw translation uses bounded per-session concurrency and exposes opt-in lifecycle metrics', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-raw-profiler-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const profiler = createTranslationProfiler({ enabled: true });
  let active = 0;
  let maxActive = 0;
  const providerRequests = [];
  const llm = {
    async generate(options) {
      const { prompt } = options;
      providerRequests.push(options);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 12));
      active -= 1;
      return { content: `译：${prompt.split('\nCURRENT SENTENCE:\n')[1]}`, provider: 'profile-llm', model: 'test' };
    },
  };
  const handler = createApp({ store, stt: new TestSTT(), llm, materials: new LocalMaterialExtractor(), translationProfiler: profiler });
  const session = await request(handler, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const source = Array.from({ length: 6 }, (_, index) => `Profiler sentence ${index + 1}.`).join(' ');
  await request(handler, `/api/sessions/${session.id}/artifacts/rawTranscript`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: source }),
  });
  const savedSource = await store.get(session.id);
  profiler.record(session.id, 'transcript-finalized', {
    sourceFingerprint: savedSource.artifacts.rawTranscript.contentFingerprint,
    sourceCharacters: source.length,
    sourceWords: source.split(/\s+/u).length,
  });
  const translated = await request(handler, `/api/sessions/${session.id}/artifacts/rawTranslation/ensure`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(translated.segments.length, 6);
  assert.equal(translated.segments.every((segment) => segment.status === 'translated'), true);
  assert.equal(maxActive, 2);
  assert.equal(providerRequests.every((options) => options.requestType === 'raw-translation'
    && options.numCtx === 2048 && options.numPredict === 256), true);
  const metrics = (await requestResult(handler, '/api/debug/translation-metrics')).json[session.id];
  assert.ok(metrics.summary.requests >= 6);
  assert.equal(metrics.summary.maxProviderConcurrency, 2);
  assert.ok(metrics.summary.providerLatencyMs.every((value) => value >= 0));
  assert.ok(metrics.summary.persistenceLatencyMs.length >= 6);
  assert.ok(metrics.summary.transcriptToQueueMs.some((value) => value >= 0));
  assert.ok(metrics.summary.requestSizes.every((size) => size.characters > 0 && size.words > 0 && size.estimatedTokens > 0));
  assert.ok(metrics.events.some((event) => event.type === 'queued'));
  assert.ok(metrics.events.some((event) => event.type === 'worker-start'));
  assert.ok(metrics.events.some((event) => event.type === 'provider-start'));
  assert.ok(metrics.events.some((event) => event.type === 'persisted'));
});

test('session Stop saves the recording without starting or unloading an Ollama runner', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-llm-stop-reset-test-'));
  const store = new SessionStore(root);
  await store.init();
  const llm = new UnloadTrackingLLM();
  const handler = createApp({ store, stt: new TestSTT(), llm, materials: new LocalMaterialExtractor(), llmRecycleRequests: 1000 });
  t.after(async () => { await handler.close(); await fs.rm(root, { recursive: true, force: true }); });
  const session = await request(handler, '/api/sessions', postJson);
  await request(handler, `/api/sessions/${session.id}/dictation/start`, postJson);
  await request(handler, `/api/sessions/${session.id}/dictation/chunks?sequence=0`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wavChunk() });
  const stopped = await request(handler, `/api/sessions/${session.id}/dictation/finalize`, postJson);
  assert.ok(stopped.audio);
  assert.deepEqual(llm.events, []);
  await ensureArtifact(handler, session.id, 'rawTranslation');
  assert.ok(llm.events.some((event) => event.startsWith('generate-finish:')));
  assert.deepEqual(llm.unloads, [], 'a manual burst relies on the provider idle timeout');
});


test('recording in one session blocks AI work in another session until Stop', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-llm-multi-session-reset-test-'));
  const store = new SessionStore(root);
  await store.init();
  const llm = new RawTranslationLLM();
  const handler = createApp({ store, stt: new TestSTT(), llm, materials: new LocalMaterialExtractor() });
  t.after(async () => { await handler.close(); await fs.rm(root, { recursive: true, force: true }); });
  const first = await request(handler, '/api/sessions', postJson);
  const second = await request(handler, '/api/sessions', postJson);
  await editRaw(handler, second.id, 'Another session needs a translation.');
  await request(handler, `/api/sessions/${first.id}/dictation/start`, postJson);
  await request(handler, `/api/sessions/${first.id}/dictation/chunks?sequence=0`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wavChunk() });
  const blocked = await requestResult(handler, `/api/sessions/${second.id}/artifacts/rawTranslation/ensure`, postJson);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.code, 'RECORDING_ACTIVE');
  assert.equal(llm.rawCalls.length, 0);
  await request(handler, `/api/sessions/${first.id}/dictation/finalize`, postJson);
  const translated = await ensureArtifact(handler, second.id, 'rawTranslation');
  assert.equal(translated.segments[0].status, 'translated');
});

test('paragraph boundaries are structural, editable, locked, and reload with the raw transcript unchanged', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-paragraph-api-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const handler = createApp({ store, stt: new TestSTT(), llm: new TestLLM(), materials: new LocalMaterialExtractor() });
  const session = await request(handler, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const rawText = 'We define conditional probability. The denominator is the evidence. Now we move to Fourier transforms.';
  const saved = await request(handler, `/api/sessions/${session.id}/artifacts/rawTranscript`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      content: rawText,
      segments: [
        { id: 's0', text: 'We define conditional probability.', start: 0, end: 1 },
        { id: 's1', text: 'The denominator is the evidence.', start: 1.2, end: 2 },
        { id: 's2', text: 'Now we move to Fourier transforms.', start: 2.2, end: 3 },
      ],
    }),
  });
  assert.equal(saved.content, rawText);
  const initial = await request(handler, `/api/sessions/${session.id}`);
  assert.ok(initial.paragraphization);
  assert.equal(initial.artifacts.rawTranscript.content, rawText);
  const firstParagraph = initial.paragraphization.paragraphs.find((item) => item.segmentIds.length > 1);
  assert.ok(firstParagraph);
  const split = await request(handler, `/api/sessions/${session.id}/paragraphs/split`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paragraphId: firstParagraph.id, afterSegmentId: firstParagraph.segmentIds[0] }),
  });
  assert.equal(split.paragraphization.boundaries.some((item) => item.manualLocked && item.source === 'manual-split'), true);
  const merged = await request(handler, `/api/sessions/${session.id}/paragraphs/merge-previous`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paragraphId: split.paragraphization.paragraphs[1].id }),
  });
  assert.equal(merged.paragraphization.boundaries.some((item) => item.manualLocked && item.source === 'manual-merge' && item.enabled === false), true);
  const restarted = new SessionStore(root);
  await restarted.init();
  const reopened = await restarted.get(session.id);
  assert.equal(reopened.artifacts.rawTranscript.content, rawText);
  assert.equal(reopened.paragraphization.boundaries.some((item) => item.manualLocked && item.enabled === false), true);
});

test('session deletion API removes the sidebar record and session directory', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-api-delete-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const handler = createApp({ store, stt: new TestSTT(), llm: new TestLLM(), materials: new LocalMaterialExtractor() });
  const session = await request(handler, '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Temporary deletion test' }),
  });
  await request(handler, `/api/sessions/${session.id}/audio`, {
    method: 'POST', headers: { 'content-type': 'audio/wav', 'x-filename': 'temporary.wav' }, body: Buffer.from('RIFF temporary audio bytes'),
  });
  await request(handler, `/api/sessions/${session.id}/artifacts/notes`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Generated notes' }),
  });
  const sessionDir = store.dir(session.id);

  const deleted = await request(handler, `/api/sessions/${session.id}`, { method: 'DELETE' });
  assert.deepEqual(deleted, { id: session.id, title: 'Temporary deletion test' });
  assert.equal((await request(handler, '/api/sessions')).some((item) => item.id === session.id), false);
  await assert.rejects(() => fs.access(sessionDir), (error) => error.code === 'ENOENT');
});

test('session creation API allocates automatic titles in persistent storage', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-api-title-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const handler = createApp({ store, stt: new TestSTT(), llm: new TestLLM(), materials: new LocalMaterialExtractor() });
  const automaticTitle = { date: '2026-08-27', label: 'Aug 27' };

  const first = await request(handler, '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ automaticTitle }),
  });
  const second = await request(handler, '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ automaticTitle }),
  });

  assert.equal(first.title, 'Lecture — Aug 27 — 1');
  assert.equal(second.title, 'Lecture — Aug 27 — 2');
  assert.deepEqual(second.automaticTitle, { ...automaticTitle, index: 2 });
});

test('finalized dictation and browsing every output stay idle until a manual generation request', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-derived-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const llm = new CountingLLM();
  const handler = createApp({ store, stt: new LiveTestSTT(), llm, materials: new LocalMaterialExtractor() });
  const session = await request(handler, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await request(handler, `/api/sessions/${session.id}/dictation/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'tiny', language: 'en' }),
  });
  await request(handler, `/api/sessions/${session.id}/dictation/chunks?sequence=0`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wavChunk() });
  const finalized = await request(handler, `/api/sessions/${session.id}/dictation/finalize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.ok(finalized.audio);
  assert.ok(finalized.artifacts.rawTranscript?.content);
  assert.equal(finalized.artifacts.cleanedTranscript, null);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const beforeCleanedTab = await request(handler, `/api/sessions/${session.id}`);
  assert.equal(beforeCleanedTab.artifacts.cleanedTranscript, null);
  assert.equal(llm.calls.filter((call) => call.prompt.startsWith('Transcript:\n')).length, 0);

  for (const key of ['cleanedTranscript', 'translation', 'notes', 'outline', 'notesTranslation', 'outlineTranslation']) {
    assert.equal(await request(handler, `/api/sessions/${session.id}/artifacts/${key}`), null);
  }
  assert.equal(llm.calls.length, 0, 'browsing outputs must not launch inference');
  const cleaned = await ensureArtifact(handler, session.id, 'cleanedTranscript');
  assert.ok(cleaned.content);
  const cleanedTranslation = await ensureArtifact(handler, session.id, 'translation');
  assert.ok(cleanedTranslation.content);
  const generated = await request(handler, `/api/sessions/${session.id}`);
  assert.ok(generated.artifacts.cleanedTranscript.dependsOn);
  assert.equal(generated.artifacts.cleanedTranscript.dependsOn.key, 'rawTranscript');
  assert.equal(generated.artifacts.cleanedTranslation.dependsOn.key, 'cleanedTranscript');
  assert.equal(await request(handler, `/api/sessions/${session.id}/artifacts/rawTranslation`), null);
  assert.equal(llm.calls.filter((call) => call.prompt.startsWith('Transcript:\n')).length, 1);
  assert.equal(llm.calls.filter((call) => call.prompt.includes('CURRENT CLEANED TRANSCRIPT BLOCK')).length, 1);
});


test('dictation can resume while lazy Cleaned Transcript processing is running', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-cleanup-resume-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const llm = new BlockingCleanupLLM();
  const handler = createApp({ store, stt: new LiveTestSTT(), llm, materials: new LocalMaterialExtractor() });
  const session = await request(handler, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await store.setArtifact(session.id, 'rawTranscript', { content: 'The first lecture segment is already saved.', source: 'manual-edit' }, { preserve: true });

  const cleanupRequest = ensureArtifact(handler, session.id, 'cleanedTranscript');
  await llm.started;
  const cleaning = await request(handler, `/api/sessions/${session.id}`);
  assert.equal(cleaning.processing?.stage, 'cleanup');

  const started = await request(handler, `/api/sessions/${session.id}/dictation/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'tiny', language: 'en' }),
  });
  assert.equal(started.status, 'recording');
  const chunked = await request(handler, `/api/sessions/${session.id}/dictation/chunks?sequence=0`, {
    method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wavChunk(),
  });
  assert.equal(chunked.dictation.status, 'recording');
  assert.match(chunked.artifacts.rawTranscript.content, /conditional probability/);

  llm.releaseGate();
  const cleaned = await cleanupRequest;
  assert.ok(cleaned.content);
  assert.ok(llm.cleanupCalls >= 2, 'the stale pre-resume cleanup result should be retried against the new Raw');
  const whileRecording = await request(handler, `/api/sessions/${session.id}`);
  assert.equal(whileRecording.processing?.stage, 'dictation', 'cleanup completion must not hide active dictation');
  assert.equal(whileRecording.dictation?.status, 'recording');

  const finalized = await request(handler, `/api/sessions/${session.id}/dictation/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(finalized.dictation.status, 'complete');
  assert.match(finalized.artifacts.rawTranscript.content, /first lecture segment.*conditional probability/);
  const persisted = await store.get(session.id);
  assert.equal(persisted.processing.stage, 'dictation');
});

test('manual generation reuses valid artifacts and browsing stale dependencies does not regenerate them', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-lazy-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const llm = new CountingLLM();
  const handler = createApp({ store, stt: new TestSTT(), llm, materials: new LocalMaterialExtractor() });
  const session = await request(handler, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await store.setArtifact(session.id, 'rawTranscript', { content: 'Raw source', source: 'manual-edit' }, { preserve: true });
  const cleaned = await ensureArtifact(handler, session.id, 'cleanedTranscript');
  assert.ok(cleaned.content);
  const translation = await ensureArtifact(handler, session.id, 'translation');
  assert.ok(translation.content);
  const callsAfterFirstLoad = llm.calls.length;
  await request(handler, `/api/sessions/${session.id}/artifacts/translation`, { method: 'GET' });
  assert.equal(llm.calls.length, callsAfterFirstLoad);
  const restarted = new SessionStore(root);
  await restarted.init();
  const restored = await restarted.get(session.id);
  assert.equal(restored.artifacts.cleanedTranscript.dependsOn.key, 'rawTranscript');
  assert.equal(restored.artifacts.cleanedTranslation.targetLanguage, restored.targetLanguage);
  await request(handler, `/api/sessions/${session.id}/artifacts/rawTranscript`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Changed raw source' }),
  });
  const changed = await request(handler, `/api/sessions/${session.id}`);
  assert.equal(changed.artifacts.cleanedTranscript.stale, true);
  assert.equal(changed.artifacts.cleanedTranslation.stale, true);
  await request(handler, `/api/sessions/${session.id}/artifacts/translation`, { method: 'GET' });
  assert.equal(llm.calls.length, callsAfterFirstLoad);
  await ensureArtifact(handler, session.id, 'translation');
  assert.equal(llm.calls.length, callsAfterFirstLoad + 2);
  await request(handler, `/api/sessions/${session.id}/stages/cleanup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const afterRegenerate = await request(handler, `/api/sessions/${session.id}`);
  assert.equal(afterRegenerate.artifacts.cleanedTranslation.stale, true);
  const cleanupCalls = llm.calls.filter((call) => call.prompt.startsWith('Transcript:\n')).length;
  await request(handler, `/api/sessions/${session.id}/stages/cleanup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(llm.calls.filter((call) => call.prompt.startsWith('Transcript:\n')).length, cleanupCalls + 1);
});

test('Cleaned, Notes, and Outline ensure requests deduplicate, persist, and regenerate only when their sources are stale', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-auto-tabs-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const llm = new CountingLLM();
  const handler = createApp({ store, stt: new TestSTT(), llm, materials: new LocalMaterialExtractor() });
  const session = await request(handler, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await store.setArtifact(session.id, 'rawTranscript', { content: 'Raw lecture source.', source: 'manual-edit' }, { preserve: true });

  const notesEndpoint = `/api/sessions/${session.id}/artifacts/notes/ensure`;
  const outlineEndpoint = `/api/sessions/${session.id}/artifacts/outline/ensure`;
  const post = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
  const [notesA, notesB] = await Promise.all([
    request(handler, notesEndpoint, post),
    request(handler, notesEndpoint, post),
  ]);
  assert.equal(notesA.content, notesB.content);
  assert.equal(llm.calls.filter((call) => call.prompt.startsWith('Transcript:\n')).length, 1);
  assert.equal(llm.calls.filter((call) => call.prompt.includes('course-aware structured lecture notes')).length, 1);

  await Promise.all([
    request(handler, outlineEndpoint, post),
    request(handler, outlineEndpoint, post),
  ]);
  assert.equal(llm.calls.filter((call) => call.prompt.includes('hierarchical concept outline')).length, 1);
  const callsAfterFirstOpen = llm.calls.length;
  await request(handler, notesEndpoint, post);
  await request(handler, outlineEndpoint, post);
  assert.equal(llm.calls.length, callsAfterFirstOpen, 'revisiting valid artifacts must not regenerate them');

  await request(handler, `/api/sessions/${session.id}/artifacts/rawTranscript`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Changed raw lecture source.' }),
  });
  const stale = await request(handler, `/api/sessions/${session.id}`);
  assert.equal(stale.artifacts.cleanedTranscript.stale, true);
  assert.equal(stale.artifacts.notes.stale, true);
  assert.equal(stale.artifacts.outline.stale, true);
  await request(handler, notesEndpoint, post);
  assert.equal(llm.calls.filter((call) => call.prompt.startsWith('Transcript:\n')).length, 2);
  assert.equal(llm.calls.filter((call) => call.prompt.includes('course-aware structured lecture notes')).length, 2);

  await request(handler, `/api/sessions/${session.id}/materials`, {
    method: 'POST', headers: { 'content-type': 'text/plain', 'x-filename': 'reference.txt' }, body: 'A reference definition for the lecture.',
  });
  const materialStale = await request(handler, `/api/sessions/${session.id}`);
  assert.equal(materialStale.artifacts.notes.stale, true);
  assert.equal(materialStale.artifacts.outline.stale, true);
  const regenerated = await request(handler, notesEndpoint, post);
  assert.equal(regenerated.materialIds.length, 1);
  assert.equal(llm.calls.filter((call) => call.prompt.includes('course-aware structured lecture notes')).length, 3);
});

test('downstream generation failure preserves durable raw transcript and audio for retry', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-failure-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const handler = createApp({ store, stt: new LiveTestSTT(), llm: new FailingLLM(), materials: new LocalMaterialExtractor() });
  const session = await request(handler, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await request(handler, `/api/sessions/${session.id}/dictation/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await request(handler, `/api/sessions/${session.id}/dictation/chunks?sequence=0`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wavChunk() });
  const finalized = await request(handler, `/api/sessions/${session.id}/dictation/finalize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.ok(finalized.audio);
  assert.ok(finalized.artifacts.rawTranscript?.content);
  // Cleanup is lazy and begins only when the Cleaned artifact is requested.
  const cleanupRequest = requestResult(handler, `/api/sessions/${session.id}/artifacts/cleanedTranscript/ensure`, postJson);
  const failed = await waitFor(async () => {
    const current = await request(handler, `/api/sessions/${session.id}`);
    return current.processing?.status === 'error' ? current : null;
  });
  const cleanupResponse = await cleanupRequest;
  assert.equal(cleanupResponse.status, 500);
  assert.equal(failed.processing.stage, 'cleanup');
  assert.ok(failed.audio);
  assert.ok(failed.artifacts.rawTranscript?.content);
  assert.equal(failed.artifacts.cleanedTranscript, null);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(unhandled, []);
});

test('document translation failures preserve Cleaned, Notes, Outline, and their previous valid translations', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-document-translation-failure-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const session = await store.create({ targetLanguage: 'Chinese' });
  await store.setArtifact(session.id, 'rawTranscript', { content: 'Raw source.', source: 'manual-edit' }, { preserve: true });
  for (const [sourceKey, translationKey, first, changed, translated] of [
    ['cleanedTranscript', 'cleanedTranslation', 'Cleaned v1.', 'Cleaned v2.', '旧清理翻译。'],
    ['notes', 'notesTranslation', '# Notes v1', '# Notes v2', '# 旧笔记翻译'],
    ['outline', 'outlineTranslation', '# Outline v1', '# Outline v2', '# 旧大纲翻译'],
  ]) {
    await store.setArtifact(session.id, sourceKey, { content: first, source: 'manual-edit' });
    await store.setArtifact(session.id, translationKey, { content: translated, source: 'manual-edit', targetLanguage: 'Chinese' });
    await store.setArtifact(session.id, sourceKey, { content: changed, source: 'manual-edit' });
  }
  const handler = createApp({ store, stt: new TestSTT(), llm: new FailingLLM(), materials: new LocalMaterialExtractor() });

  for (const [sourceKey, translationKey] of [
    ['cleanedTranscript', 'cleanedTranslation'],
    ['notes', 'notesTranslation'],
    ['outline', 'outlineTranslation'],
  ]) {
    const before = await store.get(session.id);
    const response = await requestResult(handler, `/api/sessions/${session.id}/artifacts/${translationKey}/ensure`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 500);
    const after = await store.get(session.id);
    assert.equal(after.artifacts[sourceKey].content, before.artifacts[sourceKey].content);
    assert.equal(after.artifacts[translationKey].content, before.artifacts[translationKey].content);
    assert.equal(after.artifacts[translationKey].stale, true);
  }
});

test('a target-language change during document translation retries from a fresh session snapshot', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-document-target-race-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const session = await store.create({ targetLanguage: 'Chinese' });
  await store.setArtifact(session.id, 'rawTranscript', { content: 'Raw source.', source: 'manual-edit' }, { preserve: true });
  await store.setArtifact(session.id, 'cleanedTranscript', { content: 'Cleaned source.', source: 'manual-edit' });
  const llm = new TargetAwareTranslationLLM({ delay: 40 });
  const handler = createApp({ store, stt: new TestSTT(), llm, materials: new LocalMaterialExtractor() });

  const pending = request(handler, `/api/sessions/${session.id}/artifacts/cleanedTranslation/ensure`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  await waitFor(() => llm.translationCalls.length === 1);
  await request(handler, `/api/sessions/${session.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetLanguage: 'Japanese' }),
  });

  const translation = await pending;
  assert.equal(translation.targetLanguage, 'Japanese');
  assert.match(translation.content, /^Japanese:/);
  assert.equal(llm.translationCalls.length, 2);
  assert.match(llm.translationCalls[0].prompt, /into Chinese/);
  assert.match(llm.translationCalls[1].prompt, /into Japanese/);
  const restored = await store.get(session.id);
  assert.equal(restored.processing.status, 'success');
  assert.equal(restored.artifacts.cleanedTranslation.targetLanguage, 'Japanese');
});

test('generated Notes and Outline translations persist across a complete store restart', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-document-translation-restart-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const session = await store.create({ targetLanguage: 'Chinese' });
  await store.setArtifact(session.id, 'rawTranscript', { content: 'Raw source.', source: 'manual-edit' }, { preserve: true });
  await store.setArtifact(session.id, 'notes', { content: '# Notes\n- Parent\n  - Child', source: 'manual-edit' });
  await store.setArtifact(session.id, 'outline', { content: '# Outline\n## Topic\n- depends on\n  - Prior', source: 'manual-edit' });
  const handler = createApp({ store, stt: new TestSTT(), llm: new TargetAwareTranslationLLM(), materials: new LocalMaterialExtractor() });

  const [notes, outline] = await Promise.all([
    request(handler, `/api/sessions/${session.id}/artifacts/notesTranslation/ensure`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    request(handler, `/api/sessions/${session.id}/artifacts/outlineTranslation/ensure`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  ]);
  const restarted = new SessionStore(root);
  await restarted.init();
  const restored = await restarted.get(session.id);
  assert.equal(restored.artifacts.notesTranslation.content, notes.content);
  assert.equal(restored.artifacts.outlineTranslation.content, outline.content);
  assert.equal(restored.artifacts.notesTranslation.dependsOn.key, 'notes');
  assert.equal(restored.artifacts.outlineTranslation.dependsOn.key, 'outline');
  assert.equal(restored.artifacts.notesTranslation.generationState, 'complete');
  assert.equal(restored.artifacts.outlineTranslation.generationState, 'complete');
});

test('Raw source refinement keeps the last successful translation through failure until replacement succeeds', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-raw-stale-while-revalidate-test-'));
  const store = new SessionStore(root);
  await store.init();
  const llm = new RawTranslationLLM();
  const handler = createApp({ store, stt: new TestSTT(), llm, materials: new LocalMaterialExtractor() });
  t.after(async () => {
    await handler.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const session = await request(handler, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await request(handler, `/api/sessions/${session.id}/artifacts/rawTranscript`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Original sentence.' }),
  });
  const original = await request(handler, `/api/sessions/${session.id}/artifacts/rawTranslation/ensure`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(original.segments[0].translatedText, '译：Original sentence.');

  await request(handler, `/api/sessions/${session.id}/artifacts/rawTranscript`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Refined sentence.' }),
  });
  let current = await request(handler, `/api/sessions/${session.id}`);
  assert.equal(current.artifacts.rawTranslation.segments[0].sourceText, 'Refined sentence.');
  assert.equal(current.artifacts.rawTranslation.segments[0].translatedText, '译：Original sentence.');
  assert.equal(current.artifacts.rawTranslation.segments[0].status, 'updating');

  llm.fail = true;
  const failed = await request(handler, `/api/sessions/${session.id}/artifacts/rawTranslation/ensure`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(failed.segments[0].status, 'error');
  assert.equal(failed.segments[0].translatedText, '译：Original sentence.');

  llm.fail = false;
  const replaced = await request(handler, `/api/sessions/${session.id}/artifacts/rawTranslation/ensure`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(replaced.segments[0].status, 'translated');
  assert.equal(replaced.segments[0].translatedText, '译：Refined sentence.');
});


test('changing a completed Raw translation target preserves the old language through failure and regenerates on retry', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-raw-target-cache-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const llm = new RawTranslationLLM();
  const generate = llm.generate.bind(llm);
  llm.generate = async (args) => {
    const result = await generate(args);
    return { ...result, content: `${args.prompt.match(/CURRENT SENTENCE into ([^.]+)\./)[1]}: ${result.content}` };
  };
  const handler = createApp({ store, stt: new TestSTT(), llm, materials: new LocalMaterialExtractor() });
  const session = await request(handler, '/api/sessions', postJson);
  await editRaw(handler, session.id, 'Cached sentence.');
  const chinese = await ensureArtifact(handler, session.id, 'rawTranslation');
  assert.match(chinese.content, /^Chinese:/);
  // Existing sessions predate unit-level language metadata.
  const legacy = await store.get(session.id);
  delete legacy.artifacts.rawTranslation.segments[0].targetLanguage;
  delete legacy.artifacts.rawTranslation.segments[0].translatedTargetLanguage;
  await store.save(legacy);
  await request(handler, `/api/sessions/${session.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetLanguage: 'Japanese' }) });
  assert.equal(llm.rawCalls.length, 1, 'changing the target does not generate automatically');
  llm.delay = 40;
  llm.fail = true;
  const pending = ensureArtifact(handler, session.id, 'rawTranslation');
  await waitFor(() => llm.rawCalls.length === 2);
  const updating = (await store.get(session.id)).artifacts.rawTranslation;
  assert.equal(updating.content, chinese.content);
  assert.equal(updating.segments[0].status, 'updating');
  assert.equal(updating.segments[0].translatedTargetLanguage, 'Chinese');
  const failed = await pending;
  assert.equal(failed.generationState, 'error');
  assert.equal(failed.stale, true);
  assert.equal(failed.content, chinese.content);
  assert.equal(failed.segments[0].translatedTargetLanguage, 'Chinese');
  llm.fail = false;
  llm.delay = 0;
  const japanese = await ensureArtifact(handler, session.id, 'rawTranslation');
  assert.match(japanese.content, /^Japanese:/);
  assert.equal(japanese.segments[0].translatedTargetLanguage, 'Japanese');
  assert.equal(japanese.stale, false);
  assert.equal(llm.rawCalls.length, 3);
  await ensureArtifact(handler, session.id, 'rawTranslation');
  assert.equal(llm.rawCalls.length, 3, 'unchanged output in the requested language is cached');
});

test('document model migration preserves the separately selected Raw translation model', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-raw-model-fallback-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const llm = new RawTranslationLLM();
  const originalGenerate = llm.generate.bind(llm);
  llm.listModels = async () => ['available-on-windows:4b'];
  llm.generate = async (options) => {
    if (options.model !== 'available-on-windows:4b') throw new Error(`model ${options.model} not found`);
    return originalGenerate(options);
  };
  const handler = createApp({ store, stt: new TestSTT(), llm, materials: new LocalMaterialExtractor() });
  const created = await request(handler, '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(created.llmModel, 'available-on-windows:4b');
  const saved = await store.create({ llmModel: 'missing-default:4b', liveTranslationModel: 'available-on-windows:4b' });
  await store.setArtifact(saved.id, 'rawTranscript', { content: 'Translate this sentence.', source: 'manual-edit' }, { preserve: true });

  const reopened = await request(handler, `/api/sessions/${saved.id}`);
  assert.equal(reopened.llmModel, 'available-on-windows:4b');
  const translated = await request(handler, `/api/sessions/${saved.id}/artifacts/rawTranslation/ensure`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });

  assert.equal(translated.generationState, 'idle');
  assert.equal(translated.segments[0].status, 'translated');
  assert.equal(llm.rawCalls[0].model, 'available-on-windows:4b');
  assert.equal((await store.get(saved.id)).llmModel, 'available-on-windows:4b');
});

test('Raw translation reports missing Ollama setup before marking every sentence failed', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-raw-no-ollama-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const llm = {
    async listModels() { return []; },
    async generate() { throw new Error('generate must not run without an installed model'); },
  };
  const handler = createApp({ store, stt: new TestSTT(), llm, materials: new LocalMaterialExtractor() });
  const session = await store.create();
  await store.setArtifact(session.id, 'rawTranscript', { content: 'Translate this sentence.', source: 'manual-edit' }, { preserve: true });

  const response = await requestResult(handler, `/api/sessions/${session.id}/artifacts/rawTranslation/ensure`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });

  assert.equal(response.status, 503);
  assert.equal(response.json.code, 'OLLAMA_NOT_READY');
  assert.match(response.json.error, /start Ollama.*install a model/i);
  assert.equal((await store.get(session.id)).artifacts.rawTranslation, null);
});

test('automatic Raw translation settles without retrying forever when Ollama is unavailable', { timeout: 2_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-raw-no-ollama-live-test-'));
  const store = new SessionStore(root);
  await store.init();
  const llm = {
    async listModels() { return []; },
    async generate() { throw new Error('generate must not run without an installed model'); },
  };
  const handler = createApp({ store, stt: new TestSTT(), llm, materials: new LocalMaterialExtractor() });
  t.after(async () => {
    await handler.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const session = await request(handler, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await request(handler, `/api/sessions/${session.id}/dictation/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await request(handler, `/api/sessions/${session.id}/dictation/chunks?sequence=0`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wavChunk() });
  await request(handler, `/api/sessions/${session.id}/dictation/finalize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

  await handler.idle();
  const snapshot = await handler.runtimeSnapshot();
  assert.equal(snapshot.rawTranslationJobs, 0);
  assert.equal(snapshot.llm.active, 0);
  assert.equal(snapshot.llm.queued, 0);
  assert.ok((await store.get(session.id)).artifacts.rawTranscript?.content);
});

test('automatic Raw translation waits for first-run Ollama setup and resumes when required models are ready', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-raw-bootstrap-wait-test-'));
  const store = new SessionStore(root);
  await store.init();
  const llm = new RawTranslationLLM();
  let setupStatus = 'pulling';
  let finishSetup;
  const setup = new Promise((resolve) => { finishSetup = resolve; });
  const ollamaBootstrap = {
    snapshot() { return { status: setupStatus, model: 'documents:4b' }; },
    ensureReady() { return setup; },
  };
  const handler = createApp({
    store,
    stt: new TestSTT(),
    llm,
    materials: new LocalMaterialExtractor(),
    ollamaBootstrap,
  });
  t.after(async () => {
    await handler.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const session = await request(handler, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await request(handler, `/api/sessions/${session.id}/dictation/start`, postJson);
  await request(handler, `/api/sessions/${session.id}/live-translation`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }),
  });
  await request(handler, `/api/sessions/${session.id}/dictation/chunks?sequence=0`, {
    method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wavChunk(),
  });
  await request(handler, `/api/sessions/${session.id}/dictation/finalize`, postJson);

  assert.equal(llm.rawCalls.length, 0, 'translation must not fail against Ollama while bootstrap is active');
  assert.equal((await store.get(session.id)).liveTranslation.status, 'pending');

  setupStatus = 'ready';
  finishSetup({ status: 'ready', selectedModel: 'documents:4b' });
  await waitFor(() => llm.rawCalls.length > 0);
  await handler.idle();

  const translated = (await store.get(session.id)).artifacts.rawTranslation;
  assert.equal(translated.generationState, 'idle');
  assert.equal(translated.segments[0].status, 'translated');
  assert.match(translated.content, /^译：/);
});

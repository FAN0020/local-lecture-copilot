import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { SessionStore } from '../src/store.js';

// Every inference provider in this file is a mock. No runtime, native binary,
// model download, microphone, or HTTP server is involved.
class SentenceSTT {
  constructor(outputs) { this.outputs = outputs; this.calls = 0; }
  async transcribe(audioPath, options) {
    assert.ok((await fs.stat(audioPath)).size > 0);
    const content = this.outputs[this.calls++] || '';
    return {
      content,
      language: 'en',
      segments: content ? [{ start: 0, end: 0.1, text: content }] : [],
      provider: 'mock-stt',
      model: options.model,
    };
  }
}

class TranslationLLM {
  constructor({ block = null, fail = null, delays = {} } = {}) {
    this.calls = [];
    this.block = block;
    this.fail = fail;
    this.delays = delays;
    this.active = 0;
    this.maxActive = 0;
  }
  async listModels() { return ['mock-local:1b']; }
  async generate(args) {
    assert.ok(args.prompt.includes('CURRENT SENTENCE:'), 'only Raw sentence translation is authorized');
    assert.ok(args.signal instanceof AbortSignal, 'cancellation reaches the provider');
    const source = args.prompt.split('\nCURRENT SENTENCE:\n')[1];
    this.calls.push({ ...args, source });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (source === this.block) {
        await new Promise((resolve, reject) => {
          if (args.signal.aborted) return reject(args.signal.reason);
          args.signal.addEventListener('abort', () => reject(args.signal.reason), { once: true });
        });
      }
      if (this.delays[source]) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, this.delays[source]);
          args.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(args.signal.reason);
          }, { once: true });
        });
      }
      if (source === this.fail) throw new Error('Mock translation unavailable');
      return { content: `译：${source}`, provider: 'mock-llm', model: args.model, metrics: {} };
    } finally {
      this.active -= 1;
    }
  }
}

function wavChunk() {
  const samples = 1600;
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

async function request(handler, endpoint, { method = 'GET', body, expectedStatus } = {}) {
  const binary = Buffer.isBuffer(body);
  const req = Readable.from(body === undefined ? [] : [binary ? body : Buffer.from(JSON.stringify(body))]);
  req.url = endpoint;
  req.method = method;
  req.headers = body === undefined ? {} : { 'content-type': binary ? 'audio/wav' : 'application/json' };
  const result = await new Promise((resolve, reject) => {
    const res = {
      status: 200,
      writeHead(status) { this.status = status; },
      end(chunk) { resolve({ status: this.status, json: JSON.parse(Buffer.from(chunk).toString('utf8')) }); },
    };
    handler(req, res).catch(reject);
  });
  if (expectedStatus) assert.equal(result.status, expectedStatus, JSON.stringify(result.json));
  else assert.ok(result.status >= 200 && result.status < 300, `${result.status}: ${JSON.stringify(result.json)}`);
  return result.json;
}

async function waitFor(check, message = 'live translation did not settle') {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function fixture(t, outputs = [], llm = new TranslationLLM()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-live-translation-test-'));
  const store = new SessionStore(root);
  await store.init();
  const handlers = [];
  const makeHandler = (currentStore, provider) => {
    const handler = createApp({ store: currentStore, stt: new SentenceSTT(outputs), llm: provider, materials: {} });
    handlers.push(handler);
    return handler;
  };
  const handler = makeHandler(store, llm);
  t.after(async () => {
    await Promise.all(handlers.map((current) => current.close()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const session = await request(handler, '/api/sessions', { method: 'POST', body: { llmModel: 'mock-local:1b', targetLanguage: 'Chinese' } });
  const base = `/api/sessions/${session.id}`;
  return {
    root, store, handler, llm, session, base, makeHandler,
    read: () => request(handler, base),
    start: () => request(handler, `${base}/dictation/start`, { method: 'POST', body: {} }),
    chunk: (sequence) => request(handler, `${base}/dictation/chunks?sequence=${sequence}`, { method: 'POST', body: wavChunk() }),
    stop: () => request(handler, `${base}/dictation/finalize`, { method: 'POST', body: {} }),
    enable: (enabled) => request(handler, `${base}/live-translation`, { method: 'POST', body: { enabled } }),
    edit: (content) => request(handler, `${base}/artifacts/rawTranscript`, { method: 'PUT', body: { content } }),
  };
}

async function idle(handler) {
  return waitFor(async () => {
    const snapshot = await handler.runtimeSnapshot();
    return !snapshot.rawTranslationJobs && !snapshot.liveTranslationJobs
      && !snapshot.whisper.active && !snapshot.whisper.queued && !snapshot.llm.active && !snapshot.llm.queued;
  });
}

async function translated(f, count) {
  return waitFor(async () => {
    const current = await f.read();
    const units = current.artifacts.rawTranslation?.segments || [];
    return units.filter((unit) => unit.status === 'translated').length === count ? current : null;
  }, `expected ${count} translated sentence units`);
}

test('recording and Stop perform no translation until bilingual mode is explicitly enabled', async (t) => {
  const f = await fixture(t, ['First sentence.', 'An unfinished tail']);
  assert.equal(Boolean(f.session.liveTranslation?.enabled), false);
  await f.start();
  await f.chunk(0);
  await f.chunk(1);
  await f.stop();
  await idle(f.handler);
  assert.equal(f.llm.calls.length, 0);
  assert.equal((await f.read()).artifacts.rawTranslation, null);
});

test('live translation refreshes an unfinished tail immediately and promotes it without a blank state on Stop', async (t) => {
  const f = await fixture(t, ['First sentence.', 'The next', 'sentence is complete.', 'A final tail']);
  await f.start();
  await f.chunk(0);
  assert.equal(f.llm.calls.length, 0);
  const enabled = await f.enable(true);
  assert.equal(enabled.liveTranslation.enabled, true);
  assert.ok(['idle', 'pending', 'running'].includes(enabled.liveTranslation.status));
  await translated(f, 1);
  await idle(f.handler);

  await f.chunk(1);
  await idle(f.handler);
  assert.deepEqual(f.llm.calls.map((call) => call.source), ['First sentence.', 'The next']);
  await f.chunk(2);
  await translated(f, 2);
  await idle(f.handler);
  assert.deepEqual(f.llm.calls.map((call) => call.source), [
    'First sentence.', 'The next', 'The next sentence is complete.',
  ]);
  assert.match(f.llm.calls[2].prompt, /PRECEDING CONTEXT[\s\S]*First sentence\./);

  await f.chunk(3);
  await idle(f.handler);
  assert.equal(f.llm.calls.length, 4, 'a partial sentence is translated immediately');
  await f.stop();
  const completed = await translated(f, 3);
  await idle(f.handler);
  assert.equal(completed.dictation.status, 'complete');
  assert.equal(completed.artifacts.rawTranslation.pendingText, '');
  assert.deepEqual(f.llm.calls.map((call) => call.source), [
    'First sentence.', 'The next', 'The next sentence is complete.', 'A final tail',
  ]);
  await f.enable(true);
  await idle(f.handler);
  assert.equal(f.llm.calls.length, 4, 'repeated enabling does not regenerate saved translations');
  assert.equal(f.llm.maxActive, 1);
});

test('source corrections keep the last translation and never trigger an automatic replacement', async (t) => {
  const f = await fixture(t, ['Original sentence.']);
  await f.start();
  await f.enable(true);
  await f.chunk(0);
  const original = await translated(f, 1);
  await idle(f.handler);
  const unitId = original.artifacts.rawTranslation.segments[0].id;
  await f.edit('Corrected sentence.');
  await f.enable(true);
  await idle(f.handler);
  const corrected = await f.read();
  const unit = corrected.artifacts.rawTranslation.segments[0];
  assert.equal(unit.id, unitId);
  assert.equal(unit.sourceText, 'Corrected sentence.');
  assert.equal(unit.translatedText, '译：Original sentence.');
  assert.equal(unit.status, 'updating');
  assert.equal(f.llm.calls.length, 1, 'corrections need an explicit manual translation request');
});

test('disabling bilingual mode aborts live generation, preserves completed units, and leaves later speech untranslated', async (t) => {
  const llm = new TranslationLLM({ block: 'Second sentence.' });
  const f = await fixture(t, ['First sentence.', 'Second sentence.', 'Third sentence.'], llm);
  await f.start();
  await f.enable(true);
  await f.chunk(0);
  await translated(f, 1);
  await idle(f.handler);
  await f.chunk(1);
  await waitFor(() => llm.calls.length === 2, 'second live translation did not start');
  const disabled = await f.enable(false);
  assert.equal(disabled.liveTranslation.enabled, false);
  await idle(f.handler);
  assert.equal(llm.calls[1].signal.aborted, true);
  let current = await f.read();
  assert.equal(current.liveTranslation.status, 'idle');
  assert.equal(current.artifacts.rawTranslation.segments[0].translatedText, '译：First sentence.');
  assert.equal(current.artifacts.rawTranslation.segments[1].translatedText, '');
  await f.chunk(2);
  await f.stop();
  await idle(f.handler);
  current = await f.read();
  assert.equal(current.artifacts.rawTranslation.segments[0].translatedText, '译：First sentence.');
  assert.equal(llm.calls.length, 2);
});

test('restored enabled sessions stay dormant and retain translations until another explicit action', async (t) => {
  const f = await fixture(t, ['Saved sentence.']);
  await f.start();
  await f.enable(true);
  await f.chunk(0);
  await translated(f, 1);
  await idle(f.handler);
  await f.stop();
  await idle(f.handler);
  await f.edit('Saved sentence. Deferred sentence.');
  await idle(f.handler);
  await f.handler.close();
  // Simulate the durable state left by an interrupted live worker.
  await f.store.setLiveTranslation(f.session.id, { enabled: true, status: 'running' });
  const reopened = new SessionStore(f.root);
  await reopened.init();
  const llm = new TranslationLLM();
  const handler = f.makeHandler(reopened, llm);
  const restored = await request(handler, f.base);
  await idle(handler);
  assert.equal(restored.liveTranslation.enabled, true);
  assert.equal(restored.liveTranslation.status, 'idle');
  assert.equal(restored.artifacts.rawTranslation.segments[0].translatedText, '译：Saved sentence.');
  assert.equal(llm.calls.length, 0);

  const manual = await request(handler, `${f.base}/artifacts/rawTranslation/ensure`, { method: 'POST', body: {} });
  assert.deepEqual(llm.calls.map((call) => call.source), ['Deferred sentence.']);
  assert.equal(manual.segments[0].translatedText, '译：Saved sentence.');
  assert.equal(manual.segments[1].translatedText, '译：Deferred sentence.');
});

test('resuming recording translates new speech without processing the previous untranslated backlog', async (t) => {
  const f = await fixture(t, ['Old untranslated sentence.', 'New sentence.']);
  await f.start();
  await f.chunk(0);
  await f.stop();
  await f.enable(true);
  await idle(f.handler);
  assert.equal(f.llm.calls.length, 0, 'an enabled stopped session remains dormant');
  await f.start();
  await f.chunk(0);
  await translated(f, 1);
  await f.stop();
  await idle(f.handler);
  assert.deepEqual(f.llm.calls.map((call) => call.source), ['New sentence.']);
  const current = await f.read();
  assert.equal(current.artifacts.rawTranslation.segments[0].sourceText, 'Old untranslated sentence.');
  assert.equal(current.artifacts.rawTranslation.segments[0].translatedText, '');
  assert.equal(current.artifacts.rawTranslation.segments[1].translatedText, '译：New sentence.');
});

test('new speech can transcribe while live translation continues, then every saved sentence translates once', async (t) => {
  const llm = new TranslationLLM({ delays: { 'Second sentence.': 60 } });
  const f = await fixture(t, ['First sentence.', 'Second sentence.', 'Third sentence.'], llm);
  await f.start();
  await f.enable(true);
  await f.chunk(0);
  await translated(f, 1);
  await idle(f.handler);
  await f.chunk(1);
  await waitFor(() => llm.calls.length === 2, 'second live translation did not start');
  const running = f.handler.inferenceScheduler.snapshot().running;
  assert.equal(running.some((entry) => entry.priority === 4), false, 'live translation uses the bounded Ollama queue independently of Whisper');
  await f.chunk(2);
  await translated(f, 3);
  await idle(f.handler);
  assert.equal(llm.calls[1].signal.aborted, false);
  assert.deepEqual(llm.calls.map((call) => call.source), ['First sentence.', 'Second sentence.', 'Third sentence.']);
  const current = await f.read();
  assert.equal(current.artifacts.rawTranslation.segments[0].translatedText, '译：First sentence.');
  assert.equal(current.artifacts.rawTranslation.segments[1].translatedText, '译：Second sentence.');
  assert.equal(current.artifacts.rawTranslation.segments[2].translatedText, '译：Third sentence.');
  assert.equal(llm.maxActive, 1);
});

test('a failed live sentence is retained for manual retry while later new sentences can translate', async (t) => {
  const llm = new TranslationLLM({ fail: 'First sentence.' });
  const f = await fixture(t, ['First sentence.', 'Second sentence.'], llm);
  await f.start();
  await f.enable(true);
  await f.chunk(0);
  await waitFor(() => llm.calls.length === 1);
  await idle(f.handler);
  await f.chunk(1);
  await translated(f, 1);
  await idle(f.handler);
  await f.stop();
  await idle(f.handler);
  assert.deepEqual(llm.calls.map((call) => call.source), ['First sentence.', 'Second sentence.']);
  const current = await f.read();
  assert.equal(current.artifacts.rawTranslation.segments[0].status, 'error');
  assert.equal(current.artifacts.rawTranslation.segments[1].translatedText, '译：Second sentence.');
});

test('a stopped new-only request preserves its scope and cannot bypass manual action admission', async (t) => {
  const llm = new TranslationLLM({ block: 'First sentence.' });
  const f = await fixture(t, [], llm);
  await f.edit('First sentence.');
  const pending = request(f.handler, `${f.base}/artifacts/rawTranslation/ensure`, { method: 'POST', body: { newOnly: true } });
  await waitFor(() => llm.calls.length === 1);
  const other = await request(f.handler, '/api/sessions', { method: 'POST', body: {} });
  const base = `/api/sessions/${other.id}`;
  await request(f.handler, `${base}/artifacts/rawTranscript`, { method: 'PUT', body: { content: 'Second sentence.' } });
  for (const body of [{}, { newOnly: true }]) {
    const rejected = await request(f.handler, `${base}/artifacts/rawTranslation/ensure`, { method: 'POST', body, expectedStatus: 409 });
    assert.equal(rejected.code, 'PROCESSING_ACTIVE');
  }
  await f.enable(false);
  await pending;
  assert.equal(llm.calls[0].signal.aborted, true);
  await request(f.handler, `${base}/artifacts/rawTranslation/ensure`, { method: 'POST', body: {} });
  assert.deepEqual(llm.calls.map((call) => call.source), ['First sentence.', 'Second sentence.']);
});

test('manual work pauses a recording-started one-shot translation even after Stop', async (t) => {
  const llm = new TranslationLLM({ block: 'First sentence.' });
  const f = await fixture(t, ['First sentence.'], llm);
  await f.start();
  await f.chunk(0);
  const pending = request(f.handler, `${f.base}/artifacts/rawTranslation/ensure`, { method: 'POST', body: { newOnly: true } });
  await waitFor(() => llm.calls.length === 1);
  await f.stop();
  assert.equal(llm.active, 1, 'the one-shot request outlives saving the recording');
  const other = await request(f.handler, '/api/sessions', { method: 'POST', body: {} });
  const base = `/api/sessions/${other.id}`;
  await request(f.handler, `${base}/artifacts/rawTranscript`, { method: 'PUT', body: { content: 'Second sentence.' } });
  let completed = false;
  const manual = request(f.handler, `${base}/artifacts/rawTranslation/ensure`, { method: 'POST', body: {} }).then((value) => { completed = true; return value; });
  await waitFor(() => completed, 'manual admission did not pause the unregistered live request');
  await Promise.all([pending, manual]);
  assert.equal(llm.calls[0].signal.aborted, true);
  assert.deepEqual(llm.calls.map((call) => call.source), ['First sentence.', 'Second sentence.']);
  assert.equal(llm.maxActive, 1);
});

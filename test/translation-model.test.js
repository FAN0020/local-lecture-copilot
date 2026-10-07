import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { DEFAULT_LIVE_TRANSLATION_MODEL } from '../src/lib.js';
import { SessionStore } from '../src/store.js';

const DOCUMENT_MODEL = 'qwen3.5:4b';

class RoleModelLLM {
  constructor({ missingTranslationModel = false } = {}) {
    this.calls = [];
    this.downloads = [];
    this.missingTranslationModel = missingTranslationModel;
  }
  async listModels() { return this.missingTranslationModel ? [DOCUMENT_MODEL] : [DOCUMENT_MODEL, DEFAULT_LIVE_TRANSLATION_MODEL]; }
  async pull(model) { this.downloads.push(model); }
  async install(model) { this.downloads.push(model); }
  async generate(args) {
    this.calls.push(args);
    let content;
    if (args.prompt.includes('CURRENT SENTENCE:')) {
      assert.match(args.system, /faithful translator/);
      assert.match(args.system, /Do not summarize, omit information/);
      if (this.missingTranslationModel) throw new Error(`Ollama request failed (404): model '${args.model}' not found`);
      content = `译：${args.prompt.split('\nCURRENT SENTENCE:\n')[1]}`;
    } else if (args.prompt.startsWith('Transcript:\n')) {
      content = args.prompt.slice('Transcript:\n'.length);
      assert.ok(content, 'cleanup receives a target region');
    } else {
      assert.ok(args.prompt.includes('CURRENT BLOCK:'), 'unexpected document generation');
      content = `文档译文：${args.prompt.split('\nCURRENT BLOCK:\n')[1]}`;
    }
    return { content, model: args.model, provider: 'mock-role-model', metrics: {} };
  }
}

const mockStt = {
  async transcribe() {
    return {
      content: 'Live sentence.', language: 'en', provider: 'mock-stt', model: 'base',
      segments: [{ start: 0, end: 0.1, text: 'Live sentence.' }],
    };
  },
};

function wavChunk() {
  const buffer = Buffer.alloc(44 + 3200);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
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
  buffer.writeUInt32LE(3200, 40);
  return buffer;
}

async function request(handler, endpoint, { method = 'GET', body } = {}) {
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
  assert.ok(result.status >= 200 && result.status < 300, `${result.status}: ${JSON.stringify(result.json)}`);
  return result.json;
}

async function fixture(t, llm = new RoleModelLLM()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-translation-model-test-'));
  const store = new SessionStore(root);
  await store.init();
  // Both providers are mocks; creating this handler never loads a model.
  const handler = createApp({ store, stt: mockStt, llm, materials: {} });
  t.after(async () => {
    await handler.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const create = (input = {}) => request(handler, '/api/sessions', { method: 'POST', body: { llmModel: DOCUMENT_MODEL, ...input } });
  const edit = (session, content) => request(handler, `/api/sessions/${session.id}/artifacts/rawTranscript`, { method: 'PUT', body: { content } });
  const ensure = (session, artifact) => request(handler, `/api/sessions/${session.id}/artifacts/${artifact}/ensure`, { method: 'POST', body: {} });
  return { root, store, handler, llm, create, edit, ensure };
}

async function waitFor(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('mock live translation did not settle');
}

async function liveSentence(f, session) {
  const base = `/api/sessions/${session.id}`;
  await request(f.handler, `${base}/dictation/start`, { method: 'POST', body: {} });
  await request(f.handler, `${base}/live-translation`, { method: 'POST', body: { enabled: true } });
  await request(f.handler, `${base}/dictation/chunks?sequence=0`, { method: 'POST', body: wavChunk() });
  return waitFor(async () => {
    const current = await request(f.handler, base);
    const unit = current.artifacts.rawTranslation?.segments[0];
    return ['translated', 'error'].includes(unit?.status) && current.liveTranslation.status === 'idle' ? current : null;
  });
}

test('new sessions default to a small Raw translation model independently of the document model', async (t) => {
  const f = await fixture(t);
  assert.equal(DEFAULT_LIVE_TRANSLATION_MODEL, 'qwen2.5:1.5b-instruct');
  const session = await f.store.create({ llmModel: DOCUMENT_MODEL });
  assert.equal(session.liveTranslationModel, DEFAULT_LIVE_TRANSLATION_MODEL);
  assert.equal(session.llmModel, DOCUMENT_MODEL);
  const explicit = await f.store.create({ llmModel: DOCUMENT_MODEL, liveTranslationModel: 'custom-translation:2b' });
  assert.equal(explicit.liveTranslationModel, 'custom-translation:2b');
});

test('legacy sessions migrate the missing translation model while preserving explicit choices across restart', async (t) => {
  const f = await fixture(t);
  const legacy = await f.store.create({ llmModel: DOCUMENT_MODEL });
  delete legacy.liveTranslationModel;
  await f.store.save(legacy);
  const configured = await f.store.create({ llmModel: 'custom-docs:4b', liveTranslationModel: 'custom-translation:2b' });
  const reopened = new SessionStore(f.root);
  await reopened.init();
  assert.equal((await reopened.get(legacy.id)).liveTranslationModel, DEFAULT_LIVE_TRANSLATION_MODEL);
  assert.equal((await reopened.get(legacy.id)).llmModel, DOCUMENT_MODEL);
  const restored = await reopened.get(configured.id);
  assert.equal(restored.liveTranslationModel, 'custom-translation:2b');
  assert.equal(restored.llmModel, 'custom-docs:4b');
  const restartedAgain = new SessionStore(f.root);
  await restartedAgain.init();
  assert.equal((await restartedAgain.get(legacy.id)).liveTranslationModel, DEFAULT_LIVE_TRANSLATION_MODEL);
  assert.equal((await restartedAgain.get(configured.id)).liveTranslationModel, 'custom-translation:2b');
});

test('manual Raw translation uses the small model while cleanup and document translation retain the document model', async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  assert.equal(session.liveTranslationModel, DEFAULT_LIVE_TRANSLATION_MODEL);
  await f.edit(session, 'First sentence.');
  const raw = await f.ensure(session, 'rawTranslation');
  const cleaned = await f.ensure(session, 'cleanedTranscript');
  const document = await f.ensure(session, 'translation');
  assert.equal(raw.segments[0].model, DEFAULT_LIVE_TRANSLATION_MODEL);
  assert.equal(cleaned.model, DOCUMENT_MODEL);
  assert.equal(document.model, DOCUMENT_MODEL);
  assert.deepEqual(f.llm.calls.map((call) => call.model), [DEFAULT_LIVE_TRANSLATION_MODEL, DOCUMENT_MODEL, DOCUMENT_MODEL]);
});

test('automatic Raw translation uses the small default without changing the document model', async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const current = await liveSentence(f, session);
  assert.equal(current.artifacts.rawTranslation.segments[0].model, DEFAULT_LIVE_TRANSLATION_MODEL);
  assert.equal(current.liveTranslationModel, DEFAULT_LIVE_TRANSLATION_MODEL);
  assert.equal(current.llmModel, DOCUMENT_MODEL);
  assert.deepEqual(f.llm.calls.map((call) => call.model), [DEFAULT_LIVE_TRANSLATION_MODEL]);
});

test('API create and PATCH preserve an explicit translation model and apply it to subsequent Raw requests', async (t) => {
  const f = await fixture(t);
  const session = await f.create({ liveTranslationModel: 'custom-translation:2b' });
  assert.equal(session.liveTranslationModel, 'custom-translation:2b');
  await f.edit(session, 'First sentence.');
  await f.ensure(session, 'rawTranslation');
  const updated = await request(f.handler, `/api/sessions/${session.id}`, {
    method: 'PATCH', body: { liveTranslationModel: 'other-translation:3b' },
  });
  assert.equal(updated.liveTranslationModel, 'other-translation:3b');
  assert.equal(updated.llmModel, DOCUMENT_MODEL);
  await f.edit(session, 'First sentence. Second sentence.');
  const raw = await f.ensure(session, 'rawTranslation');
  assert.deepEqual(f.llm.calls.map((call) => call.model), ['custom-translation:2b', 'other-translation:3b']);
  assert.equal(raw.segments[0].translatedText, '译：First sentence.');
  assert.equal(raw.segments[1].model, 'other-translation:3b');
  assert.equal((await f.store.get(session.id)).liveTranslationModel, 'other-translation:3b');
});

test('an unavailable translation model leaves live work retryable without falling back or downloading', async (t) => {
  const llm = new RoleModelLLM({ missingTranslationModel: true });
  const f = await fixture(t, llm);
  const session = await f.create();
  const failed = await liveSentence(f, session);
  const unit = failed.artifacts.rawTranslation.segments[0];
  assert.equal(unit.status, 'error');
  assert.match(unit.error, /model .*not found/);
  assert.equal(unit.translatedText, '');
  assert.equal(failed.artifacts.rawTranscript.content, 'Live sentence.');
  await request(f.handler, `/api/sessions/${session.id}/dictation/finalize`, { method: 'POST', body: {} });
  await waitFor(async () => !(await f.handler.runtimeSnapshot()).rawTranslationJobs);
  assert.deepEqual(llm.calls.map((call) => call.model), [DEFAULT_LIVE_TRANSLATION_MODEL], 'Stop does not retry failed live inference');
  assert.deepEqual(llm.downloads, []);

  const retryFailed = await f.ensure(session, 'rawTranslation');
  assert.equal(retryFailed.segments[0].status, 'error');
  assert.deepEqual(llm.calls.map((call) => call.model), [DEFAULT_LIVE_TRANSLATION_MODEL, DEFAULT_LIVE_TRANSLATION_MODEL]);
  llm.missingTranslationModel = false;
  const translated = await f.ensure(session, 'rawTranslation');
  assert.equal(translated.segments[0].translatedText, '译：Live sentence.');
  assert.equal(translated.segments[0].model, DEFAULT_LIVE_TRANSLATION_MODEL);
  assert.equal(llm.calls.length, 3);
  assert.equal(llm.calls.every((call) => call.model === DEFAULT_LIVE_TRANSLATION_MODEL), true);
  assert.deepEqual(llm.downloads, []);
});

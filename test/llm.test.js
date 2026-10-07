import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { OllamaProvider } from '../src/providers/llm.js';

test('Ollama requests a final answer instead of reasoning-only output', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      message: { content: 'Clean result' },
      total_duration: 10,
      prompt_eval_count: 4,
      eval_count: 2,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const provider = new OllamaProvider();
    const format = { type: 'object', properties: { edits: { type: 'array' } } };
    const result = await provider.generate({ model: 'qwen3.5:4b', prompt: 'Clean this.', format });
    assert.equal(result.content, 'Clean result');
    assert.equal(requestBody.think, false);
    assert.equal(requestBody.stream, false);
    assert.equal(requestBody.options.seed, 42);
    assert.equal(requestBody.keep_alive, '1m');
    assert.deepEqual(requestBody.format, format);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Ollama sends task context/output budgets and unloads with keep_alive zero', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith('/api/generate')) {
      return new Response(JSON.stringify({ done: true, done_reason: 'unload' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ message: { content: '译文' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const provider = new OllamaProvider({ keepAlive: '90s' });
    await provider.generate({ model: 'qwen', prompt: 'Translate.', numCtx: 2048, numPredict: 256 });
    await provider.unload('qwen');
    assert.equal(requests[0].body.keep_alive, '90s');
    assert.equal(requests[0].body.options.num_ctx, 2048);
    assert.equal(requests[0].body.options.num_predict, 256);
    assert.deepEqual(requests[1].body, { model: 'qwen', stream: false, keep_alive: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Ollama reports malformed JSON as an actionable provider error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{broken', { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const provider = new OllamaProvider();
    await assert.rejects(() => provider.generate({ model: 'test', prompt: 'Translate.' }), /malformed JSON/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Ollama distinguishes cancellation from timeout and passes an abort signal to fetch', async (t) => {
  // A real pending socket keeps Node 20 alive while AbortSignal.timeout's
  // unreferenced timer expires, just as a pending Ollama request does.
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const originalFetch = globalThis.fetch;
  let receivedSignal;
  globalThis.fetch = async (url, options) => {
    receivedSignal = options.signal;
    return originalFetch(url, options);
  };
  try {
    const timed = new OllamaProvider({ baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 50 });
    await assert.rejects(() => timed.generate({ model: 'test', prompt: 'Translate.' }), /timed out/i);
    assert.equal(receivedSignal instanceof AbortSignal, true);

    const controller = new AbortController();
    controller.abort();
    const cancelled = new OllamaProvider({ timeoutMs: 1000 });
    await assert.rejects(() => cancelled.generate({ model: 'test', prompt: 'Translate.', signal: controller.signal }), /cancelled/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

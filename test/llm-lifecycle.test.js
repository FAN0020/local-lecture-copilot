import assert from 'node:assert/strict';
import test from 'node:test';
import { OllamaLifecycle } from '../src/llm-lifecycle.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('Ollama lifecycle resets counters at the settled-request threshold', async () => {
  const events = [];
  const provider = {
    async generate({ prompt }) {
      events.push(`generate:${prompt}`);
      return { content: prompt };
    },
    async unload(model) { events.push(`unload:${model}`); },
  };
  const lifecycle = new OllamaLifecycle({ provider, maxRequests: 2, maxRunnerAgeMs: 60_000 });

  await lifecycle.generate({ model: 'qwen', prompt: 'one' });
  assert.equal(lifecycle.snapshot().models[0].requestsSinceReset, 1);
  await lifecycle.generate({ model: 'qwen', prompt: 'two' });

  const snapshot = lifecycle.snapshot();
  assert.deepEqual(events, ['generate:one', 'generate:two', 'unload:qwen']);
  assert.equal(snapshot.models[0].requestsSinceReset, 0);
  assert.equal(snapshot.resetCount, 1);
  assert.equal(snapshot.resetPending, false);
  assert.equal(snapshot.lastReset.reason, 'request-threshold');
  assert.equal(snapshot.lastReset.succeeded, true);
});

test('cancelled and failed provider attempts also consume the reset budget', async () => {
  const unloads = [];
  let attempt = 0;
  const provider = {
    async generate() {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
      throw new Error('failed');
    },
    async unload(model) { unloads.push(model); },
  };
  const lifecycle = new OllamaLifecycle({ provider, maxRequests: 2, maxRunnerAgeMs: 60_000 });
  await assert.rejects(lifecycle.generate({ model: 'qwen', prompt: 'cancel me' }), { name: 'AbortError' });
  assert.equal(lifecycle.snapshot().models[0].requestsSinceReset, 1);
  await assert.rejects(lifecycle.generate({ model: 'qwen', prompt: 'fail me' }), /failed/);
  assert.deepEqual(unloads, ['qwen']);
  assert.equal(lifecycle.snapshot().models[0].requestsSinceReset, 0);
  assert.equal(lifecycle.snapshot().cancelled, 1);
  assert.equal(lifecycle.snapshot().failed, 1);
});

test('Ollama lifecycle drains active work, blocks new work during one reset, and loses no callers', async () => {
  const first = deferred();
  const second = deferred();
  const unload = deferred();
  const events = [];
  const provider = {
    async generate({ prompt }) {
      events.push(`start:${prompt}`);
      if (prompt === 'first') await first.promise;
      if (prompt === 'second') await second.promise;
      events.push(`finish:${prompt}`);
      return { content: prompt };
    },
    async unload(model) {
      events.push(`unload-start:${model}`);
      await unload.promise;
      events.push(`unload-finish:${model}`);
    },
  };
  const lifecycle = new OllamaLifecycle({ provider, maxRequests: 1, maxRunnerAgeMs: 60_000 });
  const firstResult = lifecycle.generate({ model: 'qwen', prompt: 'first' });
  const secondResult = lifecycle.generate({ model: 'qwen', prompt: 'second' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lifecycle.snapshot().active, 2);

  first.resolve();
  assert.equal((await firstResult).content, 'first');
  const thirdResult = lifecycle.generate({ model: 'qwen', prompt: 'third' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.includes('start:third'), false, 'new work waits behind a pending reset');
  assert.equal(events.includes('unload-start:qwen'), false, 'reset waits for the other active request');

  second.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event === 'unload-start:qwen').length, 1);
  assert.equal(events.includes('start:third'), false, 'new work also waits for unload completion');
  unload.resolve();

  assert.equal((await secondResult).content, 'second');
  assert.equal((await thirdResult).content, 'third');
  assert.equal(events.filter((event) => event === 'start:third').length, 1);
  assert.equal(events.filter((event) => event === 'unload-start:qwen').length, 2, 'third completion starts the next threshold reset, not a duplicate first reset');
  assert.equal(lifecycle.snapshot().active, 0);
  assert.equal(lifecycle.snapshot().resetPending, false);
});

test('cancellation releases a completed request during unloading while later generation waits for reset', async (t) => {
  const unloadStarted = deferred();
  const unload = deferred();
  t.after(() => unload.resolve());
  const events = [];
  const provider = {
    async generate({ prompt }) {
      events.push(`generate:${prompt}`);
      return { content: prompt };
    },
    async unload() {
      events.push('unload-start');
      unloadStarted.resolve();
      await unload.promise;
      events.push('unload-finish');
    },
  };
  const lifecycle = new OllamaLifecycle({ provider, maxRequests: 1, maxRunnerAgeMs: 60_000 });
  const controller = new AbortController();
  let firstOutcome;
  const first = lifecycle.generate({ model: 'qwen', prompt: 'first', signal: controller.signal }).then(
    (value) => { firstOutcome = { value }; },
    (error) => { firstOutcome = { error }; },
  );
  await unloadStarted.promise;
  assert.equal(lifecycle.snapshot().active, 0);
  assert.equal(lifecycle.snapshot().resetPending, true);
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstOutcome?.error?.name, 'AbortError', 'the request rejects without waiting for unload');
  assert.equal(firstOutcome.error.code, 'ABORT_ERR');
  assert.deepEqual(events, ['generate:first', 'unload-start']);
  await first;

  const second = lifecycle.generate({ model: 'qwen', prompt: 'second' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['generate:first', 'unload-start'], 'the continuing reset still gates future LLM requests');
  assert.equal(lifecycle.snapshot().resetPending, true);
  unload.resolve();
  assert.equal((await second).content, 'second');
  assert.deepEqual(events, ['generate:first', 'unload-start', 'unload-finish', 'generate:second', 'unload-start', 'unload-finish']);
  assert.equal(lifecycle.snapshot().resetCount, 2);
  assert.equal(lifecycle.snapshot().resetPending, false);
});

test('Ollama lifecycle honors explicit idle resets and runner-age resets', async () => {
  let clock = 0;
  const unloads = [];
  const provider = {
    async generate({ prompt }) { return { content: prompt }; },
    async unload(model) { unloads.push(model); },
  };
  const lifecycle = new OllamaLifecycle({ provider, maxRequests: 50, maxRunnerAgeMs: 1000, now: () => clock });
  await lifecycle.generate({ model: 'qwen', prompt: 'one' });
  clock = 1200;
  await lifecycle.generate({ model: 'qwen', prompt: 'two' });
  assert.equal(lifecycle.snapshot().lastReset.reason, 'runner-age');
  await lifecycle.requestReset('qwen', 'session-stop');
  assert.equal(lifecycle.snapshot().lastReset.reason, 'session-stop');
  assert.deepEqual(unloads, ['qwen', 'qwen']);
});

test('an explicit reset waits for active inference before resolving', async () => {
  const generation = deferred();
  const events = [];
  const provider = {
    async generate() {
      events.push('generate-start');
      await generation.promise;
      events.push('generate-finish');
      return { content: 'done' };
    },
    async unload() { events.push('unload'); },
  };
  const lifecycle = new OllamaLifecycle({ provider, maxRequests: 50, maxRunnerAgeMs: 60_000 });
  const result = lifecycle.generate({ model: 'qwen', prompt: 'active' });
  await new Promise((resolve) => setImmediate(resolve));
  const reset = lifecycle.requestReset('qwen', 'session-stop');
  let resetResolved = false;
  void reset.then(() => { resetResolved = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resetResolved, false);
  assert.deepEqual(events, ['generate-start']);

  generation.resolve();
  await result;
  assert.equal(await reset, true);
  assert.deepEqual(events, ['generate-start', 'generate-finish', 'unload']);
});

test('a manual burst after a long idle recycles once before generation and stays warm for its next request', async () => {
  let clock = 0;
  const events = [];
  const unload = deferred();
  const provider = {
    async generate({ prompt }) {
      events.push(`generate:${prompt}`);
      return { content: prompt };
    },
    async unload() {
      events.push('unload');
      await unload.promise;
    },
  };
  const lifecycle = new OllamaLifecycle({ provider, maxRequests: 25, maxRunnerAgeMs: 300_000, now: () => clock });
  await lifecycle.generate({ model: 'qwen', prompt: 'previous' });
  clock = 600_000;
  const first = lifecycle.generate({ model: 'qwen', prompt: 'manual-one' });
  const second = lifecycle.generate({ model: 'qwen', prompt: 'manual-two' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['generate:previous', 'unload']);
  unload.resolve();
  await Promise.all([first, second]);
  await lifecycle.generate({ model: 'qwen', prompt: 'manual-three' });
  assert.deepEqual(events, ['generate:previous', 'unload', 'generate:manual-one', 'generate:manual-two', 'generate:manual-three']);
  assert.equal(lifecycle.snapshot().models[0].requestsSinceReset, 3);
  assert.equal(lifecycle.snapshot().resetCount, 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionPoller, sessionRefreshMarker } from '../web/session-poller.js';

function harness(options = {}) {
  const timers = new Map();
  let sequence = 0;
  const poller = new SessionPoller({
    refresh: async () => {},
    shouldContinue: () => true,
    delay: () => 1000,
    setTimer: (callback, milliseconds) => { timers.set(++sequence, { callback, milliseconds }); return sequence; },
    clearTimer: (id) => timers.delete(id),
    ...options,
  });
  async function advance() {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id);
    await timer.callback();
  }
  return { poller, timers, advance };
}

test('poll requests never overlap, even when restarted or awakened during a slow response', async () => {
  let complete;
  let requests = 0;
  const { poller, timers, advance } = harness({ refresh: () => {
    requests += 1;
    return new Promise((resolve) => { complete = resolve; });
  } });
  poller.start();
  const pending = advance();
  poller.start();
  poller.wake();
  poller.stop();
  poller.start();
  assert.equal(requests, 1);
  assert.equal(timers.size, 0);
  complete();
  await pending;
  assert.equal(timers.size, 1);
});

test('completion stops polling, and stopping in flight cannot resurrect its timer', async () => {
  const completed = harness({ shouldContinue: () => false });
  completed.poller.start();
  await completed.advance();
  assert.equal(completed.timers.size, 0);
  assert.equal(completed.poller.enabled, false);
  let complete;
  const stopped = harness({ refresh: () => new Promise((resolve) => { complete = resolve; }) });
  stopped.poller.start();
  const pending = stopped.advance();
  stopped.poller.stop();
  complete();
  await pending;
  assert.equal(stopped.timers.size, 0);
});

test('hidden tabs slow their next refresh and transient failures back off with a cap', async () => {
  let hidden = false;
  let fail = true;
  const { poller, timers, advance } = harness({
    delay: () => hidden ? 10_000 : 1000,
    refresh: async () => { if (fail) throw new Error('offline'); },
  });
  const delay = () => [...timers.values()][0]?.milliseconds;
  poller.start();
  assert.equal(delay(), 1000);
  hidden = true;
  poller.wake();
  assert.equal(delay(), 10_000);
  await advance();
  assert.equal(delay(), 20_000);
  await advance();
  assert.equal(delay(), 30_000);
  fail = false;
  hidden = false;
  await advance();
  assert.equal(delay(), 1000);
});

test('refresh markers avoid repeated rendering but detect progress and artifact changes', () => {
  const session = { id: 'lecture', updatedAt: 'same-time', processing: { status: 'running' }, asr: { pending: { revised: 2 } }, artifacts: { notes: { contentFingerprint: 'old' } } };
  const copy = structuredClone(session);
  assert.equal(sessionRefreshMarker(session), sessionRefreshMarker(copy));
  copy.asr.pending.revised = 1;
  assert.notEqual(sessionRefreshMarker(session), sessionRefreshMarker(copy));
  copy.asr.pending.revised = 2;
  copy.artifacts.notes.contentFingerprint = 'new';
  assert.notEqual(sessionRefreshMarker(session), sessionRefreshMarker(copy));
});

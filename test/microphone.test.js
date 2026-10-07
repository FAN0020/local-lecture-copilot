import assert from 'node:assert/strict';
import test from 'node:test';
import { MicrophoneTimeoutError, requestMicrophone } from '../web/microphone.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('microphone access resolves normally and clears its timeout', async () => {
  const stream = { getTracks: () => [] };
  const constraints = { audio: { channelCount: 1 } };
  const cleared = [];
  let requested;
  const result = await requestMicrophone(async (value) => {
    requested = value;
    return stream;
  }, constraints, {
    setTimer: () => 'microphone-timer',
    clearTimer: (timer) => cleared.push(timer),
  });

  assert.equal(result, stream);
  assert.equal(requested, constraints);
  assert.deepEqual(cleared, ['microphone-timer']);
});

test('a stalled microphone request times out and stops a stream that arrives late', async () => {
  const acquisition = deferred();
  let expire;
  let stops = 0;
  const request = requestMicrophone(() => acquisition.promise, { audio: true }, {
    timeoutMs: 100,
    setTimer: (callback) => {
      expire = callback;
      return 'microphone-timer';
    },
    clearTimer: () => {},
  });

  expire();
  await assert.rejects(request, MicrophoneTimeoutError);

  acquisition.resolve({ getTracks: () => [{ stop: () => { stops += 1; } }] });
  await acquisition.promise;
  await Promise.resolve();
  assert.equal(stops, 1);
});

test('microphone rejection is preserved and clears its timeout', async () => {
  const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  const cleared = [];

  await assert.rejects(requestMicrophone(() => Promise.reject(denied), { audio: true }, {
    setTimer: () => 'microphone-timer',
    clearTimer: (timer) => cleared.push(timer),
  }), (error) => error === denied);
  assert.deepEqual(cleared, ['microphone-timer']);
});

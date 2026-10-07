import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationProfiler } from '../src/translation-profiler.js';

test('translation diagnostics bound events, samples, tracked requests, and sessions', () => {
  let clock = 0;
  const profiler = createTranslationProfiler({
    enabled: true,
    maxEvents: 3,
    maxSamples: 2,
    maxTracked: 2,
    maxSessions: 2,
    clock: () => ++clock,
  });
  for (const sessionId of ['one', 'two', 'three']) {
    for (let index = 0; index < 6; index += 1) {
      const queueId = profiler.record(sessionId, 'queued');
      profiler.record(sessionId, 'worker-start', { queueId, sourceFingerprint: `source-${index}`, queueDepth: index });
      profiler.record(sessionId, 'provider-start', { requestId: `${sessionId}-${index}`, characters: index, concurrency: 1 });
      profiler.record(sessionId, 'provider-complete', { requestId: `${sessionId}-${index}` });
      profiler.record(sessionId, 'persisted', { startedAt: clock - 1 });
      profiler.record(sessionId, 'transcript-finalized', { sourceFingerprint: `source-${index}` });
    }
  }
  const all = profiler.all();
  assert.deepEqual(Object.keys(all), ['two', 'three']);
  assert.equal(all.three.events.length, 3);
  assert.equal(all.three.summary.queueWaitMs.length, 2);
  assert.equal(all.three.summary.providerLatencyMs.length, 2);
  assert.equal(all.three.summary.persistenceLatencyMs.length, 2);
  assert.equal(all.three.retained.queued, 0);
  assert.equal(all.three.retained.providerStarted, 0);
  assert.equal(all.three.retained.transcriptFingerprints, 2);
});

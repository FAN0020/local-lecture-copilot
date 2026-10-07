import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASR_PRIORITY,
  InferenceScheduler,
  projectTranscript,
  resolveAsrModelPlan,
  summarizeAsrBacklog,
} from '../src/asr-pipeline.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('ASR model defaults are selected only from installed models with ordered fallbacks', () => {
  const full = resolveAsrModelPlan(['base', 'small', 'medium', 'turbo', 'large'], { selectedModel: 'base' });
  assert.deepEqual(full.models, { provisional: 'base', revised: 'turbo', highQuality: 'large' });
  assert.deepEqual(full.fallbacks.revised.slice(0, 3), ['turbo', 'medium', 'base']);

  const bundledOnly = resolveAsrModelPlan(['base'], { selectedModel: 'base' });
  assert.deepEqual(bundledOnly.models, { provisional: 'base', revised: 'base', highQuality: 'base' });
  assert.equal(bundledOnly.enabled, true);

  const unavailable = resolveAsrModelPlan([], { selectedModel: 'large' });
  assert.equal(unavailable.enabled, false);
  assert.equal(unavailable.models.provisional, null);
});

test('live defaults prefer a light installed model while explicit higher-accuracy selections remain available', () => {
  const plan = resolveAsrModelPlan(['tiny', 'base', 'small', 'medium', 'turbo', 'large']);
  assert.deepEqual(plan.fallbacks.provisional.slice(0, 3), ['base', 'tiny', 'small']);
  assert.equal(resolveAsrModelPlan(['tiny', 'small']).models.provisional, 'tiny');
  assert.equal(resolveAsrModelPlan(['base', 'small'], { stageModels: { provisional: 'small' } }).models.provisional, 'small');
});

test('explicit stage selections take priority while retaining installed fallbacks', () => {
  const plan = resolveAsrModelPlan(['tiny', 'base', 'small', 'turbo', 'large'], {
    stageModels: { provisional: 'tiny', revised: 'base', highQuality: 'small' },
  });
  assert.deepEqual(plan.models, { provisional: 'tiny', revised: 'base', highQuality: 'small' });
  assert.deepEqual(plan.selectedStageModels, { provisional: 'tiny', revised: 'base', highQuality: 'small' });
  assert.equal(plan.fallbacks.provisional[0], 'tiny');
  assert.equal(plan.fallbacks.revised[0], 'base');
  assert.equal(plan.fallbacks.highQuality[0], 'small');

  const missingSelection = resolveAsrModelPlan(['base', 'small'], {
    stageModels: { provisional: 'tiny', revised: 'base', highQuality: 'large' },
  });
  assert.deepEqual(missingSelection.models, { provisional: 'base', revised: 'base', highQuality: 'small' });
  assert.deepEqual(missingSelection.selectedStageModels, { provisional: null, revised: 'base', highQuality: null });
});

test('ASR backlog separates initial transcription from eligible refinement and excludes finished or obsolete work', () => {
  const segment = (id, provisionalStatus, revisedStatus, versions = {}, highQualityStatus = 'pending') => ({
    id,
    versions,
    stages: {
      provisional: { status: provisionalStatus },
      revised: { status: revisedStatus },
      highQuality: { status: highQualityStatus },
    },
  });
  const backlog = summarizeAsrBacklog([
    segment('draft-queued', 'pending', 'pending'),
    segment('draft-active', 'running', 'pending'),
    segment('refine-queued', 'complete', 'pending', { provisional: { content: 'Draft.' } }),
    segment('refine-active', 'complete', 'running', { provisional: { content: 'Draft.' } }),
    segment('complete', 'complete', 'complete', { provisional: { content: 'Draft.' }, revised: { content: 'Final.' }, highQuality: { content: 'Best.' } }, 'complete'),
    segment('cancelled', 'cancelled', 'cancelled', {}, 'cancelled'),
    segment('obsolete', 'obsolete', 'obsolete', {}, 'obsolete'),
  ]);

  assert.deepEqual(backlog.transcription, { queued: 1, active: 1, total: 2 });
  assert.deepEqual(backlog.refinement, { queued: 1, active: 1, total: 2 });
  assert.deepEqual(backlog.highQuality, { queued: 4, active: 0, total: 4 });
});

test('pending inference follows priority while preserving FIFO within a stage', async () => {
  const scheduler = new InferenceScheduler();
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = scheduler.enqueue({ priority: ASR_PRIORITY.provisional, key: 'live-1', preemptible: false, task: async () => { await gate; order.push('live-1'); } });
  const background = scheduler.enqueue({ priority: ASR_PRIORITY.highQuality, key: 'hq-1', task: async () => { order.push('hq-1'); } });
  const revision = scheduler.enqueue({ priority: ASR_PRIORITY.revised, key: 'revision-1', task: async () => { order.push('revision-1'); } });
  release();
  await Promise.all([first, background, revision]);
  assert.deepEqual(order, ['live-1', 'revision-1', 'hq-1']);
  assert.equal(scheduler.snapshot().active, 0);
});

test('new provisional work preempts and requeues background inference', async () => {
  const scheduler = new InferenceScheduler();
  const events = [];
  let backgroundRuns = 0;
  const background = scheduler.enqueue({
    priority: ASR_PRIORITY.highQuality,
    key: 'hq',
    task: ({ signal }) => new Promise((resolve, reject) => {
      backgroundRuns += 1;
      events.push(`hq-start-${backgroundRuns}`);
      if (backgroundRuns > 1) return resolve(events.push('hq-complete'));
      signal.addEventListener('abort', () => {
        events.push('hq-abort');
        reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
      }, { once: true });
    }),
  });
  await tick();
  const provisional = scheduler.enqueue({
    priority: ASR_PRIORITY.provisional,
    key: 'live',
    task: async () => { events.push('live-complete'); },
  });
  await Promise.all([background, provisional]);
  assert.deepEqual(events, ['hq-start-1', 'hq-abort', 'live-complete', 'hq-start-2', 'hq-complete']);
  assert.equal(backgroundRuns, 2);
});

test('manual inference can opt out of retries after preemption and releases its key', async () => {
  const scheduler = new InferenceScheduler();
  const events = [];
  let backgroundRuns = 0;
  let backgroundSignal;
  let releaseCleanup;
  const cleanup = new Promise((resolve) => { releaseCleanup = resolve; });
  const background = scheduler.enqueue({
    priority: ASR_PRIORITY.highQuality,
    key: 'manual-revision',
    retryOnPreempt: false,
    task: async ({ signal }) => {
      backgroundRuns += 1;
      backgroundSignal = signal;
      events.push('manual-start');
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      events.push('manual-abort');
      await cleanup;
      events.push('manual-exited');
      throw signal.reason;
    },
  });
  const rejected = assert.rejects(background, (error) => {
    assert.equal(error, backgroundSignal.reason);
    assert.equal(error.name, 'AbortError');
    assert.equal(error.code, 'ABORT_ERR');
    return true;
  });
  const live = scheduler.enqueue({
    priority: ASR_PRIORITY.provisional,
    key: 'live-recording',
    task: async () => { events.push('live-start'); },
  });
  assert.equal(backgroundSignal.aborted, true);
  assert.equal(scheduler.snapshot().active, 1);
  assert.equal(scheduler.snapshot().queued, 1);
  assert.equal(events.includes('live-start'), false);
  releaseCleanup();
  await Promise.all([rejected, live]);
  await scheduler.idle();
  assert.deepEqual(events, ['manual-start', 'manual-abort', 'manual-exited', 'live-start']);
  assert.equal(backgroundRuns, 1);
  assert.equal(scheduler.snapshot().retained, 0);

  const retry = await scheduler.enqueue({
    priority: ASR_PRIORITY.highQuality,
    key: 'manual-revision',
    retryOnPreempt: false,
    task: async () => { backgroundRuns += 1; return 'explicit retry'; },
  });
  assert.equal(retry, 'explicit retry');
  assert.equal(backgroundRuns, 2);
});

test('preempted manual work cannot publish a result even if its task resolves after abort', async () => {
  const scheduler = new InferenceScheduler();
  let backgroundRuns = 0;
  const background = scheduler.enqueue({
    priority: ASR_PRIORITY.highQuality,
    key: 'manual-ignoring-abort',
    retryOnPreempt: false,
    task: ({ signal }) => {
      backgroundRuns += 1;
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve('stale result'), { once: true }));
    },
  });
  const rejected = assert.rejects(background, { name: 'AbortError', code: 'ABORT_ERR' });
  const live = scheduler.enqueue({ priority: ASR_PRIORITY.provisional, key: 'live', task: async () => 'live result' });
  assert.deepEqual(await Promise.all([rejected, live]), [undefined, 'live result']);
  assert.equal(backgroundRuns, 1);
  assert.equal(scheduler.snapshot().retained, 0);
});

test('cancelling queued manual inference rejects it without running and preserves other jobs', async () => {
  const scheduler = new InferenceScheduler();
  let release;
  const running = scheduler.enqueue({
    priority: ASR_PRIORITY.provisional,
    key: 'running-live',
    preemptible: false,
    task: () => new Promise((resolve) => { release = resolve; }),
  });
  let manualRuns = 0;
  const manual = scheduler.enqueue({
    priority: ASR_PRIORITY.highQuality,
    key: 'queued-manual',
    metadata: { sessionId: 'cancelled-session' },
    retryOnPreempt: false,
    task: async () => { manualRuns += 1; },
  });
  const cancelled = assert.rejects(manual, { name: 'AbortError', code: 'ABORT_ERR', message: 'Session was replaced' });
  const other = scheduler.enqueue({ priority: ASR_PRIORITY.highQuality, key: 'other-session', task: async () => 'done' });
  scheduler.cancelWhere((entry) => entry.metadata?.sessionId === 'cancelled-session', 'Session was replaced');
  assert.equal(scheduler.snapshot().queued, 1);
  assert.equal(scheduler.snapshot().retained, 2);
  release();
  await Promise.all([running, cancelled]);
  assert.equal(await other, 'done');
  assert.equal(manualRuns, 0);
  assert.equal(scheduler.snapshot().retained, 0);
});

test('duplicate logical inference jobs share one promise and one execution', async () => {
  const scheduler = new InferenceScheduler();
  let runs = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = scheduler.enqueue({
    priority: ASR_PRIORITY.revised,
    key: 'session:segment:revised',
    task: async () => { runs += 1; await gate; return 'done'; },
  });
  const duplicate = scheduler.enqueue({
    priority: ASR_PRIORITY.revised,
    key: 'session:segment:revised',
    task: async () => { runs += 1; return 'duplicate'; },
  });
  assert.equal(duplicate, first);
  release();
  assert.deepEqual(await Promise.all([first, duplicate]), ['done', 'done']);
  assert.equal(runs, 1);
});

test('preemption waits for background cleanup before starting replacement inference', async () => {
  const scheduler = new InferenceScheduler();
  const events = [];
  let backgroundRuns = 0;
  let releaseCleanup;
  const cleanup = new Promise((resolve) => { releaseCleanup = resolve; });
  let reportAbort;
  const aborted = new Promise((resolve) => { reportAbort = resolve; });
  const background = scheduler.enqueue({
    priority: ASR_PRIORITY.highQuality,
    key: 'hq-with-cleanup',
    task: async ({ signal }) => {
      backgroundRuns += 1;
      events.push(`hq-start-${backgroundRuns}`);
      if (backgroundRuns > 1) return 'complete';
      await new Promise((resolve) => signal.addEventListener('abort', () => {
        events.push('hq-abort');
        reportAbort();
        resolve();
      }, { once: true }));
      await cleanup;
      events.push('hq-exited');
      throw Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
    },
  });
  await tick();
  const provisional = scheduler.enqueue({
    priority: ASR_PRIORITY.provisional,
    key: 'replacement-live',
    task: async () => { events.push('live-start'); },
  });
  await aborted;
  assert.equal(events.includes('live-start'), false);
  releaseCleanup();
  await Promise.all([background, provisional]);
  assert.deepEqual(events, ['hq-start-1', 'hq-abort', 'hq-exited', 'live-start', 'hq-start-2']);
});

test('inference queue stays bounded and drops stale queued work without retaining entries', async () => {
  const scheduler = new InferenceScheduler({ maxQueued: 3 });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const running = scheduler.enqueue({
    priority: ASR_PRIORITY.provisional,
    key: 'running',
    preemptible: false,
    task: () => gate,
  });
  const queued = Array.from({ length: 10 }, (_, index) => scheduler.enqueue({
    priority: ASR_PRIORITY.highQuality,
    key: `hq-${index}`,
    task: async () => index,
  }));
  assert.equal(scheduler.snapshot().queued, 3);
  assert.equal(scheduler.snapshot().retained, 4);
  assert.equal(scheduler.snapshot().dropped, 7);
  release('done');
  const results = await Promise.allSettled([running, ...queued]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 4);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === 'INFERENCE_QUEUE_FULL').length, 7);
  assert.equal(scheduler.snapshot().retained, 0);
});

test('closing the scheduler cancels queued and running jobs and leaves no retained work', async () => {
  const scheduler = new InferenceScheduler({ maxQueued: 2 });
  const running = scheduler.enqueue({
    priority: ASR_PRIORITY.highQuality,
    key: 'running',
    task: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  });
  const queued = scheduler.enqueue({ priority: ASR_PRIORITY.highQuality, key: 'queued', task: async () => 'unused' });
  const settled = Promise.allSettled([running, queued]);
  await tick();
  await scheduler.close();
  const results = await settled;
  assert.equal(results.every((result) => result.status === 'rejected' && result.reason.code === 'ABORT_ERR'), true);
  assert.deepEqual(scheduler.snapshot(), {
    concurrency: 1,
    maxQueued: 2,
    active: 0,
    queued: 0,
    retained: 0,
    dropped: 0,
    closed: true,
    running: [],
    pending: [],
  });
});

test('transcript projection keeps source order and replaces text by stable segment ID', () => {
  const segments = [
    { id: 'b', ordinal: 1, start: 3, end: 6, sourceRevision: 'b1', versions: { provisional: { stage: 'provisional', content: 'draft two' } } },
    { id: 'a', ordinal: 0, start: 0, end: 3, sourceRevision: 'a1', versions: { provisional: { stage: 'provisional', content: 'draft one' }, revised: { stage: 'revised', content: 'final one' } } },
  ];
  const projected = projectTranscript(segments);
  assert.equal(projected.content, 'final one draft two');
  assert.deepEqual(projected.segments.map((segment) => segment.id), ['a', 'b']);
  assert.deepEqual(projected.segments.map((segment) => segment.stage), ['revised', 'provisional']);
});

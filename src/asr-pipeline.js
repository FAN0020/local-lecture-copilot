export const ASR_STAGE = Object.freeze({
  PROVISIONAL: 'provisional',
  REVISED: 'revised',
  HIGH_QUALITY: 'highQuality',
});

export const ASR_STAGES = Object.freeze(Object.values(ASR_STAGE));

export const ASR_PRIORITY = Object.freeze({
  provisional: 0,
  revised: 1,
  highQuality: 3,
});

// These are preferences, not hard requirements. resolveAsrModelPlan always
// constrains the result to models that the managed runtime reports as ready.
export const ASR_MODEL_PREFERENCES = Object.freeze({
  provisional: Object.freeze(['base', 'tiny', 'small', 'medium', 'turbo', 'large']),
  revised: Object.freeze(['turbo', 'medium', 'large', 'small', 'base', 'tiny']),
  highQuality: Object.freeze(['large', 'turbo', 'medium', 'small', 'base', 'tiny']),
});

function unfinishedStage(segment, stage) {
  if (segment?.versions?.[stage]) return null;
  const status = segment?.stages?.[stage]?.status;
  return status === 'pending' || status === 'running' ? status : null;
}

function stageBacklog(segments, stage, eligible = () => true) {
  const states = segments
    .filter(eligible)
    .map((segment) => unfinishedStage(segment, stage))
    .filter(Boolean);
  const queued = states.filter((status) => status === 'pending').length;
  const active = states.filter((status) => status === 'running').length;
  return { queued, active, total: queued + active };
}

/** Derive user-facing work queues from durable segment lifecycle state. */
export function summarizeAsrBacklog(segments = []) {
  return {
    transcription: stageBacklog(segments, ASR_STAGE.PROVISIONAL),
    refinement: stageBacklog(segments, ASR_STAGE.REVISED, (segment) => Boolean(segment.versions?.provisional)),
    highQuality: stageBacklog(segments, ASR_STAGE.HIGH_QUALITY),
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

/** Select an installed model and retain ordered fallbacks for every ASR stage. */
export function resolveAsrModelPlan(installedModels = [], { selectedModel, stageModels = {} } = {}) {
  const installed = new Set(installedModels);
  const selectedStageModels = Object.fromEntries(ASR_STAGES.map((stage) => [
    stage,
    installed.has(stageModels?.[stage]) ? stageModels[stage] : null,
  ]));
  const choose = (stage) => {
    const explicit = selectedStageModels[stage];
    const preferred = ASR_MODEL_PREFERENCES[stage];
    const selected = stageModels?.[stage];
    const candidates = selected ? [selected, ...preferred] : [...preferred];
    // selectedModel is the legacy single-model preference. Keep its historic
    // behavior for old clients while stageModels provides an explicit choice.
    if (!selected && selectedModel) {
      const selectedIndex = stage === ASR_STAGE.PROVISIONAL ? 1 : stage === ASR_STAGE.REVISED ? 2 : 3;
      candidates.splice(selectedIndex, 0, selectedModel);
    }
    const fallbacks = unique(candidates).filter((model) => installed.has(model));
    return { model: fallbacks[0] || null, fallbacks };
  };
  const stages = Object.fromEntries(ASR_STAGES.map((stage) => [stage, choose(stage)]));
  return {
    enabled: Boolean(stages.provisional.model),
    selectedModel: installed.has(selectedModel) ? selectedModel : null,
    selectedStageModels: Object.fromEntries(ASR_STAGES.map((stage) => [stage, installed.has(stageModels?.[stage]) ? stageModels[stage] : null])),
    models: Object.fromEntries(ASR_STAGES.map((stage) => [stage, stages[stage].model])),
    fallbacks: Object.fromEntries(ASR_STAGES.map((stage) => [stage, stages[stage].fallbacks])),
  };
}

export function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function abortError(message = 'Inference was preempted by higher-priority work') {
  return Object.assign(new Error(message), { name: 'AbortError', code: 'ABORT_ERR' });
}

function queueError(message = 'Inference queue is full; the saved audio can be retried later') {
  return Object.assign(new Error(message), { status: 503, code: 'INFERENCE_QUEUE_FULL' });
}

/**
 * A bounded priority queue for heavyweight inference.
 *
 * With concurrency one, newly queued live work aborts a lower-priority,
 * preemptible process. Queued entries are bounded; audio is already durable on
 * disk before callers enqueue work, so a displaced entry can be recovered
 * without retaining its audio in JavaScript memory.
 */
export class InferenceScheduler {
  constructor({ concurrency = 1, maxQueued = 8, onStateChange = () => {} } = {}) {
    this.concurrency = Math.max(1, Math.floor(Number(concurrency) || 1));
    this.maxQueued = Math.max(1, Math.floor(Number(maxQueued) || 8));
    this.onStateChange = onStateChange;
    this.queue = [];
    this.running = new Map();
    this.entries = new Map();
    this.sequence = 0;
    this.dropped = 0;
    this.closed = false;
    this.idleWaiters = new Set();
  }

  enqueue({ priority, key, task, preemptible = true, retryOnPreempt = true, label = key, metadata = null }) {
    if (typeof task !== 'function') throw new TypeError('Inference task must be a function');
    if (this.closed) return Promise.reject(abortError('Inference scheduler is closed'));
    const normalizedKey = String(key || `inference-${this.sequence + 1}`);
    const existing = this.entries.get(normalizedKey);
    if (existing) return existing.promise;
    const entry = {
      priority: Number(priority) || 0,
      key: normalizedKey,
      label: String(label || key || 'inference'),
      metadata,
      task,
      preemptible: Boolean(preemptible),
      // Optional manual work should stop when live work needs these resources.
      // Durable ASR jobs keep their existing retry behavior by default.
      retryOnPreempt: Boolean(retryOnPreempt),
      sequence: this.sequence++,
      controller: null,
      preempted: false,
      cancelled: false,
      settled: false,
      enqueuedAt: Date.now(),
      startedAt: null,
      promise: null,
      resolve: null,
      reject: null,
    };
    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    entry.promise = promise;
    if (!this.makeRoomFor(entry)) {
      this.dropped += 1;
      entry.settled = true;
      entry.reject(queueError());
      this.emit();
      return promise;
    }
    this.entries.set(entry.key, entry);
    this.queue.push(entry);
    this.sortQueue();
    this.preemptFor(entry);
    this.emit();
    this.drain();
    return promise;
  }

  makeRoomFor(candidate) {
    if (this.queue.length < this.maxQueued) return true;
    const displaced = [...this.queue]
      .filter((entry) => entry.priority >= candidate.priority)
      .sort((left, right) => right.priority - left.priority || left.sequence - right.sequence)[0];
    if (!displaced) return false;
    this.queue.splice(this.queue.indexOf(displaced), 1);
    this.entries.delete(displaced.key);
    displaced.cancelled = true;
    displaced.settled = true;
    displaced.reject(queueError(`Inference “${displaced.label}” was displaced by newer or higher-priority work`));
    this.dropped += 1;
    return true;
  }

  sortQueue() {
    this.queue.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
  }

  preemptFor(candidate) {
    if (this.running.size < this.concurrency) return;
    const lower = [...this.running.values()]
      .filter((entry) => entry.preemptible && entry.priority > candidate.priority && !entry.preempted)
      .sort((left, right) => right.priority - left.priority || right.sequence - left.sequence)[0];
    if (!lower) return;
    lower.preempted = true;
    lower.controller?.abort(abortError());
  }

  drain() {
    while (this.running.size < this.concurrency && this.queue.length) {
      const entry = this.queue.shift();
      this.start(entry);
    }
  }

  async start(entry) {
    if (this.closed || entry.cancelled) return;
    entry.controller = new AbortController();
    entry.preempted = false;
    entry.startedAt = Date.now();
    this.running.set(entry.key, entry);
    this.emit();
    try {
      const value = await entry.task({ signal: entry.controller.signal });
      if (entry.preempted || entry.controller.signal.aborted) throw abortError();
      entry.settled = true;
      entry.resolve(value);
    } catch (error) {
      if (entry.preempted && entry.retryOnPreempt && isAbortError(error) && !entry.cancelled && !this.closed) {
        entry.controller = null;
        if (this.makeRoomFor(entry)) {
          this.queue.push(entry);
          this.sortQueue();
        } else {
          this.dropped += 1;
          entry.settled = true;
          entry.reject(queueError(`Preempted inference “${entry.label}” was deferred because the queue is full`));
        }
      } else {
        entry.settled = true;
        entry.reject(error);
      }
    } finally {
      this.running.delete(entry.key);
      if (entry.settled && this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
      this.emit();
      this.drain();
    }
  }

  snapshot() {
    const currentTime = Date.now();
    return {
      concurrency: this.concurrency,
      maxQueued: this.maxQueued,
      active: this.running.size,
      queued: this.queue.length,
      retained: this.entries.size,
      dropped: this.dropped,
      closed: this.closed,
      running: [...this.running.values()].map(({ key, label, priority, preemptible, metadata, startedAt }) => ({
        key,
        label,
        priority,
        preemptible,
        metadata,
        ageMs: startedAt ? Math.max(0, currentTime - startedAt) : 0,
      })),
      pending: this.queue.map(({ key, label, priority, metadata, enqueuedAt }) => ({
        key,
        label,
        priority,
        metadata,
        ageMs: Math.max(0, currentTime - enqueuedAt),
      })),
    };
  }

  emit() {
    const snapshot = this.snapshot();
    this.onStateChange(snapshot);
    if (!snapshot.active && !snapshot.queued) {
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
  }

  async idle() {
    if (!this.running.size && !this.queue.length) return;
    await new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  cancelWhere(predicate = () => true, message = 'Inference was cancelled') {
    for (const entry of [...this.queue]) {
      if (!predicate(entry)) continue;
      this.queue.splice(this.queue.indexOf(entry), 1);
      this.entries.delete(entry.key);
      entry.cancelled = true;
      entry.settled = true;
      entry.reject(abortError(message));
    }
    for (const entry of this.running.values()) {
      if (!predicate(entry)) continue;
      entry.cancelled = true;
      entry.controller?.abort(abortError(message));
    }
    this.emit();
  }

  async close() {
    if (this.closed) return this.idle();
    this.closed = true;
    this.cancelWhere(() => true, 'Inference scheduler is shutting down');
    await this.idle();
  }
}

export function transcriptVersion(segment, stage = 'usable') {
  const versions = segment?.versions || {};
  if (stage === 'usable') return versions.revised || versions.provisional || null;
  return versions[stage] || null;
}

export function orderedTranscriptSegments(segments = []) {
  return [...segments].sort((left, right) => Number(left.ordinal ?? 0) - Number(right.ordinal ?? 0)
    || Number(left.start ?? 0) - Number(right.start ?? 0)
    || String(left.id || '').localeCompare(String(right.id || '')));
}

export function projectTranscript(segments = [], { stage = 'usable', includeIntegrated = false } = {}) {
  const projected = orderedTranscriptSegments(segments)
    .filter((segment) => includeIntegrated || !segment.integratedIntoBase)
    .map((segment) => ({ segment, version: transcriptVersion(segment, stage) }))
    .filter(({ version }) => version && typeof version.content === 'string');
  return {
    content: projected.map(({ version }) => version.content.trim()).filter(Boolean).join(' '),
    segments: projected.map(({ segment, version }) => ({
      id: segment.id,
      ordinal: segment.ordinal,
      recordingSegmentId: segment.recordingSegmentId,
      start: Number(segment.start || 0),
      end: Number(segment.end || segment.start || 0),
      text: version.content.trim(),
      stage: version.stage,
      model: version.model,
      provider: version.provider,
      language: version.language,
      sourceRevision: segment.sourceRevision,
    })),
  };
}

import { performance } from 'node:perf_hooks';

const NOOP = {
  enabled: false,
  record() { return null; },
  snapshot() { return null; },
  all() { return {}; },
};

function wordCount(value) {
  return String(value || '').trim() ? String(value).trim().split(/\s+/u).length : 0;
}

function createSessionState() {
  return {
    events: [],
    queued: new Map(),
    providerStarted: new Map(),
    transcriptFinalized: new Map(),
    summary: {
      transcriptToQueueMs: [],
      queueWaitMs: [],
      providerLatencyMs: [],
      persistenceLatencyMs: [],
      requestSizes: [],
      requests: 0,
      maxQueueDepth: 0,
      maxProviderConcurrency: 0,
    },
  };
}

/**
 * Low-noise, opt-in instrumentation for the realtime Raw translation path.
 * The default is disabled; setting LECTURE_COPILOT_TRANSLATION_DEBUG=1 or
 * passing { enabled: true } keeps an in-memory trace available through the
 * debug endpoint without logging every request in production.
 */
export function createTranslationProfiler({
  enabled = process.env.LECTURE_COPILOT_TRANSLATION_DEBUG === '1',
  maxEvents = 2000,
  maxSamples = 500,
  maxTracked = 500,
  maxSessions = 20,
  clock = () => performance.now(),
} = {}) {
  if (!enabled) return NOOP;
  const sessions = new Map();
  let nextEventId = 1;

  function stateFor(sessionId) {
    let state = sessions.get(sessionId);
    if (!state) {
      while (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
      state = createSessionState();
      sessions.set(sessionId, state);
    }
    return state;
  }

  function record(sessionId, type, fields = {}) {
    const state = stateFor(sessionId);
    const at = clock();
    const event = { id: nextEventId++, type, at, wallTime: new Date().toISOString(), ...fields };
    state.events.push(event);
    if (state.events.length > maxEvents) state.events.splice(0, state.events.length - maxEvents);

    if (type === 'transcript-finalized') {
      if (fields.sourceFingerprint) {
        const list = state.transcriptFinalized.get(fields.sourceFingerprint) || [];
        list.push(at);
        if (list.length > 20) list.splice(0, list.length - 20);
        state.transcriptFinalized.set(fields.sourceFingerprint, list);
        while (state.transcriptFinalized.size > maxTracked) state.transcriptFinalized.delete(state.transcriptFinalized.keys().next().value);
      }
    } else if (type === 'queued') {
      state.queued.set(event.id, at);
      while (state.queued.size > maxTracked) state.queued.delete(state.queued.keys().next().value);
    } else if (type === 'worker-start') {
      const queuedAt = state.queued.get(fields.queueId);
      if (queuedAt !== undefined) state.summary.queueWaitMs.push(at - queuedAt);
      state.queued.delete(fields.queueId);
      const finalizations = state.transcriptFinalized.get(fields.sourceFingerprint) || [];
      const finalizedAt = [...finalizations].reverse().find((value) => value <= (queuedAt ?? at));
      if (finalizedAt !== undefined) {
        state.summary.transcriptToQueueMs.push((queuedAt ?? at) - finalizedAt);
      }
      state.summary.maxQueueDepth = Math.max(state.summary.maxQueueDepth, Number(fields.queueDepth) || 0);
    } else if (type === 'provider-start') {
      state.providerStarted.set(fields.requestId, at);
      while (state.providerStarted.size > maxTracked) state.providerStarted.delete(state.providerStarted.keys().next().value);
      state.summary.requests += 1;
      state.summary.requestSizes.push({
        characters: Number(fields.characters) || 0,
        words: Number(fields.words) || 0,
        estimatedTokens: Number(fields.estimatedTokens) || 0,
      });
      state.summary.maxProviderConcurrency = Math.max(state.summary.maxProviderConcurrency, Number(fields.concurrency) || 0);
    } else if (type === 'provider-complete') {
      const startedAt = state.providerStarted.get(fields.requestId);
      if (startedAt !== undefined) state.summary.providerLatencyMs.push(at - startedAt);
      state.providerStarted.delete(fields.requestId);
    } else if (type === 'persisted' && fields.startedAt !== undefined) {
      state.summary.persistenceLatencyMs.push(at - fields.startedAt);
    }
    for (const values of [
      state.summary.transcriptToQueueMs,
      state.summary.queueWaitMs,
      state.summary.providerLatencyMs,
      state.summary.persistenceLatencyMs,
      state.summary.requestSizes,
    ]) {
      if (values.length > maxSamples) values.splice(0, values.length - maxSamples);
    }
    return event.id;
  }

  function serialize(state) {
    return {
      events: state.events.slice(),
      summary: {
        ...state.summary,
        transcriptToQueueMs: state.summary.transcriptToQueueMs.slice(),
        queueWaitMs: state.summary.queueWaitMs.slice(),
        providerLatencyMs: state.summary.providerLatencyMs.slice(),
        persistenceLatencyMs: state.summary.persistenceLatencyMs.slice(),
        requestSizes: state.summary.requestSizes.slice(),
      },
      retained: {
        queued: state.queued.size,
        providerStarted: state.providerStarted.size,
        transcriptFingerprints: state.transcriptFinalized.size,
      },
    };
  }

  return {
    enabled: true,
    record,
    snapshot(sessionId) {
      const state = sessions.get(sessionId);
      return state ? serialize(state) : { events: [], summary: createSessionState().summary };
    },
    all() {
      return Object.fromEntries([...sessions.entries()].map(([sessionId, state]) => [sessionId, serialize(state)]));
    },
  };
}

export { wordCount };

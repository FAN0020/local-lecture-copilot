import { performance } from 'node:perf_hooks';

function abortError(message = 'Ollama request was cancelled') {
  return Object.assign(new Error(message), { name: 'AbortError', code: 'ABORT_ERR', status: 499 });
}

function positiveInteger(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Coordinates Ollama runner recycling with the application LLM scheduler.
 *
 * llama.cpp keeps a process-local prompt cache for independent requests. For
 * Qwen 3.5 each saved short prompt costs about 108 MiB, so a long sequence of
 * one-shot translations can fill Ollama's 8 GiB cache despite bounded app
 * queues. This gate lets in-flight calls drain, blocks new provider calls, and
 * performs exactly one model unload before queued work resumes.
 */
export class OllamaLifecycle {
  constructor({
    provider,
    maxRequests = 25,
    maxRunnerAgeMs = 5 * 60_000,
    now = () => performance.now(),
  } = {}) {
    this.provider = provider;
    this.maxRequests = positiveInteger(maxRequests, 25);
    this.maxRunnerAgeMs = positiveInteger(maxRunnerAgeMs, 5 * 60_000);
    this.now = now;
    this.models = new Map();
    this.active = new Map();
    this.sequence = 0;
    this.pendingResets = new Map();
    this.resetPromise = null;
    this.stateWaiters = new Set();
    this.lastReset = null;
    this.resetCount = 0;
    this.totalCompleted = 0;
    this.totalCancelled = 0;
    this.totalFailed = 0;
  }

  modelState(model) {
    const key = String(model || '');
    let state = this.models.get(key);
    if (!state) {
      state = { requestsSinceReset: 0, runnerStartedAt: null };
      this.models.set(key, state);
    }
    return state;
  }

  thresholdReason(model, state, currentTime) {
    if (state.requestsSinceReset >= this.maxRequests) return 'request-threshold';
    if (state.runnerStartedAt !== null && currentTime - state.runnerStartedAt >= this.maxRunnerAgeMs) return 'runner-age';
    return null;
  }

  notifyStateChange() {
    for (const resolve of this.stateWaiters) resolve();
    this.stateWaiters.clear();
  }

  async waitForStateChange(signal) {
    if (signal?.aborted) throw abortError();
    let onAbort;
    let resolveChanged;
    const changed = new Promise((resolve) => {
      resolveChanged = resolve;
      this.stateWaiters.add(resolve);
    });
    const aborted = signal && new Promise((_, reject) => {
      onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await (aborted ? Promise.race([changed, aborted]) : changed);
    } finally {
      this.stateWaiters.delete(resolveChanged);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  async waitForReset(signal) {
    while (this.resetPromise || this.pendingResets.size) {
      if (signal?.aborted) throw abortError();
      const reset = this.resetPromise || this.startResetIfIdle();
      if (!reset) {
        await this.waitForStateChange(signal);
        continue;
      }
      if (!signal) {
        await reset;
        continue;
      }
      let onAbort;
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        await Promise.race([reset, aborted]);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }

  async generate(options, metadata = {}) {
    await this.waitForReset(options.signal);
    const model = String(options.model || '');
    const state = this.modelState(model);
    // Recycle an old runner before the next manual burst. Otherwise a long idle
    // gap makes its first fresh result immediately unload, forcing a second
    // model load for the next request in that same burst.
    const reason = this.thresholdReason(model, state, this.now());
    if (reason) {
      if (!this.resetPromise && !this.pendingResets.has(model)) this.pendingResets.set(model, reason);
      await this.waitForReset(options.signal);
    }
    if (options.signal?.aborted) throw abortError();
    const requestId = `llm_request_${++this.sequence}`;
    if (state.runnerStartedAt === null) state.runnerStartedAt = this.now();
    this.active.set(requestId, {
      requestId,
      model,
      sessionId: metadata.sessionId || options.sessionId || null,
      requestType: String(metadata.requestType || options.requestType || 'generation'),
      promptCharacters: String(options.prompt || '').length,
      estimatedPromptTokens: Math.ceil(String(options.prompt || '').length / 4),
      retrievedContextCharacters: Number(metadata.retrievedContextCharacters || options.retrievedContextCharacters) || 0,
      numCtx: Number(options.numCtx) || null,
      numPredict: Number(options.numPredict) || null,
      startedAt: this.now(),
    });
    let outcome = 'failed';
    try {
      const result = await this.provider.generate(options);
      outcome = 'complete';
      this.totalCompleted += 1;
      return result;
    } catch (error) {
      if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
        outcome = 'cancelled';
        this.totalCancelled += 1;
      } else {
        this.totalFailed += 1;
      }
      throw error;
    } finally {
      // Aborted/error responses can still leave llama.cpp prompt state behind,
      // so every provider attempt consumes the recycle budget.
      state.requestsSinceReset += 1;
      const reason = this.thresholdReason(model, state, this.now());
      if (reason) this.pendingResets.set(model, reason);
      const request = this.active.get(requestId);
      if (request) request.outcome = outcome;
      this.active.delete(requestId);
      this.notifyStateChange();
      // The last provider call starts the reset. Its caller can still release
      // an inference slot on cancellation while unloading continues; later
      // LLM requests remain blocked by the shared reset promise.
      if (!this.active.size && this.pendingResets.size) {
        this.startResetIfIdle();
        await this.waitForReset(options.signal);
      }
    }
  }

  async requestReset(model, reason = 'requested') {
    const key = String(model || '');
    if (!key) return false;
    if (!this.pendingResets.has(key)) this.pendingResets.set(key, reason);
    this.notifyStateChange();
    this.startResetIfIdle();
    await this.waitForReset();
    return this.lastReset?.model === key && this.lastReset.succeeded;
  }

  startResetIfIdle() {
    if (this.active.size || this.resetPromise || !this.pendingResets.size) return this.resetPromise;
    const reset = (async () => {
      while (!this.active.size && this.pendingResets.size) {
        const [model, reason] = this.pendingResets.entries().next().value;
        this.pendingResets.delete(model);
        let succeeded = false;
        let error = null;
        try {
          if (typeof this.provider.unload === 'function') await this.provider.unload(model);
          succeeded = true;
          const state = this.modelState(model);
          state.requestsSinceReset = 0;
          state.runnerStartedAt = null;
          this.resetCount += 1;
        } catch (caught) {
          error = caught;
        }
        this.lastReset = {
          model,
          reason,
          succeeded,
          error: error?.message || null,
          finishedAt: this.now(),
        };
      }
    })();
    const wrapped = reset.finally(() => {
      if (this.resetPromise === wrapped) this.resetPromise = null;
      this.notifyStateChange();
    });
    this.resetPromise = wrapped;
    this.notifyStateChange();
    return wrapped;
  }

  snapshot() {
    const currentTime = this.now();
    return {
      active: this.active.size,
      activeRequests: [...this.active.values()].map((request) => ({
        ...request,
        ageMs: Math.max(0, currentTime - request.startedAt),
      })),
      models: [...this.models.entries()].map(([model, state]) => ({
        model,
        requestsSinceReset: state.requestsSinceReset,
        runnerAgeMs: state.runnerStartedAt === null ? 0 : Math.max(0, currentTime - state.runnerStartedAt),
      })),
      maxRequests: this.maxRequests,
      maxRunnerAgeMs: this.maxRunnerAgeMs,
      resetPending: this.pendingResets.size > 0 || Boolean(this.resetPromise),
      pendingResetModels: [...this.pendingResets.keys()],
      lastReset: this.lastReset,
      resetCount: this.resetCount,
      completed: this.totalCompleted,
      cancelled: this.totalCancelled,
      failed: this.totalFailed,
    };
  }
}

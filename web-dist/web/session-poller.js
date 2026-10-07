/** Poll active work without overlapping requests or keeping idle pages awake. */
export class SessionPoller {
  constructor({ refresh, shouldContinue, delay, setTimer = (callback, delayMs) => setTimeout(callback, delayMs), clearTimer = (timer) => clearTimeout(timer) }) {
    this.refresh = refresh;
    this.shouldContinue = shouldContinue;
    this.delay = delay;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.enabled = false;
    this.inFlight = false;
    this.failures = 0;
  }

  start() {
    this.enabled = true;
    if (!this.inFlight && this.timer === null) this.schedule();
  }

  stop() {
    this.enabled = false;
    this.clearTimer(this.timer);
    this.timer = null;
    this.failures = 0;
  }

  wake() {
    if (!this.enabled || this.inFlight) return;
    this.clearTimer(this.timer);
    this.timer = null;
    this.schedule();
  }

  schedule() {
    const interval = Math.min(30_000, this.delay() * (2 ** this.failures));
    this.timer = this.setTimer(() => this.tick(), interval);
  }

  async tick() {
    this.timer = null;
    if (!this.enabled || this.inFlight) return;
    this.inFlight = true;
    try {
      await this.refresh();
      this.failures = 0;
    } catch {
      // The user-initiated request reports errors; retries back off quietly.
      this.failures = Math.min(5, this.failures + 1);
    } finally {
      this.inFlight = false;
      if (this.enabled && this.shouldContinue()) this.schedule();
      else this.stop();
    }
  }
}

/** Durable edits use updatedAt; processing counters may change between edits. */
export function sessionRefreshMarker(session) {
  return JSON.stringify([
    session?.id, session?.updatedAt, session?.processing, session?.asr,
    session?.dictation?.status,
    Object.entries(session?.artifacts || {}).map(([key, artifact]) => [
      key, artifact?.updatedAt, artifact?.contentFingerprint, artifact?.stale, artifact?.generationState,
    ]),
  ]);
}

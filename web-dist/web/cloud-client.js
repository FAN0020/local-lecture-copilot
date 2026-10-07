import { createHostClient, validateApiBase } from '../web-host/client.js';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class CloudLifecycleClient {
  constructor({ controllerUrl, accessCode, fetcher = globalThis.fetch.bind(globalThis), onState = () => {}, leaseId = crypto.randomUUID() } = {}) {
    this.controllerUrl = validateApiBase(controllerUrl);
    this.accessCode = String(accessCode || '');
    if (this.accessCode.length < 16) throw new Error('Enter the cloud access code provided by the owner.');
    this.fetcher = fetcher;
    this.onState = onState;
    this.leaseId = leaseId;
    this.host = null;
    this.heartbeatTimer = null;
    this.connecting = null;
  }

  async controller(action = 'status') {
    const response = await this.fetcher(new URL('/.netlify/functions/cloud-session', this.controllerUrl), {
      method: action === 'status' ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${this.accessCode}`, 'content-type': 'application/json' },
      ...(action === 'status' ? {} : { body: JSON.stringify({ action }) }),
      signal: AbortSignal.timeout(20_000), credentials: 'omit', cache: 'no-store',
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error('The cloud access code was rejected.');
    if (!response.ok && response.status !== 202) throw new Error(result.error || 'The cloud controller is unavailable.');
    return result;
  }

  async connect({ timeoutMs = 30 * 60_000 } = {}) {
    if (this.host) return this;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectLoop(timeoutMs).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async connectLoop(timeoutMs) {
    const startedAt = Date.now();
    let action = 'acquire';
    let delayMs = 1_500;
    while (Date.now() - startedAt < timeoutMs) {
      this.onState({ state: 'starting', message: 'Starting cloud AI…', elapsedMs: Date.now() - startedAt });
      const result = await this.controller(action);
      action = result.status === 'stopped' ? 'acquire' : 'status';
      if (result.status === 'ready') {
        const apiBase = validateApiBase(result.apiBase);
        const host = createHostClient(apiBase, this.accessCode, this.fetcher, {
          headers: { 'x-cloud-lease': this.leaseId },
          onJobProgress: (job) => this.onState({ state: 'processing', message: job.status === 'queued' ? 'Cloud request queued…' : 'Cloud AI is processing…', job }),
        });
        await host.check();
        const leaseResponse = await host.fetch('/api/cloud/leases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leaseId: this.leaseId }) });
        const lease = await leaseResponse.json();
        if (!leaseResponse.ok) throw new Error(lease.error || 'Could not open a cloud session.');
        this.host = host;
        this.startHeartbeat(lease.heartbeatIntervalMs);
        this.onState({ state: 'ready', message: 'Cloud AI ready', apiBase });
        return this;
      }
      if (result.status === 'error') throw new Error(result.error || 'Cloud AI could not start.');
      await wait(delayMs);
      delayMs = Math.min(5_000, Math.ceil(delayMs * 1.3));
    }
    throw new Error(`Cloud AI did not become ready within ${Math.ceil(timeoutMs / 60_000)} minutes.`);
  }

  startHeartbeat(intervalMs = 15_000) {
    clearInterval(this.heartbeatTimer);
    const heartbeat = async () => {
      if (!this.host) return;
      try {
        const response = await this.host.fetch(`/api/cloud/leases/${encodeURIComponent(this.leaseId)}`, { method: 'PATCH' });
        if (!response.ok) throw new Error('Cloud session heartbeat failed');
      } catch (error) {
        this.onState({ state: 'recovering', message: 'Reconnecting to cloud AI…', error });
        this.host = null;
        clearInterval(this.heartbeatTimer);
        void this.connect().catch((failure) => this.onState({ state: 'error', message: failure.message, error: failure }));
      }
    };
    this.heartbeatTimer = setInterval(heartbeat, Math.max(5_000, Number(intervalMs) || 15_000));
  }

  async fetch(path, options = {}) {
    await this.connect();
    return this.host.fetch(path, options);
  }

  connectAudio(container) { this.host?.connectAudio(container); }

  async release() {
    clearInterval(this.heartbeatTimer);
    if (!this.host) return;
    const host = this.host;
    this.host = null;
    await host.fetch(`/api/cloud/leases/${encodeURIComponent(this.leaseId)}`, { method: 'DELETE', keepalive: true }).catch(() => {});
    this.onState({ state: 'released', message: 'Cloud session closed' });
  }
}

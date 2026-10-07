export function validateApiBase(value) {
  const url = new URL(String(value).trim());
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('Use an HTTPS host URL (HTTP is supported only on localhost).');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Enter only the host origin, for example https://api.example.com.');
  }
  return url.origin;
}

export function createHostClient(apiBase, accessCode, fetcher = globalThis.fetch.bind(globalThis), { headers: defaultHeaders = {}, onJobProgress = () => {} } = {}) {
  const base = validateApiBase(apiBase);
  async function rawRequest(path, options = {}) {
    if (!path.startsWith('/api/') || path.startsWith('//') || /[\\\r\n]/u.test(path)) throw new Error('Invalid API path');
    const url = new URL(path, base);
    if (url.origin !== base) throw new Error('Invalid API origin');
    const headers = new Headers(options.headers);
    for (const [name, value] of Object.entries(defaultHeaders)) headers.set(name, value);
    headers.set('authorization', `Bearer ${accessCode}`);
    const response = await fetcher(url.href, { ...options, headers, credentials: 'omit', redirect: 'error', cache: 'no-store' });
    if (response.status === 401) {
      globalThis.dispatchEvent?.(new Event('lecture-host-unauthorized'));
      throw new Error('The access code was rejected. Reconnect to the demo.');
    }
    return response;
  }
  async function request(path, options = {}) {
    const response = await rawRequest(path, options);
    if (response.status !== 202 || !(response.headers.get('content-type') || '').includes('application/json')) return response;
    const accepted = await response.clone().json().catch(() => null);
    if (!accepted?.jobId) return response;
    const startedAt = Date.now();
    let delayMs = Math.max(250, Number(accepted.pollAfterMs) || 1_000);
    while (Date.now() - startedAt < 15 * 60_000) {
      onJobProgress({ jobId: accepted.jobId, status: accepted.status || 'queued' });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const polled = await rawRequest(`/api/cloud/jobs/${encodeURIComponent(accepted.jobId)}`);
      const job = await polled.json();
      if (!polled.ok) return new Response(JSON.stringify(job), { status: polled.status, headers: { 'content-type': 'application/json' } });
      if (job.status === 'complete') {
        const binary = Uint8Array.from(atob(job.result.body), (character) => character.charCodeAt(0));
        return new Response(binary, { status: job.result.status, headers: job.result.headers });
      }
      if (job.status === 'error') return new Response(JSON.stringify({ error: job.error?.message || 'Cloud processing failed', code: job.error?.code }), { status: 500, headers: { 'content-type': 'application/json' } });
      delayMs = Math.min(2_500, Math.ceil(delayMs * 1.2));
    }
    return new Response(JSON.stringify({ error: 'Cloud processing did not finish within 15 minutes', code: 'CLOUD_JOB_TIMEOUT' }), { status: 504, headers: { 'content-type': 'application/json' } });
  }
  return {
    fetch: request,
    async check() {
      const response = await request('/api/web/access', { signal: AbortSignal.timeout(15_000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The demo host is unavailable.');
      return result;
    },
    connectAudio(container) {
      for (const element of container.querySelectorAll('audio[data-audio-path]')) {
        let renewed = false;
        async function attach() {
          try {
            const response = await request(`/api/web/media-url?path=${encodeURIComponent(element.dataset.audioPath)}`);
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Recording unavailable');
            const url = new URL(result.path, base);
            if (url.origin !== base || !url.pathname.startsWith('/api/sessions/')) throw new Error('Invalid recording URL');
            if (element.isConnected) element.src = url.href;
          } catch (error) {
            if (element.isConnected) element.title = `Cannot load recording: ${error.message}`;
          }
        }
        element.addEventListener('error', () => {
          if (!renewed) { renewed = true; void attach(); }
        });
        void attach();
      }
    },
  };
}

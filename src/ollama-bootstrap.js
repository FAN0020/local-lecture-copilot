import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_LIVE_TRANSLATION_MODEL } from './lib.js';

export const DEFAULT_OLLAMA_MODEL = 'qwen3.5:4b';
export const DEFAULT_OLLAMA_MODELS = [DEFAULT_OLLAMA_MODEL, DEFAULT_LIVE_TRANSLATION_MODEL];
export const OLLAMA_BOOTSTRAP_ACTIVE_STATES = new Set(['checking', 'downloading', 'installing', 'starting', 'pulling']);

const WINDOWS_DOWNLOAD_URL = 'https://ollama.com/download/OllamaSetup.exe';
const MAC_DOWNLOAD_URL = 'https://ollama.com/download/Ollama-darwin.zip';
const WINDOWS_INSTALLER_PATH_ENV = 'LOCAL_LECTURE_OLLAMA_INSTALLER_PATH';

function abortError() {
  return Object.assign(new Error('Ollama setup was cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function boundedAppend(current, chunk, limit = 8_000) {
  return `${current}${String(chunk || '')}`.slice(-limit);
}

function terminateChild(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let forceTimer;
    let deadline;
    const finish = (error) => {
      clearTimeout(forceTimer);
      clearTimeout(deadline);
      child.off('exit', onExit);
      child.off('error', finish);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => finish();
    child.once('exit', onExit);
    child.once('error', finish);
    forceTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    deadline = setTimeout(() => finish(new Error('Ollama child did not exit after termination')), 5_000);
    child.kill('SIGTERM');
  });
}

export function runProcess(command, args = [], {
  signal,
  timeoutMs = 20 * 60_000,
  spawnImpl = spawn,
  env = process.env,
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    let stdout = '';
    let stderr = '';
    let settled = false;
    let cancellation = null;
    const child = spawnImpl(command, args, {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result);
    };
    const cancel = (error) => {
      if (cancellation || settled) return;
      cancellation = error;
      void terminateChild(child).then(() => finish(error), (stopError) => finish(stopError));
    };
    const onAbort = () => cancel(abortError());
    const timer = setTimeout(() => {
      cancel(Object.assign(new Error(`Command timed out: ${path.basename(command)}`), { code: 'COMMAND_TIMEOUT' }));
    }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk) => { stdout = boundedAppend(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = boundedAppend(stderr, chunk); });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, exitSignal) => {
      if (cancellation) return finish(cancellation);
      if (code === 0) return finish(null, { stdout, stderr });
      const detail = stderr.trim() || stdout.trim();
      const suffix = detail ? `: ${detail}` : '';
      finish(Object.assign(new Error(`${path.basename(command)} exited with ${code ?? exitSignal}${suffix}`), { code: 'COMMAND_FAILED' }));
    });
    if (signal?.aborted) onAbort();
  });
}

async function executable(pathname) {
  try {
    await fs.access(pathname, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Installs and prepares Ollama without delaying the application window. The
 * state machine is dependency-injected so a clean-device first run can be
 * verified without downloading gigabytes in the test suite.
 */
export class OllamaBootstrap {
  constructor({
    userDataRoot,
    platform = process.platform,
    environment = process.env,
    model,
    models,
    baseUrl,
    fetchImpl = globalThis.fetch,
    spawnImpl = spawn,
    localAppData,
    operations = {},
  } = {}) {
    if (!userDataRoot) throw new Error('Ollama setup requires an application data directory');
    this.environment = { ...(environment || {}) };
    this.userDataRoot = path.resolve(userDataRoot);
    this.platform = platform;
    this.model = String(model || this.environment.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL).trim();
    const requestedModels = Array.isArray(models)
      ? [this.model, ...models].map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    this.requiredModels = requestedModels.length ? [...new Set(requestedModels)] : null;
    this.baseUrl = String(baseUrl || this.environment.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.spawn = spawnImpl;
    this.localAppData = path.resolve(localAppData || this.environment.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'));
    this.cacheRoot = path.join(this.userDataRoot, 'cache', 'ollama-bootstrap');
    this.managedMacApp = path.join(this.userDataRoot, 'runtime', 'ollama', 'Ollama.app');
    this.controller = null;
    this.serverProcess = null;
    this.run = null;
    this.stopping = false;
    this.stopPromise = null;
    this.state = {
      status: 'idle',
      automatic: true,
      model: this.model,
      requiredModels: this.requiredModels ? [...this.requiredModels] : null,
      selectedModel: null,
      progress: null,
      downloadedBytes: 0,
      totalBytes: 0,
      error: null,
      updatedAt: new Date().toISOString(),
    };
    this.operations = {
      probe: operations.probe || ((options) => this.probe(options)),
      locate: operations.locate || ((options) => this.locateCommand(options)),
      install: operations.install || ((options) => this.installRuntime(options)),
      start: operations.start || ((command, options) => this.startRuntime(command, options)),
      waitUntilReachable: operations.waitUntilReachable || ((options) => this.waitUntilReachable(options)),
      pull: operations.pull || ((requestedModel, options) => this.pullModel(requestedModel, options)),
      cleanup: operations.cleanup || (() => this.cleanupCache()),
    };
  }

  snapshot() {
    return structuredClone(this.state);
  }

  update(status, extra = {}) {
    this.state = {
      ...this.state,
      ...extra,
      status,
      error: status === 'failed' ? String(extra.error || this.state.error || 'Ollama setup failed') : null,
      updatedAt: new Date().toISOString(),
    };
    return this.snapshot();
  }

  ensureReady() {
    if (this.stopping) return Promise.resolve(this.snapshot());
    if (this.run) return this.run;
    this.stopping = false;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.run = this.prepare({ signal })
      .catch((error) => {
        if (signal.aborted && this.stopping) return this.update('stopped');
        console.error('[OLLAMA-SETUP]', error);
        return this.update('failed', { error: error.message });
      })
      .finally(async () => {
        await this.operations.cleanup().catch((error) => console.warn('[OLLAMA-SETUP] cache cleanup failed:', error.message));
        this.run = null;
        this.controller = null;
      });
    return this.run;
  }

  async prepare({ signal }) {
    this.update('checking');
    let health = await this.operations.probe({ signal });
    const missingRequiredModels = () => (this.requiredModels || []).filter((model) => !health.models?.includes(model));
    if (health.models?.length && missingRequiredModels().length === 0) {
      const selectedModel = health.models.includes(this.model) ? this.model : health.models[0];
      return this.update('ready', { progress: 100, selectedModel });
    }

    let command = await this.operations.locate({ signal });
    if (!health.reachable) {
      if (!command) {
        command = await this.operations.install({
          signal,
          onProgress: (next) => this.update(next.status || 'downloading', next),
        });
      }
      health = await this.operations.probe({ signal });
      if (!health.reachable) {
        this.update('starting');
        await this.operations.start(command, { signal });
        health = await this.operations.waitUntilReachable({ signal });
      }
    }

    const modelsToPull = this.requiredModels ? missingRequiredModels() : (!health.models?.length ? [this.model] : []);
    for (const model of modelsToPull) {
      this.update('pulling', { model, progress: 0, downloadedBytes: 0, totalBytes: 0 });
      await this.operations.pull(model, {
        signal,
        onProgress: (next) => this.update('pulling', { model, ...next }),
      });
      health = await this.operations.probe({ signal });
    }
    const missing = missingRequiredModels();
    if (!health.reachable || !health.models?.length || missing.length) {
      const unavailable = missing.length ? missing : [this.model];
      throw new Error(`Ollama started, but model${unavailable.length === 1 ? '' : 's'} “${unavailable.join(', ')}” ${unavailable.length === 1 ? 'was' : 'were'} not installed successfully`);
    }
    const selectedModel = health.models.includes(this.model) ? this.model : health.models[0];
    return this.update('ready', { model: this.model, progress: 100, selectedModel });
  }

  async probe({ signal } = {}) {
    const timeout = AbortSignal.timeout(2_500);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.fetch(`${this.baseUrl}/api/tags`, { signal: requestSignal });
      if (!response.ok) return { reachable: false, models: [] };
      const body = await response.json();
      return {
        reachable: true,
        models: [...new Set((body.models || []).map((item) => item.name || item.model).filter(Boolean))],
      };
    } catch (error) {
      if (signal?.aborted) throw abortError();
      return { reachable: false, models: [] };
    }
  }

  async locateCommand({ signal } = {}) {
    const candidates = this.platform === 'win32'
      ? [
          path.join(this.localAppData, 'Programs', 'Ollama', 'ollama.exe'),
          'ollama.exe',
        ]
      : [
          path.join(this.managedMacApp, 'Contents', 'Resources', 'ollama'),
          '/Applications/Ollama.app/Contents/Resources/ollama',
          '/opt/homebrew/bin/ollama',
          '/usr/local/bin/ollama',
          'ollama',
        ];
    for (const candidate of candidates) {
      if (path.isAbsolute(candidate) && await executable(candidate)) return candidate;
      if (!path.isAbsolute(candidate)) {
        try {
          await runProcess(candidate, ['--version'], {
            signal,
            timeoutMs: 5_000,
            spawnImpl: this.spawn,
            env: this.environment,
          });
          return candidate;
        } catch (error) {
          if (signal?.aborted) throw error;
        }
      }
    }
    return null;
  }

  async download(url, target, { signal, onProgress }) {
    const response = await this.fetch(url, { redirect: 'follow', signal });
    if (!response.ok || !response.body) throw new Error(`Ollama download failed (${response.status})`);
    const totalBytes = Math.max(0, Number(response.headers.get('content-length')) || 0);
    const file = await fs.open(target, 'w');
    let downloadedBytes = 0;
    let lastProgress = -1;
    try {
      for await (const chunk of response.body) {
        if (signal?.aborted) throw abortError();
        const bytes = Buffer.from(chunk);
        await file.write(bytes);
        downloadedBytes += bytes.length;
        const progress = totalBytes ? Math.min(100, Math.floor(downloadedBytes / totalBytes * 100)) : null;
        if (progress !== lastProgress) {
          lastProgress = progress;
          onProgress?.({ status: 'downloading', progress, downloadedBytes, totalBytes });
        }
      }
    } finally {
      await file.close();
    }
    return target;
  }

  async installRuntime({ signal, onProgress }) {
    await this.cleanupCache();
    await fs.mkdir(this.cacheRoot, { recursive: true });
    if (this.platform === 'win32') {
      const installer = path.join(this.cacheRoot, 'OllamaSetup.exe');
      await this.download(WINDOWS_DOWNLOAD_URL, installer, { signal, onProgress });
      onProgress?.({ status: 'installing', progress: 100 });
      const verifyScript = [
        `$installerPath = [Environment]::GetEnvironmentVariable('${WINDOWS_INSTALLER_PATH_ENV}', 'Process')`,
        "if ([string]::IsNullOrWhiteSpace($installerPath)) { Write-Error 'Ollama installer path is missing'; exit 1 }",
        "if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) { Write-Error 'Ollama installer was not found'; exit 1 }",
        '$signature = Get-AuthenticodeSignature -LiteralPath $installerPath',
        "if ($signature.Status -ne 'Valid') { Write-Error ('Invalid Ollama installer signature: ' + $signature.Status); exit 1 }",
      ].join('; ');
      await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', verifyScript], {
        signal,
        timeoutMs: 60_000,
        spawnImpl: this.spawn,
        // PowerShell treats tokens after a -Command script as more commands,
        // not as entries in $args. An environment value preserves Windows
        // paths with spaces without interpolating them into executable code.
        env: { ...this.environment, [WINDOWS_INSTALLER_PATH_ENV]: installer },
      });
      // Match Ollama's official installer script so its application starts in
      // the background instead of opening a second first-run window.
      const marker = path.join(this.localAppData, 'Ollama', 'upgraded');
      await fs.mkdir(path.dirname(marker), { recursive: true });
      await fs.writeFile(marker, '');
      try {
        await runProcess(installer, ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES', '/SP-'], {
          signal,
          timeoutMs: 30 * 60_000,
          spawnImpl: this.spawn,
          env: this.environment,
        });
      } catch (error) {
        await fs.rm(marker, { force: true }).catch(() => {});
        throw error;
      }
      const command = await this.locateCommand({ signal });
      if (!command) throw new Error('Ollama installation completed, but ollama.exe was not found');
      return command;
    }
    if (this.platform === 'darwin') {
      const archive = path.join(this.cacheRoot, 'Ollama-darwin.zip');
      const staging = path.join(this.cacheRoot, 'expanded');
      await this.download(MAC_DOWNLOAD_URL, archive, { signal, onProgress });
      onProgress?.({ status: 'installing', progress: 100 });
      await fs.mkdir(staging, { recursive: true });
      await runProcess('/usr/bin/ditto', ['-x', '-k', archive, staging], {
        signal,
        timeoutMs: 10 * 60_000,
        spawnImpl: this.spawn,
        env: this.environment,
      });
      const extractedApp = path.join(staging, 'Ollama.app');
      const extractedCommand = path.join(extractedApp, 'Contents', 'Resources', 'ollama');
      if (!await executable(extractedCommand)) throw new Error('Downloaded Ollama archive did not contain the expected executable');
      await runProcess('/usr/bin/codesign', ['--verify', '--deep', '--strict', extractedApp], {
        signal,
        timeoutMs: 60_000,
        spawnImpl: this.spawn,
        env: this.environment,
      });
      await fs.mkdir(path.dirname(this.managedMacApp), { recursive: true });
      await fs.rm(this.managedMacApp, { recursive: true, force: true });
      await fs.rename(extractedApp, this.managedMacApp);
      return path.join(this.managedMacApp, 'Contents', 'Resources', 'ollama');
    }
    throw new Error(`Automatic Ollama installation is not supported on ${this.platform}`);
  }

  async startRuntime(command, { signal } = {}) {
    if (!command) throw new Error('Ollama was not found after installation');
    if (signal?.aborted) throw abortError();
    const endpoint = new URL(this.baseUrl);
    const ollamaHost = `${endpoint.hostname}:${endpoint.port || '11434'}`;
    const child = this.spawn(command, ['serve'], {
      env: { ...this.environment, OLLAMA_HOST: ollamaHost },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.serverProcess = child;
    let output = '';
    child.stdout?.on('data', (chunk) => { output = boundedAppend(output, chunk); });
    child.stderr?.on('data', (chunk) => { output = boundedAppend(output, chunk); });
    child.once('exit', (code) => {
      if (this.serverProcess === child) this.serverProcess = null;
      if (code && !this.stopping) console.warn(`[OLLAMA-SETUP] Ollama server exited (${code}): ${output.trim()}`);
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  }

  async waitUntilReachable({ signal } = {}) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const health = await this.operations.probe({ signal });
      if (health.reachable) return health;
      await delay(500, signal);
    }
    throw new Error('Ollama did not start within 60 seconds');
  }

  async pullModel(model, { signal, onProgress } = {}) {
    const response = await this.fetch(`${this.baseUrl}/api/pull`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Ollama model download failed (${response.status})${detail ? `: ${detail.slice(0, 400)}` : ''}`);
    }
    const decoder = new TextDecoder();
    let pending = '';
    const consume = (line) => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.error) throw new Error(`Ollama model download failed: ${event.error}`);
      const totalBytes = Math.max(0, Number(event.total) || 0);
      const downloadedBytes = Math.max(0, Number(event.completed) || 0);
      const progress = totalBytes ? Math.min(100, Math.floor(downloadedBytes / totalBytes * 100)) : null;
      onProgress?.({ progress, downloadedBytes, totalBytes });
    };
    for await (const chunk of response.body) {
      if (signal?.aborted) throw abortError();
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) consume(line);
    }
    pending += decoder.decode();
    if (pending.trim()) consume(pending);
  }

  async cleanupCache() {
    await fs.rm(this.cacheRoot, { recursive: true, force: true });
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.controller?.abort();
    const child = this.serverProcess;
    this.serverProcess = null;
    this.stopPromise = (async () => {
      const results = await Promise.allSettled([terminateChild(child), this.run]);
      await this.cleanupCache();
      this.update('stopped');
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Ollama shutdown failed');
    })();
    return this.stopPromise;
  }
}

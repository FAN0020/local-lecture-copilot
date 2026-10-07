import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { spawn } from 'node:child_process';
import { DEFAULT_STT_MODEL, WHISPER_MODELS, WhisperModelManager } from './whisper-models.js';

export { DEFAULT_STT_MODEL } from './whisper-models.js';
export const STT_MODELS = WHISPER_MODELS.map((model) => model.id);
export const DEFAULT_STT_LANGUAGE = 'en';
export const STT_LANGUAGES = ['en', 'zh', 'ms', 'auto', 'es', 'fr', 'de', 'ja', 'ko', 'pt', 'ru', 'it'];
export const DEFAULT_WHISPER_CPU_THREADS = 2;
export const MAX_WHISPER_CPU_THREADS = 4;
export const MAX_WHISPER_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_WHISPER_TIMEOUT_MS = 10 * 60 * 1000;
const ENGLISH_LECTURE_PROMPT = 'This is an English university lecture. Transcribe the speech in English.';

function executableName(platform = process.platform) {
  return platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
}

export function resolveWhisperBackendPolicy({ platform = process.platform, cpuThreads = DEFAULT_WHISPER_CPU_THREADS } = {}) {
  const threads = Math.min(MAX_WHISPER_CPU_THREADS, Math.max(1, Math.floor(Number(cpuThreads) || DEFAULT_WHISPER_CPU_THREADS)));
  const macCpuFallback = platform === 'darwin';
  return Object.freeze({
    backend: macCpuFallback ? 'cpu' : 'platform-default',
    threads,
    args: Object.freeze(['--threads', String(threads), ...(macCpuFallback ? ['--no-gpu'] : [])]),
    reason: macCpuFallback ? 'whisper.cpp b4938 Metal model loading is not reliable in the packaged runtime' : null,
  });
}

export function runWhisperCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(Object.assign(new Error('Whisper inference was cancelled'), { name: 'AbortError', code: 'ABORT_ERR' }));
      return;
    }
    const {
      onProgress,
      signal,
      abortGraceMs = 1_000,
      timeoutMs = DEFAULT_WHISPER_TIMEOUT_MS,
      maxOutputBytes = MAX_WHISPER_OUTPUT_BYTES,
      onSpawn,
      onExit,
      ...spawnOptions
    } = options;
    const child = spawn(command, args, { ...spawnOptions, shell: false, windowsHide: true });
    // Keep the recording UI and other Mac apps responsive during CPU inference.
    // Priority changes can be unavailable on a host; inference still works then.
    if (child.pid) {
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* Best effort. */ }
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let aborted = false;
    let timedOut = false;
    let forceKillTimer = null;
    let timeoutTimer = null;
    const appendTail = (current, chunk) => {
      const combined = current + chunk.toString();
      return combined.length > maxOutputBytes ? combined.slice(-maxOutputBytes) : combined;
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', cancel);
      onExit?.(child);
      callback(value);
    };
    const cancel = () => {
      if (aborted) return;
      aborted = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, Math.max(0, Number(abortGraceMs) || 0));
      forceKillTimer.unref?.();
    };
    onSpawn?.(child);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      cancel();
    }, Math.max(1, Number(timeoutMs) || DEFAULT_WHISPER_TIMEOUT_MS));
    timeoutTimer.unref?.();
    child.stdout?.on('data', (chunk) => { stdout = appendTail(stdout, chunk); onProgress?.(chunk.toString()); });
    child.stderr?.on('data', (chunk) => { stderr = appendTail(stderr, chunk); onProgress?.(chunk.toString()); });
    child.on('error', (error) => finish(reject, new Error(`Could not start the managed Whisper runtime at “${command}”: ${error.message}`)));
    child.on('close', (code) => {
      if (timedOut) {
        finish(reject, Object.assign(new Error(`Whisper timed out after ${Math.round(timeoutMs / 1000)} seconds`), { status: 504, code: 'STT_TIMEOUT' }));
      } else if (aborted || signal?.aborted) {
        finish(reject, Object.assign(new Error('Whisper inference was preempted by higher-priority transcription'), { name: 'AbortError', code: 'ABORT_ERR' }));
      } else if (code === 0) finish(resolve, { stdout, stderr });
      else finish(reject, new Error(`Whisper stopped unexpectedly with code ${code}. ${stderr.trim().slice(-1200)}`));
    });
  });
}

async function available(file, executable = false) {
  try {
    await fs.access(file, executable && process.platform !== 'win32' ? fsConstants.X_OK : fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function segmentText(result) {
  if (typeof result?.text === 'string') return result.text;
  if (Array.isArray(result?.transcription)) return result.transcription.map((item) => item.text || item.tokens?.map((token) => token.text).join('') || '').join(' ');
  return '';
}

function segments(result) {
  const values = result?.segments || result?.transcription || [];
  return values.map((segment) => ({
    start: Number(segment.start ?? segment.offsets?.from ?? 0) / (segment.offsets ? 1000 : 1),
    end: Number(segment.end ?? segment.offsets?.to ?? 0) / (segment.offsets ? 1000 : 1),
    text: String(segment.text || segment.tokens?.map((token) => token.text).join('') || '').trim(),
  })).filter((segment) => segment.text);
}

// Whisper can emit stock video-closing captions for silent audio. Treat only
// standalone segments as hallucinations so ordinary speech containing the
// same words inside a longer sentence is preserved.
function isAutomaticClosingCaption(value) {
  return /^(?:thanks|thank you)\s+for\s+watching[.!?…]*$/iu.test(String(value || '').trim());
}

/** Managed whisper.cpp provider used by web and desktop hosts. */
export class WhisperProvider {
  constructor({ runtimeRoot, binary, bundledModelRoot, modelRoot, modelManager, registry, downloader, hasher, runner = runWhisperCommand, platform = process.platform, cpuThreads = DEFAULT_WHISPER_CPU_THREADS, commandTimeoutMs = process.env.LECTURE_COPILOT_STT_TIMEOUT_MS || DEFAULT_WHISPER_TIMEOUT_MS } = {}) {
    const root = runtimeRoot ? path.resolve(runtimeRoot) : null;
    this.platform = platform;
    this.backendPolicy = resolveWhisperBackendPolicy({ platform, cpuThreads });
    this.binary = path.resolve(binary || (root ? path.join(root, 'bin', executableName(platform)) : executableName(platform)));
    this.bundledModelRoot = path.resolve(bundledModelRoot || (root ? path.join(root, 'models') : '.'));
    this.modelRoot = path.resolve(modelRoot || this.bundledModelRoot);
    this.modelManager = modelManager || new WhisperModelManager({
      bundledModelRoot: this.bundledModelRoot,
      installRoot: this.modelRoot,
      registry,
      downloader,
      hasher,
      platform,
    });
    this.runner = runner;
    this.commandTimeoutMs = Math.max(1, Number(commandTimeoutMs) || DEFAULT_WHISPER_TIMEOUT_MS);
    this.activeControllers = new Set();
    this.activeChildren = new Set();
    this.activeTempDirs = new Set();
    this.activeTranscriptions = new Set();
    this.closed = false;
  }

  async modelPath(model) {
    return this.modelManager.resolveModelPath(model);
  }

  async status() {
    const runtimeAvailable = await available(this.binary, true);
    const modelStatus = await this.modelManager.status();
    const installedModels = modelStatus.installedModels;
    let message = 'Managed Whisper is ready.';
    if (!runtimeAvailable) message = `Managed Whisper runtime is missing at ${this.binary}. Reinstall the desktop app or run the STT runtime preparation command.`;
    else if (!installedModels.length) message = `No Whisper model is installed. Reinstall the desktop app to restore Tiny, or install a model in ${this.modelRoot}.`;
    return {
      ...modelStatus,
      ready: runtimeAvailable && installedModels.length > 0,
      runtimeAvailable,
      binaryPath: this.binary,
      modelRoot: modelStatus.installRoot,
      provider: 'whisper.cpp',
      backendPolicy: this.backendPolicy,
      message,
    };
  }

  async startModelInstall(model) {
    return this.modelManager.startInstall(model);
  }

  async installModel(model) {
    return this.modelManager.install(model);
  }

  async transcribe(audioPath, { model = DEFAULT_STT_MODEL, language = DEFAULT_STT_LANGUAGE, prompt = '', stage, signal, onProgress } = {}) {
    if (this.closed) throw Object.assign(new Error('Whisper provider is closed'), { name: 'AbortError', code: 'ABORT_ERR' });
    if (!STT_MODELS.includes(model)) throw Object.assign(new Error('Unsupported STT model'), { status: 400 });
    if (!STT_LANGUAGES.includes(language)) throw Object.assign(new Error('Unsupported language'), { status: 400 });
    if (signal?.aborted) throw Object.assign(new Error('Whisper inference was cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
    const controller = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    this.activeControllers.add(controller);
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    this.activeTranscriptions.add(done);
    let outputDir;
    try {
      // A chunk needs one model. Avoid rediscovering every installed model and
      // reading all installation manifests for each new audio segment.
      const [runtimeAvailable, modelState] = await Promise.all([
        available(this.binary, true),
        this.modelManager.modelStatus(model),
      ]);
      if (requestSignal.aborted) throw Object.assign(new Error('Whisper inference was cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
      if (!runtimeAvailable) throw Object.assign(new Error(`Managed Whisper runtime is missing at ${this.binary}. Reinstall the desktop app or run the STT runtime preparation command.`), { status: 503, code: 'STT_RUNTIME_MISSING' });
      if (modelState?.state !== 'ready') {
        throw Object.assign(new Error(`Whisper model “${model}” is not installed. Choose an installed model or prepare that model.`), { status: 503, code: 'STT_MODEL_MISSING' });
      }
      outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-copilot-stt-'));
      this.activeTempDirs.add(outputDir);
      if (requestSignal.aborted) throw Object.assign(new Error('Whisper inference was cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
      const outputPrefix = path.join(outputDir, 'transcript');
      const args = [
        '--model', modelState.path,
        '--file', path.resolve(audioPath),
        '--output-json',
        '--output-file', outputPrefix,
        '--no-prints',
        '--no-timestamps',
        ...this.backendPolicy.args,
      ];
      if (language !== 'auto') args.push('--language', language);
      // Live drafts use one decoding candidate. Keep temperature fallback so
      // uncertain audio can recover instead of producing runaway repetition.
      // Explicit revision keeps Whisper's full-quality decoder defaults.
      if (stage === 'provisional') args.push('--beam-size', '1', '--best-of', '1');
      const suppliedContext = String(prompt || '').replace(/\s+/gu, ' ').trim();
      const context = (language === 'en'
        ? [suppliedContext, ENGLISH_LECTURE_PROMPT].filter(Boolean).join(' ')
        : suppliedContext).slice(-1800);
      if (context) args.push('--prompt', context);
      onProgress?.(`Transcribing locally with managed Whisper ${model} (${this.backendPolicy.backend}, ${this.backendPolicy.threads} threads)…`);
      const commandOutput = await this.runner(this.binary, args, {
        onProgress,
        signal: requestSignal,
        timeoutMs: this.commandTimeoutMs,
        cwd: path.dirname(this.binary),
        onSpawn: (child) => this.activeChildren.add(child),
        onExit: (child) => this.activeChildren.delete(child),
      });
      let output;
      try {
        output = await fs.readFile(`${outputPrefix}.json`, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const detail = String(commandOutput?.stderr || commandOutput?.stdout || '').trim().slice(-1200);
        throw Object.assign(new Error(`Whisper could not decode the selected audio${detail ? `. ${detail}` : ''}`), {
          status: 422,
          code: 'STT_AUDIO_DECODE_FAILED',
        });
      }
      const result = JSON.parse(output);
      const sourceSegments = segments(result);
      const transcriptSegments = sourceSegments.filter((segment) => !isAutomaticClosingCaption(segment.text));
      const sourceText = sourceSegments.length
        ? transcriptSegments.map((segment) => segment.text).join(' ')
        : segmentText(result);
      const content = String(isAutomaticClosingCaption(sourceText) ? '' : sourceText).replace(/\s+/g, ' ').trim();
      if (!content) throw Object.assign(new Error('Whisper found no speech in this audio'), { status: 422, code: 'NO_SPEECH' });
      return {
        content,
        language: result.result?.language || result.language || language,
        segments: transcriptSegments,
        provider: 'whisper.cpp',
        model,
      };
    } finally {
      try {
        if (outputDir) await fs.rm(outputDir, { recursive: true, force: true });
      } finally {
        if (outputDir) this.activeTempDirs.delete(outputDir);
        this.activeControllers.delete(controller);
        this.activeTranscriptions.delete(done);
        resolveDone();
      }
    }
  }

  snapshot() {
    return {
      processes: this.activeChildren.size,
      transcriptions: this.activeTranscriptions.size,
      tempDirs: this.activeTempDirs.size,
      backend: this.backendPolicy.backend,
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.activeControllers) {
      controller.abort(Object.assign(new Error('Whisper provider is shutting down'), { name: 'AbortError', code: 'ABORT_ERR' }));
    }
    await Promise.allSettled([...this.activeTranscriptions]);
  }
}

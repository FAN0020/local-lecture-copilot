import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { retryWindowsFileOperation } from '../lib.js';

export { retryWindowsFileOperation } from '../lib.js';

const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

export const DEFAULT_STT_MODEL = 'base';

export const WHISPER_MODELS = Object.freeze([
  {
    id: 'tiny',
    label: 'Tiny',
    description: 'Fastest, lowest memory use',
    filename: 'ggml-tiny.bin',
    bytes: 77_691_713,
    sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
  },
  {
    id: 'base',
    label: 'Base',
    description: 'Fast with improved accuracy',
    filename: 'ggml-base.bin',
    bytes: 147_951_465,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    bundled: true,
  },
  {
    id: 'small',
    label: 'Small',
    description: 'Balanced accuracy and speed',
    filename: 'ggml-small.bin',
    bytes: 487_601_967,
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
  },
  {
    id: 'medium',
    label: 'Medium',
    description: 'Higher accuracy, slower processing',
    filename: 'ggml-medium.bin',
    bytes: 1_533_763_059,
    sha256: '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208',
  },
  {
    id: 'large',
    label: 'Large v3',
    description: 'Highest accuracy, largest download',
    filename: 'ggml-large-v3.bin',
    bytes: 3_095_033_483,
    sha256: '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2',
  },
  {
    id: 'turbo',
    label: 'Turbo',
    description: 'Large v3 quality optimized for speed',
    filename: 'ggml-large-v3-turbo.bin',
    bytes: 1_624_555_275,
    sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
  },
].map((model) => Object.freeze({ ...model, url: `${MODEL_BASE_URL}/${model.filename}` })));

export const WHISPER_MODEL_REGISTRY = Object.freeze(Object.fromEntries(WHISPER_MODELS.map((model) => [model.id, model])));

function errorWithStatus(message, status = 500, code = 'STT_MODEL_INSTALL_FAILED') {
  return Object.assign(new Error(message), { status, code });
}


function validateModelMetadata(model) {
  const filename = String(model?.filename || '');
  if (!model?.id || !filename || path.posix.basename(filename) !== filename || path.win32.basename(filename) !== filename || ['.', '..'].includes(filename)) {
    throw new TypeError(`Invalid Whisper model metadata for “${model?.id || 'unknown'}”`);
  }
  return Object.freeze({ ...model });
}

async function fileStat(file) {
  try {
    return await fs.stat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeAtomicJson(file, value, { moveFile = fs.rename, removeFile = fs.rm, ...retryOptions } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await retryWindowsFileOperation(() => moveFile(temporary, file), retryOptions);
  } catch (error) {
    await retryWindowsFileOperation(() => removeFile(temporary, { force: true }), retryOptions).catch(() => {});
    throw error;
  }
}

export async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function downloadModelFile({ url, destination, expectedBytes, onProgress, fetcher = globalThis.fetch, attempts = 3, platform = process.platform }) {
  if (typeof fetcher !== 'function') throw new Error('This Node runtime does not provide fetch for model downloads');
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let handle;
    try {
      await retryWindowsFileOperation(() => fs.rm(destination, { force: true }), { platform });
      const response = await fetcher(url, { redirect: 'follow' });
      if (!response.ok) {
        throw Object.assign(new Error(`Download server returned ${response.status} ${response.statusText}`), { httpStatus: response.status });
      }
      if (!response.body) throw new Error('Download server returned an empty response body');
      const headerBytes = Number(response.headers.get('content-length'));
      const totalBytes = Number.isFinite(headerBytes) && headerBytes > 0 ? headerBytes : expectedBytes;
      handle = await fs.open(destination, 'wx');
      let downloadedBytes = 0;
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        await handle.write(buffer);
        downloadedBytes += buffer.length;
        onProgress?.({ downloadedBytes, totalBytes, attempt });
      }
      await handle.sync();
      await handle.close();
      handle = null;
      return { downloadedBytes, totalBytes };
    } catch (error) {
      lastError = error;
      await handle?.close().catch(() => {});
      if (attempt === attempts) break;
    }
  }
  throw Object.assign(new Error(`Model download failed after ${attempts} attempts: ${lastError?.message || 'unknown error'}`, { cause: lastError }), {
    code: lastError?.code,
    httpStatus: lastError?.httpStatus,
  });
}

/**
 * Owns Whisper model metadata, discovery, safe installation, and runtime state.
 * Downloaded models require both an atomically promoted model file and a matching
 * install record; temporary or interrupted files are never considered installed.
 */
export class WhisperModelManager {
  constructor({
    bundledModelRoot,
    installRoot,
    registry = WHISPER_MODELS,
    downloader = downloadModelFile,
    hasher = sha256File,
    onStateChange,
    platform = process.platform,
    fileRetryDelayMs = 50,
    logger = console,
    moveFile = fs.rename,
    removeFile = fs.rm,
  } = {}) {
    if (!bundledModelRoot) throw new TypeError('bundledModelRoot is required');
    if (!installRoot) throw new TypeError('installRoot is required');
    this.bundledModelRoot = path.resolve(bundledModelRoot);
    this.installRoot = path.resolve(installRoot);
    this.registry = new Map(registry.map((model) => [model.id, validateModelMetadata(model)]));
    this.downloader = downloader;
    this.hasher = hasher;
    this.onStateChange = onStateChange;
    this.platform = platform;
    this.fileRetryDelayMs = Math.max(0, Number(fileRetryDelayMs) || 0);
    this.logger = logger;
    this.moveFile = moveFile;
    this.removeFile = removeFile;
    this.states = new Map();
    this.installations = new Map();
  }

  metadata(modelId) {
    const model = this.registry.get(modelId);
    if (!model) throw errorWithStatus(`Unsupported Whisper model “${modelId}”`, 400, 'STT_MODEL_UNSUPPORTED');
    return model;
  }

  installedPath(model) {
    return path.join(this.installRoot, model.filename);
  }

  bundledPath(model) {
    return path.join(this.bundledModelRoot, model.filename);
  }

  partialPath(model) {
    return `${this.installedPath(model)}.partial`;
  }

  manifestPath(model) {
    return `${this.installedPath(model)}.install.json`;
  }

  publicState(model, state) {
    const totalBytes = Number(state.totalBytes || model.bytes);
    const downloadedBytes = Number(state.downloadedBytes || 0);
    const progress = totalBytes > 0 ? Math.min(100, Math.max(0, (downloadedBytes / totalBytes) * 100)) : null;
    return {
      id: model.id,
      label: model.label,
      description: model.description,
      filename: model.filename,
      bytes: model.bytes,
      bundled: Boolean(model.bundled),
      state: state.state,
      installed: state.state === 'ready',
      canInstall: ['missing', 'failed'].includes(state.state),
      source: state.source || null,
      path: state.path || null,
      downloadedBytes,
      totalBytes,
      progress,
      error: state.error || null,
      errorCode: state.errorCode || null,
      errorStatus: state.errorStatus || null,
      installStage: state.installStage || null,
      targetPath: state.targetPath || null,
    };
  }

  setState(model, state) {
    const value = this.publicState(model, state);
    this.states.set(model.id, value);
    this.onStateChange?.(structuredClone(value));
    return value;
  }

  async discoveredState(model) {
    const installedPath = this.installedPath(model);
    const manifest = await readJson(this.manifestPath(model));
    const installedStat = await fileStat(installedPath);
    if (installedStat?.isFile() && installedStat.size === model.bytes
      && manifest?.schemaVersion === 1
      && manifest.id === model.id
      && manifest.filename === model.filename
      && manifest.bytes === model.bytes
      && manifest.sha256 === model.sha256) {
      return this.publicState(model, { state: 'ready', source: 'downloaded', path: installedPath, downloadedBytes: model.bytes, totalBytes: model.bytes });
    }

    if (model.bundled) {
      const bundledPath = this.bundledPath(model);
      const bundledStat = await fileStat(bundledPath);
      if (bundledStat?.isFile() && bundledStat.size === model.bytes) {
        return this.publicState(model, { state: 'ready', source: 'bundled', path: bundledPath, downloadedBytes: model.bytes, totalBytes: model.bytes });
      }
    }
    return this.publicState(model, { state: 'missing', downloadedBytes: 0, totalBytes: model.bytes });
  }

  async modelStatus(modelId) {
    const model = this.metadata(modelId);
    const remembered = this.states.get(model.id);
    if (remembered && ['downloading', 'verifying', 'failed'].includes(remembered.state)) return structuredClone(remembered);
    const discovered = await this.discoveredState(model);
    if (discovered.state === 'ready') this.states.set(model.id, discovered);
    else if (remembered?.state === 'ready') this.states.delete(model.id);
    return structuredClone(discovered);
  }

  async status() {
    const details = await Promise.all([...this.registry.keys()].map((id) => this.modelStatus(id)));
    const modelStates = Object.fromEntries(details.map((model) => [model.id, model]));
    const models = Object.fromEntries(details.map((model) => [model.id, model.state === 'ready']));
    return {
      registry: details.map(({ state, installed, canInstall, source, path: modelPath, downloadedBytes, totalBytes, progress, error, ...metadata }) => metadata),
      modelStates,
      models,
      installedModels: details.filter((model) => model.state === 'ready').map((model) => model.id),
      installRoot: this.installRoot,
      bundledModelRoot: this.bundledModelRoot,
    };
  }

  async resolveModelPath(modelId) {
    const state = await this.modelStatus(modelId);
    return state.state === 'ready' ? state.path : null;
  }

  async startInstall(modelId) {
    const model = this.metadata(modelId);
    const currentInstallation = this.installations.get(model.id);
    if (currentInstallation) return this.modelStatus(model.id);
    this.setState(model, {
      state: 'downloading',
      downloadedBytes: 0,
      totalBytes: model.bytes,
      installStage: 'prepare',
      targetPath: this.installedPath(model),
    });
    const installation = (async () => {
      const discovered = await this.discoveredState(model);
      if (discovered.state === 'ready') {
        this.states.set(model.id, discovered);
        return discovered;
      }
      return this.performInstall(model);
    })()
      .finally(() => this.installations.delete(model.id));
    this.installations.set(model.id, installation);
    installation.catch(() => {});
    return this.modelStatus(model.id);
  }

  async install(modelId) {
    await this.startInstall(modelId);
    const installation = this.installations.get(modelId);
    if (installation) await installation;
    return this.modelStatus(modelId);
  }

  async performInstall(model) {
    const partialPath = this.partialPath(model);
    const installedPath = this.installedPath(model);
    const manifestPath = this.manifestPath(model);
    const retryOptions = { platform: this.platform, delayMs: this.fileRetryDelayMs };
    let stage = 'prepare';
    let promoted = false;
    try {
      await fs.mkdir(this.installRoot, { recursive: true });
      await retryWindowsFileOperation(() => this.removeFile(partialPath, { force: true }), retryOptions);
      stage = 'download';
      await this.downloader({
        model,
        url: model.url,
        destination: partialPath,
        expectedBytes: model.bytes,
        platform: this.platform,
        onProgress: ({ downloadedBytes, totalBytes = model.bytes }) => {
          this.setState(model, { state: 'downloading', downloadedBytes, totalBytes, installStage: stage, targetPath: installedPath });
        },
      });
      stage = 'verify-size';
      const partialStat = await fileStat(partialPath);
      if (!partialStat?.isFile() || partialStat.size !== model.bytes) {
        throw new Error(`Downloaded ${partialStat?.size || 0} bytes; expected ${model.bytes}`);
      }

      stage = 'verify-sha256';
      this.setState(model, { state: 'verifying', downloadedBytes: model.bytes, totalBytes: model.bytes, installStage: stage, targetPath: installedPath });
      const actualHash = await this.hasher(partialPath);
      if (actualHash !== model.sha256) throw new Error(`Integrity check failed for ${model.label}`);

      stage = 'promote';
      await retryWindowsFileOperation(() => this.removeFile(installedPath, { force: true }), retryOptions);
      await retryWindowsFileOperation(() => this.removeFile(manifestPath, { force: true }), retryOptions);
      await retryWindowsFileOperation(() => this.moveFile(partialPath, installedPath), retryOptions);
      promoted = true;
      stage = 'write-manifest';
      await writeAtomicJson(manifestPath, {
        schemaVersion: 1,
        id: model.id,
        filename: model.filename,
        bytes: model.bytes,
        sha256: model.sha256,
        installedAt: new Date().toISOString(),
      }, { ...retryOptions, moveFile: this.moveFile, removeFile: this.removeFile });
      return this.setState(model, { state: 'ready', source: 'downloaded', path: installedPath, downloadedBytes: model.bytes, totalBytes: model.bytes });
    } catch (error) {
      await retryWindowsFileOperation(() => this.removeFile(partialPath, { force: true }), retryOptions).catch(() => {});
      if (promoted) {
        await retryWindowsFileOperation(() => this.removeFile(manifestPath, { force: true }), retryOptions).catch(() => {});
        await retryWindowsFileOperation(() => this.removeFile(installedPath, { force: true }), retryOptions).catch(() => {});
      }
      const failure = {
        model: model.id,
        targetPath: installedPath,
        stage,
        code: error.code || null,
        status: error.httpStatus || error.status || null,
        message: error.message || String(error),
      };
      this.logger?.error?.('[Whisper model install failed]', failure);
      const detail = `${stage}${failure.code ? ` (${failure.code})` : ''}: ${failure.message}`;
      this.setState(model, {
        state: 'failed',
        downloadedBytes: 0,
        totalBytes: model.bytes,
        error: detail,
        errorCode: failure.code,
        errorStatus: failure.status,
        installStage: stage,
        targetPath: installedPath,
      });
      throw Object.assign(errorWithStatus(`Could not install Whisper ${model.label} during ${detail}`), {
        cause: error,
        installStage: stage,
        targetPath: installedPath,
      });
    }
  }
}

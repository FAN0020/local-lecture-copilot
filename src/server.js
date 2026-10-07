import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from './app.js';
import { ASR_STAGES, resolveAsrModelPlan } from './asr-pipeline.js';
import { SessionStore } from './store.js';
import { DEFAULT_STT_MODEL, STT_MODELS, WhisperProvider } from './providers/stt.js';
import { OllamaProvider } from './providers/llm.js';
import { LocalMaterialExtractor } from './providers/material.js';
import { loadSettings, saveSettings } from './settings.js';

const __filename = fileURLToPath(import.meta.url);

function envValue(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

/**
 * Start the local HTTP application. The returned runtime is used by the
 * Electron shell and by the CLI entry point, keeping one shared web app.
 */
export async function startServer(options = {}) {
  const port = Number(options.port ?? envValue('PORT', 4318));
  const host = String(options.host ?? envValue('HOST', '127.0.0.1'));
  const settingsPath = path.resolve(options.settingsPath ?? envValue('LECTURE_COPILOT_SETTINGS', '.lecture-copilot-config.json'));
  let persistedSettings = await loadSettings(settingsPath);
  let appLanguage = ['en', 'zh-CN'].includes(persistedSettings.appLanguage) ? persistedSettings.appLanguage : 'zh-CN';
  const explicitDataRoot = options.dataRoot ?? process.env.LECTURE_COPILOT_DATA;
  const defaultDataRoot = options.defaultDataRoot ?? '.lecture-copilot';
  const dataRoot = path.resolve(explicitDataRoot || persistedSettings.workspaceRoot || defaultDataRoot);
  const store = options.store || new SessionStore(dataRoot);
  await store.init();
  const runtimeRoot = path.resolve(options.sttRuntimeRoot || process.env.LECTURE_COPILOT_STT_RUNTIME || path.join('runtime', 'stt', `${process.platform}-${process.platform === 'win32' ? 'x64' : process.arch}`));
  const modelRoot = path.resolve(options.sttModelRoot || process.env.LECTURE_COPILOT_STT_MODELS || path.join(path.dirname(settingsPath), 'models', 'whisper.cpp'));
  const stt = options.stt || new WhisperProvider({ runtimeRoot, modelRoot });
  const initialSttRuntime = await Promise.resolve(stt.status?.()).catch(() => null);
  const initialInstalledModels = initialSttRuntime?.installedModels?.length
    ? initialSttRuntime.installedModels
    : [DEFAULT_STT_MODEL];
  let asrModels = resolveAsrModelPlan(initialInstalledModels, {
    stageModels: persistedSettings.asrModels,
  }).models;

  const settings = {
    async get() {
      return {
        storagePath: store.root,
        storageKind: 'filesystem',
        canChooseDirectory: Boolean(options.directoryChooser),
        appLanguage,
        asrModels: { ...asrModels },
      };
    },
    async update(input = {}) {
      const requested = String(input.storagePath || '').trim();
      let nextAppLanguage = appLanguage;
      let nextAsrModels = asrModels;
      if (input.appLanguage !== undefined) {
        const next = String(input.appLanguage).trim();
        if (!['en', 'zh-CN'].includes(next)) throw Object.assign(new Error('Unsupported app language'), { status: 400 });
        nextAppLanguage = next;
      }
      if (input.asrModels !== undefined) {
        if (!input.asrModels || typeof input.asrModels !== 'object' || Array.isArray(input.asrModels)) {
          throw Object.assign(new Error('Transcription model selections are required'), { status: 400, code: 'INVALID_ASR_MODELS' });
        }
        const runtime = await stt.status?.() || {};
        const installed = new Set(runtime.installedModels || Object.entries(runtime.models || {}).filter(([, ready]) => ready).map(([id]) => id));
        const selected = {};
        for (const stage of ASR_STAGES) {
          const model = String(input.asrModels[stage] || '').trim();
          if (!model || !installed.has(model) || (runtime.modelStates?.[model] && runtime.modelStates[model].state !== 'ready')) {
            throw Object.assign(new Error(`Whisper model “${model || 'unknown'}” is not installed and ready for ${stage} transcription.`), {
              status: 400,
              code: 'STT_MODEL_NOT_INSTALLED',
            });
          }
          selected[stage] = model;
        }
        nextAsrModels = selected;
      }
      if (!requested && input.appLanguage === undefined && input.asrModels === undefined) {
        throw Object.assign(new Error('No settings changes were provided'), { status: 400 });
      }
      if (requested) await store.switchRoot(requested);
      appLanguage = nextAppLanguage;
      asrModels = nextAsrModels;
      persistedSettings = { ...persistedSettings, workspaceRoot: store.root, appLanguage, asrModels: { ...asrModels } };
      await saveSettings(settingsPath, persistedSettings);
      return {
        storagePath: store.root,
        storageKind: 'filesystem',
        canChooseDirectory: Boolean(options.directoryChooser),
        appLanguage,
        asrModels: { ...asrModels },
      };
    },
  };

  const handler = createApp({
    store,
    stt,
    llm: options.llm || new OllamaProvider(),
    materials: options.materials || new LocalMaterialExtractor(),
    webRoot: options.webRoot,
    settings,
    ollamaBootstrap: options.ollamaBootstrap,
  });
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host}:${actualPort}`;
  let stopping = null;
  return {
    server,
    handler,
    store,
    stt,
    settingsPath,
    dataRoot: store.root,
    sttModelRoot: modelRoot,
    host,
    port: actualPort,
    url,
    async stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        const results = await Promise.allSettled([
          (async () => {
            try { await handler.close?.(); }
            finally { await options.ollamaBootstrap?.stop?.(); }
          })(),
          new Promise((resolve) => server.close(() => resolve())),
        ]);
        const failures = results.filter((result) => result.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Runtime shutdown failed');
      })();
      return stopping;
    },
  };
}

async function runCli() {
  const runtime = await startServer();
  console.log(`Local Lecture Copilot is ready at ${runtime.url}`);
  console.log(`Sessions are stored in ${runtime.dataRoot}`);

  function shutdown() {
    runtime.stop().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(__filename).href) {
  await runCli();
}

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_OLLAMA_MODELS, OllamaBootstrap } from '../src/ollama-bootstrap.js';
import { startServer } from '../src/server.js';
import { resolveDesktopRuntimePaths } from './runtime-paths.js';
import { assertRuntimeIdle, validateLiveAudio } from './live-audio-validation.js';

let runtime;
let ollamaBootstrap;
let runtimeDiagnosticsTimer;
let quitting = false;
const liveAudioEvidence = {};
const smokeAudioPath = String(process.env.LECTURE_COPILOT_SMOKE_AUDIO || '').trim();
const smokeResultPath = String(process.env.LECTURE_COPILOT_SMOKE_RESULT || '').trim();
const smokeUserDataPath = String(process.env.LECTURE_COPILOT_SMOKE_USER_DATA || '').trim();
if (smokeResultPath) app.disableHardwareAcceleration();
if (smokeUserDataPath) app.setPath('userData', path.resolve(smokeUserDataPath));

function megabytes(bytes) {
  return (Number(bytes || 0) / (1024 * 1024)).toFixed(1);
}

async function logRuntimeMemory() {
  if (!runtime) return;
  try {
    const [processInfo, state] = await Promise.all([
      process.getProcessMemoryInfo(),
      runtime.handler.runtimeSnapshot(),
    ]);
    console.log([
      '[RUNTIME-MEM]',
      `privateMB=${megabytes(processInfo.private * 1024)}`,
      `rssMB=${megabytes(processInfo.residentSet * 1024)}`,
      `heapMB=${megabytes(state.heapUsed)}`,
      `externalMB=${megabytes(state.external)}`,
      `arrayBuffersMB=${megabytes(state.arrayBuffers)}`,
      `audioBytesMB=${megabytes(state.audioBytes)}`,
      `audioChunks=${state.audioChunks}`,
      `smallTurboHqQ=${state.whisper.queued}`,
      `whisperActive=${state.whisper.active}`,
      `whisperProcesses=${state.whisper.processes || 0}`,
      `translationQ=${state.llm.queued}`,
      `llmActive=${state.llm.active}`,
      `segments=${state.segments}`,
      `jobs=${state.derivedJobs + state.recoveryJobs + state.rawTranslationJobs}`,
      `tempDirs=${state.whisper.tempDirs || 0}`,
    ].join(' '));
    const lifecycle = state.llm.lifecycle || {};
    const modelState = lifecycle.models?.[0] || {};
    const request = lifecycle.activeRequests?.[0] || state.llm.running?.[0]?.metadata || state.llm.pending?.[0]?.metadata || {};
    const loaded = state.llm.runningModels?.[0] || {};
    console.log([
      '[LLM-RUNTIME]',
      `active=${state.llm.active}`,
      `queued=${state.llm.queued}`,
      `model=${request.model || modelState.model || loaded.name || 'none'}`,
      `requestType=${request.requestType || 'none'}`,
      `requestsSinceReset=${modelState.requestsSinceReset || 0}`,
      `runnerAgeSec=${((modelState.runnerAgeMs || 0) / 1000).toFixed(1)}`,
      `resetPending=${Boolean(lifecycle.resetPending)}`,
      `lastResetReason=${lifecycle.lastReset?.reason || 'none'}`,
      `promptChars=${request.promptCharacters || 0}`,
      `promptTokensEst=${request.estimatedPromptTokens || 0}`,
      `retrievedChars=${request.retrievedContextCharacters || 0}`,
      `numCtx=${request.numCtx || loaded.contextLength || 0}`,
      `numPredict=${request.numPredict || 0}`,
      `requestAgeSec=${((request.ageMs || 0) / 1000).toFixed(1)}`,
      `completed=${lifecycle.completed || 0}`,
      `cancelled=${lifecycle.cancelled || 0}`,
      `failed=${lifecycle.failed || 0}`,
      `loadedModels=${state.llm.runningModels?.length || 0}`,
    ].join(' '));
  } catch (error) {
    console.warn('[RUNTIME-MEM] diagnostics failed:', error.message);
  }
}

async function writeSmokeResult(value) {
  if (!smokeResultPath) return;
  const output = path.resolve(smokeResultPath);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, output);
}

async function stopResources() {
  if (runtime) await runtime.stop();
  else await ollamaBootstrap?.stop();
}

async function chooseWorkspace() {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0] || null;
}

async function createWindow() {
  const desktopPaths = resolveDesktopRuntimePaths({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    userData: app.getPath('userData'),
  });
  const icon = desktopPaths.icon;
  if (process.platform === 'darwin') app.dock.setIcon(icon);
  // Validation deliberately exercises an unavailable provider without installing software.
  if (!smokeResultPath && process.env.LECTURE_COPILOT_OLLAMA_SETUP !== '0') {
    ollamaBootstrap = new OllamaBootstrap({
      userDataRoot: app.getPath('userData'),
      models: DEFAULT_OLLAMA_MODELS,
    });
    void ollamaBootstrap.ensureReady();
  }
  runtime = await startServer({
    host: '127.0.0.1',
    port: 0,
    settingsPath: desktopPaths.settingsPath,
    defaultDataRoot: desktopPaths.workspaceRoot,
    directoryChooser: true,
    sttRuntimeRoot: desktopPaths.sttRuntimeRoot,
    sttModelRoot: desktopPaths.sttModelRoot,
    ollamaBootstrap,
  });

  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 920,
    minHeight: 620,
    title: 'Lecture Copilot',
    icon,
    show: !smokeResultPath,
    backgroundColor: '#f8f8f5',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: desktopPaths.preload,
    },
  });
  await window.loadURL(runtime.url);
  if (smokeResultPath) {
    const healthResponse = await fetch(`${runtime.url}/api/health`);
    const health = await healthResponse.json();
    if (!healthResponse.ok || !health.ok) throw new Error(`Desktop health check failed with status ${healthResponse.status}`);
    const memory = await process.getProcessMemoryInfo();
    if (smokeAudioPath) await validateLiveAudio(runtime, smokeAudioPath, liveAudioEvidence);
    const serverUrl = runtime.url;
    await stopResources();
    const afterShutdown = await runtime.handler.runtimeSnapshot();
    if (smokeAudioPath) assertRuntimeIdle(afterShutdown);
    await writeSmokeResult({
      ok: true,
      stopped: true,
      afterShutdown,
      ...(smokeAudioPath ? { liveAudio: liveAudioEvidence } : {}),
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      execPath: process.execPath,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      serverUrl,
      runtimeTarget: desktopPaths.runtimeTarget,
      sttRuntimeRoot: desktopPaths.sttRuntimeRoot,
      sttModelRoot: desktopPaths.sttModelRoot,
      workspaceRoot: desktopPaths.workspaceRoot,
      memory,
      health,
      checkedAt: new Date().toISOString(),
    });
    runtime = null;
    window.destroy();
    app.quit();
    return;
  }
  if (process.env.LECTURE_COPILOT_RUNTIME_DEBUG === '1') {
    runtimeDiagnosticsTimer = setInterval(() => { void logRuntimeMemory(); }, 10_000);
    runtimeDiagnosticsTimer.unref?.();
    void logRuntimeMemory();
  }
}

ipcMain.handle('choose-workspace', chooseWorkspace);

app.whenReady().then(createWindow).catch(async (error) => {
  console.error('Unable to start Lecture Copilot:', error);
  await stopResources().catch((stopError) => console.error('Runtime shutdown failed:', stopError));
  await writeSmokeResult({
    ok: false,
    ...(smokeAudioPath ? { liveAudio: liveAudioEvidence } : {}),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    error: error.stack || error.message,
    checkedAt: new Date().toISOString(),
  }).catch((writeError) => console.error('Unable to write smoke-test result:', writeError));
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if ((!runtime && !ollamaBootstrap) || quitting) return;
  event.preventDefault();
  quitting = true;
  clearInterval(runtimeDiagnosticsTimer);
  stopResources()
    .catch((error) => console.error('Unable to stop local runtime:', error))
    .finally(() => app.quit());
});

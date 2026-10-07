import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer } from '../src/server.js';

const outputArgument = process.argv.find((value) => value.startsWith('--output='));
const output = path.resolve(outputArgument?.slice('--output='.length) || 'debug-artifacts/windows/server-smoke.json');
const workspace = path.join(path.dirname(output), '路径 with spaces', 'workspace');
const settingsPath = path.join(path.dirname(output), '路径 with spaces', 'settings.json');
const modelRoot = path.join(path.dirname(output), '路径 with spaces', 'models', 'whisper.cpp');
const runtimeRoot = path.resolve('runtime', 'stt', `${process.platform}-${process.platform === 'win32' ? 'x64' : process.arch}`);

async function save(value) {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

let runtime;
try {
  runtime = await startServer({
    host: '127.0.0.1',
    port: 0,
    settingsPath,
    defaultDataRoot: workspace,
    sttRuntimeRoot: runtimeRoot,
    sttModelRoot: modelRoot,
  });
  const [healthResponse, settingsResponse, pageResponse] = await Promise.all([
    fetch(`${runtime.url}/api/health`),
    fetch(`${runtime.url}/api/settings`),
    fetch(runtime.url),
  ]);
  const health = await healthResponse.json();
  const settings = await settingsResponse.json();
  const page = await pageResponse.text();
  if (!healthResponse.ok || health.ok !== true) throw new Error(`Health endpoint returned ${healthResponse.status}`);
  if (!settingsResponse.ok || settings.storagePath !== path.resolve(workspace)) throw new Error('Settings endpoint returned an unexpected workspace path');
  if (!pageResponse.ok || !page.includes('<title>Lecture Copilot</title>')) throw new Error('Web application root did not load');
  if (runtime.host !== '127.0.0.1' || runtime.port <= 0) throw new Error('Server did not bind to an ephemeral loopback port');
  if (health.sttRuntime?.binaryPath !== path.join(runtimeRoot, 'bin', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli')) {
    throw new Error('Health endpoint reported an unexpected Whisper executable path');
  }
  if (health.sttRuntime?.installRoot !== path.resolve(modelRoot)) throw new Error('Health endpoint reported an unexpected writable model path');
  const snapshot = await runtime.handler.runtimeSnapshot();
  const memory = process.memoryUsage();
  const result = {
    ok: true,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    serverUrl: runtime.url,
    host: runtime.host,
    port: runtime.port,
    workspace: runtime.dataRoot,
    settingsPath: runtime.settingsPath,
    sttRuntimeRoot: runtimeRoot,
    sttModelRoot: runtime.sttModelRoot,
    health,
    snapshot,
    memory,
    checkedAt: new Date().toISOString(),
  };
  const stoppedRuntime = runtime;
  await runtime.stop();
  runtime = null;
  if (stoppedRuntime.server.listening) throw new Error('Server still reports a listening socket after shutdown');
  result.stopped = true;
  await save(result);
  console.log(`Server smoke test passed at ${result.serverUrl}; result: ${output}`);
} catch (error) {
  await runtime?.stop().catch(() => {});
  await save({
    ok: false,
    platform: process.platform,
    arch: process.arch,
    error: error.stack || error.message,
    checkedAt: new Date().toISOString(),
  });
  console.error(error);
  process.exitCode = 1;
}

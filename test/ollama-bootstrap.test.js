import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OllamaBootstrap, runProcess } from '../src/ollama-bootstrap.js';
import { spawn } from 'node:child_process';

test('cancelling setup waits for its command to exit before releasing resources', async () => {
  const controller = new AbortController();
  let child;
  const running = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    signal: controller.signal,
    spawnImpl(command, args, options) {
      child = spawn(command, args, options);
      child.once('spawn', () => controller.abort());
      return child;
    },
  });
  await assert.rejects(running, { code: 'ABORT_ERR' });
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'cancelled command must already have exited');
});

test('bootstrap shutdown awaits its owned server and is shared by concurrent callers', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-ollama-shutdown-'));
  const bootstrap = new OllamaBootstrap({ userDataRoot: root });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  t.after(async () => {
    child.kill('SIGKILL');
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  bootstrap.serverProcess = child;
  const first = bootstrap.stop();
  assert.equal(bootstrap.stop(), first);
  await first;
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'owned server must already have exited');
});

test('a clean device installs, starts, and pulls Ollama automatically, then removes setup cache', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-clean-first-run-'));
  const cacheRoot = path.join(root, 'cache', 'ollama-bootstrap');
  await fs.mkdir(cacheRoot, { recursive: true });
  await fs.writeFile(path.join(cacheRoot, 'stale-download.tmp'), 'partial');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  let reachable = false;
  let models = [];
  const calls = [];
  const bootstrap = new OllamaBootstrap({
    userDataRoot: root,
    model: 'first-run:4b',
    operations: {
      async probe() {
        calls.push('probe');
        return { reachable, models: [...models] };
      },
      async locate() {
        calls.push('locate');
        return null;
      },
      async install({ onProgress }) {
        calls.push('install');
        onProgress({ status: 'downloading', progress: 50, downloadedBytes: 50, totalBytes: 100 });
        onProgress({ status: 'installing', progress: 100, downloadedBytes: 100, totalBytes: 100 });
        return '/clean/runtime/ollama';
      },
      async start(command) {
        calls.push(`start:${command}`);
        reachable = true;
      },
      async waitUntilReachable() {
        calls.push('wait');
        return { reachable: true, models: [] };
      },
      async pull(model, { onProgress }) {
        calls.push(`pull:${model}`);
        onProgress({ progress: 100, downloadedBytes: 200, totalBytes: 200 });
        models = [model];
      },
      async cleanup() {
        calls.push('cleanup');
        await fs.rm(cacheRoot, { recursive: true, force: true });
      },
    },
  });

  const first = bootstrap.ensureReady();
  assert.equal(bootstrap.ensureReady(), first, 'concurrent startup checks must share one setup run');
  const result = await first;
  assert.equal(result.status, 'ready');
  assert.equal(result.selectedModel, 'first-run:4b');
  assert.deepEqual(calls.filter((call) => ['install', 'wait'].includes(call) || call.startsWith('start:') || call.startsWith('pull:')), [
    'install',
    'start:/clean/runtime/ollama',
    'wait',
    'pull:first-run:4b',
  ]);
  assert.equal(calls.at(-1), 'cleanup');
  await assert.rejects(() => fs.access(cacheRoot), (error) => error.code === 'ENOENT');
});

test('an existing Ollama model is reused without installation or download', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-existing-ollama-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const bootstrap = new OllamaBootstrap({
    userDataRoot: root,
    model: 'preferred:4b',
    operations: {
      async probe() { return { reachable: true, models: ['already-installed:3b'] }; },
      async locate() { calls.push('locate'); },
      async install() { calls.push('install'); },
      async start() { calls.push('start'); },
      async waitUntilReachable() { calls.push('wait'); },
      async pull() { calls.push('pull'); },
      async cleanup() { calls.push('cleanup'); },
    },
  });
  const result = await bootstrap.ensureReady();
  assert.equal(result.status, 'ready');
  assert.equal(result.selectedModel, 'already-installed:3b');
  assert.deepEqual(calls, ['cleanup']);
});

test('desktop bootstrap installs every explicitly required model before reporting ready', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-required-ollama-models-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const models = ['documents:4b'];
  const pulled = [];
  const bootstrap = new OllamaBootstrap({
    userDataRoot: root,
    model: 'documents:4b',
    models: ['documents:4b', 'translation:1.5b'],
    operations: {
      async probe() { return { reachable: true, models: [...models] }; },
      async locate() { return '/existing/ollama'; },
      async pull(model, { onProgress }) {
        pulled.push(model);
        onProgress({ progress: 100, downloadedBytes: 100, totalBytes: 100 });
        models.push(model);
      },
      async cleanup() {},
    },
  });

  const result = await bootstrap.ensureReady();

  assert.equal(result.status, 'ready');
  assert.equal(result.model, 'documents:4b');
  assert.deepEqual(result.requiredModels, ['documents:4b', 'translation:1.5b']);
  assert.deepEqual(pulled, ['translation:1.5b']);
});

test('first-run installation failures remain retryable and still clear partial downloads', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-failed-ollama-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let cleanupCalls = 0;
  const bootstrap = new OllamaBootstrap({
    userDataRoot: root,
    operations: {
      async probe() { return { reachable: false, models: [] }; },
      async locate() { return null; },
      async install() { throw new Error('network unavailable'); },
      async cleanup() { cleanupCalls += 1; },
    },
  });
  const first = await bootstrap.ensureReady();
  assert.equal(first.status, 'failed');
  assert.match(first.error, /network unavailable/);
  assert.equal(cleanupCalls, 1);
  const second = await bootstrap.ensureReady();
  assert.equal(second.status, 'failed');
  assert.equal(cleanupCalls, 2, 'a failed setup can be started again');
});

test('Windows first run downloads the official installer, verifies it, and installs silently per user', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-windows-ollama-'));
  const userDataRoot = path.join(root, 'Roaming App Data', 'local lecture copilot');
  const localAppData = path.join(root, 'Local AppData');
  const installedCommand = path.join(localAppData, 'Programs', 'Ollama', 'ollama.exe');
  const processCalls = [];
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    processCalls.push({ command, args, options });
    queueMicrotask(async () => {
      if (String(command).endsWith('OllamaSetup.exe')) {
        await fs.mkdir(path.dirname(installedCommand), { recursive: true });
        await fs.writeFile(installedCommand, 'mock signed executable');
        await fs.chmod(installedCommand, 0o755);
      }
      child.emit('exit', 0, null);
    });
    return child;
  };
  const bootstrap = new OllamaBootstrap({
    userDataRoot,
    localAppData,
    platform: 'win32',
    spawnImpl,
    fetchImpl: async (url) => {
      assert.equal(url, 'https://ollama.com/download/OllamaSetup.exe');
      return new Response('official installer bytes', { status: 200, headers: { 'content-length': '24' } });
    },
  });
  const command = await bootstrap.installRuntime({ signal: new AbortController().signal, onProgress() {} });
  assert.equal(command, installedCommand);
  assert.equal(processCalls[0].command, 'powershell.exe');
  assert.match(processCalls[0].args.join(' '), /Get-AuthenticodeSignature/);
  assert.doesNotMatch(processCalls[0].args.join(' '), /\$args/);
  assert.equal(processCalls[0].args.length, 4, 'the installer path must not be appended after -Command');
  assert.equal(processCalls[0].options.env.LOCAL_LECTURE_OLLAMA_INSTALLER_PATH, path.join(bootstrap.cacheRoot, 'OllamaSetup.exe'));
  assert.match(processCalls[0].options.env.LOCAL_LECTURE_OLLAMA_INSTALLER_PATH, /Roaming App Data/);
  assert.deepEqual(processCalls[1].args, ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES', '/SP-']);
  assert.equal(await fs.access(path.join(localAppData, 'Ollama', 'upgraded')).then(() => true), true);
  await bootstrap.cleanupCache();
  await assert.rejects(() => fs.access(bootstrap.cacheRoot), (error) => error.code === 'ENOENT');
});

test('Windows clean-device flow ignores erased model caches and reaches ready after a fresh pull', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-windows-clean-device-'));
  const userDataRoot = path.join(root, 'Roaming App Data', 'local lecture copilot');
  const localAppData = path.join(root, 'Local AppData');
  const modelRoot = path.join(root, 'isolated-ollama-models');
  const installedCommand = path.join(localAppData, 'Programs', 'Ollama', 'ollama.exe');
  const requestedModel = 'clean-windows:4b';
  const processCalls = [];
  let reachable = false;
  let installed = false;
  let modelNames = [];
  let verifiedEmptyBeforePull = false;

  // Start with a stale model, then erase the entire isolated model store just
  // before setup. This makes it impossible for the test to reuse a prior pull.
  await fs.mkdir(path.join(modelRoot, 'manifests'), { recursive: true });
  await fs.writeFile(path.join(modelRoot, 'manifests', 'stale-model'), 'stale');
  await fs.rm(modelRoot, { recursive: true, force: true });
  await fs.mkdir(modelRoot, { recursive: true });
  assert.deepEqual(await fs.readdir(modelRoot), []);

  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => queueMicrotask(() => child.emit('exit', 0, null));
    processCalls.push({ command, args, options });
    queueMicrotask(async () => {
      try {
        if (command === 'ollama.exe' && !installed) {
          child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }));
          return;
        }
        if (command === 'powershell.exe') {
          assert.doesNotMatch(args.join(' '), /\$args/);
          assert.equal(args.length, 4);
          await fs.access(options.env.LOCAL_LECTURE_OLLAMA_INSTALLER_PATH);
          child.emit('exit', 0, null);
          return;
        }
        if (String(command).endsWith('OllamaSetup.exe')) {
          await fs.mkdir(path.dirname(installedCommand), { recursive: true });
          await fs.writeFile(installedCommand, 'mock signed executable');
          await fs.chmod(installedCommand, 0o755);
          installed = true;
          child.emit('exit', 0, null);
          return;
        }
        if (command === installedCommand && args[0] === 'serve') {
          assert.equal(options.env.OLLAMA_MODELS, modelRoot);
          assert.equal(options.env.OLLAMA_HOST, '127.0.0.1:54321');
          reachable = true;
          child.emit('spawn');
          return;
        }
        child.emit('exit', 0, null);
      } catch (error) {
        child.emit('error', error);
      }
    });
    return child;
  };

  const bootstrap = new OllamaBootstrap({
    userDataRoot,
    localAppData,
    platform: 'win32',
    model: requestedModel,
    baseUrl: 'http://127.0.0.1:54321',
    environment: { OLLAMA_MODELS: modelRoot },
    spawnImpl,
    fetchImpl: async (url, options = {}) => {
      if (url === 'https://ollama.com/download/OllamaSetup.exe') {
        return new Response('official installer bytes', { status: 200, headers: { 'content-length': '24' } });
      }
      if (url === 'http://127.0.0.1:54321/api/tags') {
        if (!reachable) throw new Error('connection refused');
        return Response.json({ models: modelNames.map((name) => ({ name })) });
      }
      if (url === 'http://127.0.0.1:54321/api/pull') {
        assert.equal(JSON.parse(options.body).model, requestedModel);
        verifiedEmptyBeforePull = (await fs.readdir(modelRoot)).length === 0;
        await fs.mkdir(path.join(modelRoot, 'blobs'), { recursive: true });
        await fs.writeFile(path.join(modelRoot, 'blobs', 'fresh-model'), requestedModel);
        modelNames = [requestedModel];
        return new Response('{"status":"pulling","completed":24,"total":24}\n{"status":"success"}\n', { status: 200 });
      }
      return new Response('unexpected request', { status: 500 });
    },
  });
  t.after(async () => {
    await bootstrap.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  const result = await bootstrap.ensureReady();
  assert.equal(result.status, 'ready');
  assert.equal(result.selectedModel, requestedModel);
  assert.equal(verifiedEmptyBeforePull, true, 'the model cache must still be empty when the fresh pull begins');
  assert.equal(await fs.readFile(path.join(modelRoot, 'blobs', 'fresh-model'), 'utf8'), requestedModel);
  assert.equal(processCalls.some((call) => call.command === 'powershell.exe'), true);
  assert.equal(processCalls.some((call) => call.command === installedCommand && call.args[0] === 'serve'), true);
  await assert.rejects(() => fs.access(bootstrap.cacheRoot), (error) => error.code === 'ENOENT');
});

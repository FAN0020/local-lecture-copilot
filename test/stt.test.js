import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_WHISPER_CPU_THREADS,
  MAX_WHISPER_OUTPUT_BYTES,
  MAX_WHISPER_CPU_THREADS,
  WhisperProvider,
  resolveWhisperBackendPolicy,
  runWhisperCommand,
} from '../src/providers/stt.js';

const TINY_CONTENT = Buffer.from('model');
const TEST_REGISTRY = [{
  id: 'tiny',
  label: 'Tiny',
  description: 'Test Tiny',
  filename: 'ggml-tiny.bin',
  bytes: TINY_CONTENT.length,
  sha256: crypto.createHash('sha256').update(TINY_CONTENT).digest('hex'),
  url: 'https://example.invalid/ggml-tiny.bin',
  bundled: true,
}];

test('managed Whisper reports missing runtime and installed model state explicitly', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-stt-status-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new WhisperProvider({ runtimeRoot: root, registry: TEST_REGISTRY });
  let status = await provider.status();
  assert.equal(status.ready, false);
  assert.match(status.message, /runtime is missing/i);

  await fs.mkdir(path.join(root, 'bin'), { recursive: true });
  await fs.mkdir(path.join(root, 'models'), { recursive: true });
  await fs.writeFile(path.join(root, 'bin', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'), 'runtime');
  if (process.platform !== 'win32') await fs.chmod(path.join(root, 'bin', 'whisper-cli'), 0o755);
  await fs.writeFile(path.join(root, 'models', 'ggml-tiny.bin'), TINY_CONTENT);
  status = await provider.status();
  assert.equal(status.ready, true);
  assert.deepEqual(status.installedModels, ['tiny']);
  assert.equal(status.modelStates.tiny.source, 'bundled');
  assert.equal(path.isAbsolute(status.binaryPath), true);
});

test('managed Whisper passes safe paths, fixed languages, and additive English lecture context', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), '讲座 workspace '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime data');
  const binary = path.join(runtimeRoot, 'bin', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
  const model = path.join(runtimeRoot, 'models', 'ggml-tiny.bin');
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.mkdir(path.dirname(model), { recursive: true });
  await fs.writeFile(binary, 'runtime');
  await fs.writeFile(model, TINY_CONTENT);
  if (process.platform !== 'win32') await fs.chmod(binary, 0o755);
  const audio = path.join(root, '录音 sample.wav');
  await fs.writeFile(audio, 'audio');
  const invocations = [];
  const provider = new WhisperProvider({
    runtimeRoot,
    registry: TEST_REGISTRY,
    runner: async (command, args) => {
      invocations.push({ command, args });
      const output = args[args.indexOf('--output-file') + 1];
      await fs.writeFile(`${output}.json`, JSON.stringify({ result: { language: 'en' }, transcription: [{ offsets: { from: 0, to: 1000 }, text: 'safe path' }] }));
    },
  });
  const controller = new AbortController();
  const result = await provider.transcribe(audio, { model: 'tiny', language: 'en', prompt: 'prior lecture context', signal: controller.signal });
  const invoked = invocations[0];
  assert.equal(result.content, 'safe path');
  assert.equal(invoked.command, binary);
  assert.equal(invoked.args[invoked.args.indexOf('--file') + 1], path.resolve(audio));
  assert.equal(invoked.args[invoked.args.indexOf('--model') + 1], model);
  const prompt = invoked.args[invoked.args.indexOf('--prompt') + 1];
  assert.match(prompt, /prior lecture context/i);
  assert.match(prompt, /English university lecture/i);
  assert.equal(invoked.args[invoked.args.indexOf('--language') + 1], 'en');
  assert.equal(invoked.args[invoked.args.indexOf('--threads') + 1], String(DEFAULT_WHISPER_CPU_THREADS));
  assert.equal(invoked.args.includes('--output-json'), true);
  assert.equal(invoked.args.includes('--output-json-full'), false);
  assert.equal(invoked.args.includes('--no-gpu'), process.platform === 'darwin');

  await provider.transcribe(audio, { model: 'tiny', language: 'zh' });
  await provider.transcribe(audio, { model: 'tiny', language: 'ms' });
  await provider.transcribe(audio, { model: 'tiny', language: 'auto' });
  assert.equal(invocations[1].args[invocations[1].args.indexOf('--language') + 1], 'zh');
  assert.equal(invocations[2].args[invocations[2].args.indexOf('--language') + 1], 'ms');
  assert.equal(invocations[3].args.includes('--language'), false);
  assert.equal(invocations[1].args.includes('--prompt'), false);
  assert.equal(invocations[2].args.includes('--prompt'), false);
  assert.equal(invocations[3].args.includes('--prompt'), false);
});

test('managed Whisper reports a decode failure when the native process exits without JSON output', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-stt-decode-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const binary = path.join(root, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
  await fs.writeFile(binary, 'runtime');
  if (process.platform !== 'win32') await fs.chmod(binary, 0o755);
  const provider = new WhisperProvider({
    binary,
    modelManager: { async modelStatus() { return { state: 'ready', path: path.join(root, 'ggml-base.bin') }; } },
    runner: async () => ({ stdout: '', stderr: 'read_audio_data: failed to read audio data' }),
  });
  await assert.rejects(provider.transcribe(path.join(root, 'lecture.m4a'), { model: 'base' }), (error) => {
    assert.equal(error.code, 'STT_AUDIO_DECODE_FAILED');
    assert.equal(error.status, 422);
    assert.match(error.message, /failed to read audio data/i);
    return true;
  });
  assert.equal(provider.snapshot().tempDirs, 0);
});

test('macOS backend policy deterministically uses bounded CPU while other platforms retain their accelerator default', () => {
  assert.equal(resolveWhisperBackendPolicy().threads, 2);
  assert.equal(resolveWhisperBackendPolicy({ cpuThreads: 1 }).threads, 1);
  const first = resolveWhisperBackendPolicy({ platform: 'darwin', cpuThreads: 999 });
  const second = resolveWhisperBackendPolicy({ platform: 'darwin', cpuThreads: 999 });
  assert.deepEqual(first, second);
  assert.equal(first.backend, 'cpu');
  assert.equal(first.threads, MAX_WHISPER_CPU_THREADS);
  assert.deepEqual(first.args, ['--threads', String(MAX_WHISPER_CPU_THREADS), '--no-gpu']);
  assert.match(first.reason, /Metal model loading is not reliable/i);

  for (const platform of ['win32', 'linux']) {
    const policy = resolveWhisperBackendPolicy({ platform, cpuThreads: 999 });
    assert.equal(policy.backend, 'platform-default');
    assert.equal(policy.threads, MAX_WHISPER_CPU_THREADS);
    assert.equal(policy.args.includes('--no-gpu'), false);
  }
});

test('live drafts use one decoding candidate with uncertainty fallback while manual revision retains full decoding', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-stt-decoder-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const invocations = [];
  const modelRequests = [];
  const provider = new WhisperProvider({
    binary: process.execPath,
    modelManager: {
      async modelStatus(model) {
        modelRequests.push(model);
        return { state: 'ready', path: path.join(root, `ggml-${model}.bin`) };
      },
      async status() { assert.fail('A chunk must not rediscover unrelated models'); },
    },
    runner: async (_command, args) => {
      invocations.push(args);
      const output = args[args.indexOf('--output-file') + 1];
      await fs.writeFile(`${output}.json`, JSON.stringify({
        result: { language: 'en' },
        transcription: [{ offsets: { from: 0, to: 1500 }, text: 'Efficient draft.' }],
      }));
    },
  });
  for (const stage of ['provisional', 'revised', 'highQuality']) {
    const result = await provider.transcribe(path.join(root, 'audio.wav'), { model: 'base', language: 'en', stage });
    assert.deepEqual(result.segments, [{ start: 0, end: 1.5, text: 'Efficient draft.' }]);
  }
  assert.deepEqual(modelRequests, ['base', 'base', 'base']);
  assert.equal(invocations[0][invocations[0].indexOf('--beam-size') + 1], '1');
  assert.equal(invocations[0][invocations[0].indexOf('--best-of') + 1], '1');
  assert.equal(invocations[0].includes('--no-fallback'), false);
  for (const args of invocations.slice(1)) {
    assert.equal(args.includes('--beam-size'), false);
    assert.equal(args.includes('--best-of'), false);
    assert.equal(args.includes('--no-fallback'), false);
  }
});

test('provider shutdown during model discovery cannot launch late inference or retain work', async () => {
  let releaseModel;
  const modelReady = new Promise((resolve) => { releaseModel = resolve; });
  const provider = new WhisperProvider({
    binary: process.execPath,
    modelManager: { modelStatus: () => modelReady },
    runner: async () => assert.fail('Cancelled discovery must never spawn Whisper'),
  });
  const transcription = provider.transcribe('/unused-audio.wav', { model: 'base' });
  const rejected = assert.rejects(transcription, (error) => error.code === 'ABORT_ERR');
  assert.equal(provider.snapshot().transcriptions, 1);
  const closed = provider.close();
  releaseModel({ state: 'ready', path: '/unused-model.bin' });
  await Promise.all([closed, rejected]);
  assert.equal(provider.snapshot().transcriptions, 0);
  assert.equal(provider.snapshot().tempDirs, 0);
});

test('already cancelled transcription skips model discovery and process startup', async () => {
  const controller = new AbortController();
  controller.abort();
  const provider = new WhisperProvider({
    binary: process.execPath,
    modelManager: { modelStatus: () => assert.fail('Cancelled request must skip discovery') },
    runner: async () => assert.fail('Cancelled request must skip inference'),
  });
  await assert.rejects(provider.transcribe('/unused-audio.wav', { signal: controller.signal }), (error) => error.code === 'ABORT_ERR');
  assert.equal(provider.snapshot().transcriptions, 0);
});

test('Whisper requests below-normal priority and still works when a sandbox denies it', async (t) => {
  const requests = [];
  t.mock.method(os, 'setPriority', (pid, priority) => {
    requests.push({ pid, priority });
    throw Object.assign(new Error('Sandbox denies priority changes'), { code: 'EPERM' });
  });
  const result = await runWhisperCommand(process.execPath, ['-e', "process.stdout.write('complete')"]);
  assert.equal(result.stdout, 'complete');
  assert.equal(requests.length, 1);
  assert.ok(requests[0].pid > 0);
  assert.equal(requests[0].priority, os.constants.priority.PRIORITY_BELOW_NORMAL);
});

test('aborted Whisper commands terminate before the runner rejects', { skip: process.platform === 'win32' }, async () => {
  const controller = new AbortController();
  let reportReady;
  const ready = new Promise((resolve) => { reportReady = resolve; });
  const running = runWhisperCommand(process.execPath, [
    '-e',
    "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
  ], {
    signal: controller.signal,
    abortGraceMs: 50,
    onProgress(output) { if (output.includes('ready')) reportReady(); },
  });
  await ready;
  controller.abort();
  await assert.rejects(running, (error) => error.code === 'ABORT_ERR');
});

test('Whisper command output is kept as a bounded diagnostic tail', async () => {
  const result = await runWhisperCommand(process.execPath, ['-e', "process.stderr.write('x'.repeat(1024 * 1024))"]);
  assert.ok(result.stderr.length <= MAX_WHISPER_OUTPUT_BYTES);
  assert.ok(result.stdout.length <= MAX_WHISPER_OUTPUT_BYTES);
});

test('provider shutdown kills active Whisper and releases process and temporary-directory tracking', { skip: process.platform === 'win32' }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-stt-shutdown-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const modelRoot = path.join(root, 'models');
  await fs.mkdir(modelRoot, { recursive: true });
  await fs.writeFile(path.join(modelRoot, 'ggml-tiny.bin'), TINY_CONTENT);
  const audio = path.join(root, 'audio.wav');
  await fs.writeFile(audio, 'audio');
  const provider = new WhisperProvider({
    binary: process.execPath,
    bundledModelRoot: modelRoot,
    modelRoot,
    registry: TEST_REGISTRY,
    runner: (_command, _args, options) => runWhisperCommand(process.execPath, [
      '-e',
      "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
    ], { ...options, abortGraceMs: 30 }),
  });
  const transcription = provider.transcribe(audio, { model: 'tiny', language: 'en' });
  const rejected = assert.rejects(transcription, (error) => error.code === 'ABORT_ERR');
  const startedAt = Date.now();
  while (!provider.snapshot().processes && Date.now() - startedAt < 1000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(provider.snapshot().processes, 1);
  await provider.close();
  await rejected;
  assert.deepEqual(provider.snapshot(), { processes: 0, transcriptions: 0, tempDirs: 0, backend: process.platform === 'darwin' ? 'cpu' : 'platform-default' });
});

test('managed Whisper removes automatic thanks-for-watching hallucinations from silence', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-stt-hallucination-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const binary = path.join(root, 'bin', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
  const model = path.join(root, 'models', 'ggml-tiny.bin');
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.mkdir(path.dirname(model), { recursive: true });
  await fs.writeFile(binary, 'runtime');
  await fs.writeFile(model, TINY_CONTENT);
  if (process.platform !== 'win32') await fs.chmod(binary, 0o755);
  const speech = path.join(root, 'speech.wav');
  const silence = path.join(root, 'silence.wav');
  await fs.writeFile(speech, 'audio');
  await fs.writeFile(silence, 'audio');
  const provider = new WhisperProvider({
    runtimeRoot: root,
    registry: TEST_REGISTRY,
    runner: async (_command, args) => {
      const input = args[args.indexOf('--file') + 1];
      const output = args[args.indexOf('--output-file') + 1];
      const transcription = input === silence
        ? [{ offsets: { from: 0, to: 1000 }, text: 'Thanks for watching.' }]
        : [
            { offsets: { from: 0, to: 1000 }, text: 'The lecture continues.' },
            { offsets: { from: 1000, to: 2000 }, text: 'Thank you for watching!' },
          ];
      await fs.writeFile(`${output}.json`, JSON.stringify({ result: { language: 'en' }, transcription }));
    },
  });

  const result = await provider.transcribe(speech, { model: 'tiny', language: 'en' });
  assert.equal(result.content, 'The lecture continues.');
  assert.deepEqual(result.segments.map((segment) => segment.text), ['The lecture continues.']);
  await assert.rejects(
    provider.transcribe(silence, { model: 'tiny', language: 'en' }),
    (error) => error.code === 'NO_SPEECH',
  );
});

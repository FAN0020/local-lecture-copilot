import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../src/server.js';

function argument(name, fallback = '') {
  const value = process.argv.find((item) => item.startsWith(`--${name}=`));
  return value ? value.slice(name.length + 3) : fallback;
}

const rawAudioPath = argument('audio', process.env.LECTURE_COPILOT_LIVE_AUDIO || '');
const audioPath = rawAudioPath ? path.resolve(rawAudioPath) : '';
const outputPath = path.resolve(argument('output', 'debug-artifacts/windows/live-dictation.json'));
const requestedChunks = Math.max(1, Math.min(8, Number(argument('chunks', '3')) || 3));
const timeoutMs = Math.max(30_000, Number(argument('timeout-ms', process.env.LECTURE_COPILOT_LIVE_TIMEOUT_MS || 300_000)) || 300_000);

function parseWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`Live audio is not a RIFF/WAVE file: ${audioPath}`);
  }
  let format = null;
  let data = null;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) throw new Error('Live WAV contains a truncated chunk.');
    if (id === 'fmt ') format = buffer.subarray(start, end);
    if (id === 'data') data = buffer.subarray(start, end);
    offset = end + (size % 2);
  }
  if (!format || !data || format.length < 16) throw new Error('Live WAV must contain fmt and data chunks.');
  const audioFormat = format.readUInt16LE(0);
  const channels = format.readUInt16LE(2);
  const sampleRate = format.readUInt32LE(4);
  const blockAlign = format.readUInt16LE(12);
  const bitsPerSample = format.readUInt16LE(14);
  if (audioFormat !== 1 || channels !== 1 || sampleRate !== 16_000 || bitsPerSample !== 16 || blockAlign !== 2) {
    throw new Error('Live audio must be mono, 16-bit PCM at 16 kHz so recorded chunks can be combined losslessly.');
  }
  if (!data.length) throw new Error('Live audio contains no samples.');
  return { format, data, channels, sampleRate, bitsPerSample, blockAlign };
}

function makeWav(format, data) {
  const buffer = Buffer.alloc(12 + 8 + format.length + 8 + data.length + (data.length % 2));
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(format.length, 16);
  format.copy(buffer, 20);
  const dataOffset = 20 + format.length;
  buffer.write('data', dataOffset);
  buffer.writeUInt32LE(data.length, dataOffset + 4);
  data.copy(buffer, dataOffset + 8);
  return buffer;
}

function splitWav(buffer, requested) {
  const wav = parseWav(buffer);
  const frames = wav.data.length / wav.blockAlign;
  const count = Math.max(1, Math.min(requested, Math.ceil(frames / wav.sampleRate / 2)));
  const framesPerChunk = Math.max(1, Math.ceil(frames / count));
  const chunks = [];
  for (let index = 0; index < count; index += 1) {
    const startFrame = index * framesPerChunk;
    const endFrame = Math.min(frames, (index + 1) * framesPerChunk);
    if (endFrame <= startFrame) continue;
    const start = startFrame * wav.blockAlign;
    const end = endFrame * wav.blockAlign;
    chunks.push({
      buffer: makeWav(wav.format, wav.data.subarray(start, end)),
      startMs: Math.round((startFrame / wav.sampleRate) * 1000),
      endMs: Math.round((endFrame / wav.sampleRate) * 1000),
    });
  }
  return { wav, chunks };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(label, read, predicate, deadline) {
  let latest;
  while (Date.now() < deadline) {
    latest = await read();
    if (predicate(latest)) return latest;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}. Last state: ${JSON.stringify(latest)}`);
}

function stageComplete(session, stage) {
  return (session.transcriptSegments || []).some((segment) => Boolean(segment.versions?.[stage]));
}

async function save(value) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

let runtime;
let runRoot;
try {
  if (!audioPath) throw new Error('Set LECTURE_COPILOT_LIVE_AUDIO or pass --audio=PATH to a real speech WAV.');
  const input = await fs.readFile(audioPath);
  const { wav, chunks } = splitWav(input, requestedChunks);
  const memoryBefore = process.memoryUsage();
  const runNonce = `${Date.now()}-${process.pid}`;
  runRoot = path.join(path.dirname(outputPath), `live-dictation-${runNonce}`);
  runtime = await startServer({
    host: '127.0.0.1',
    port: 0,
    settingsPath: path.join(runRoot, 'settings.json'),
    defaultDataRoot: path.join(runRoot, 'workspace'),
    sttRuntimeRoot: path.resolve('runtime', 'stt', `${process.platform}-${process.platform === 'win32' ? 'x64' : process.arch}`),
    sttModelRoot: path.join(runRoot, 'models'),
    llm: {
      async listModels() { return []; },
      async runningModels() { return []; },
      async generate() { throw Object.assign(new Error('Ollama is intentionally disabled for the Whisper live smoke test.'), { code: 'OLLAMA_NOT_READY', status: 503 }); },
    },
    runtimeDebug: true,
  });
  const request = async (endpoint, options = {}) => {
    const response = await fetch(`${runtime.url}${endpoint}`, options);
    const type = response.headers.get('content-type') || '';
    const body = type.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) throw new Error(`${endpoint} returned ${response.status}: ${body?.error || body}`);
    return body;
  };
  const health = await request('/api/health');
  if (!health.sttReady) throw new Error(`Managed Whisper is not ready: ${health.sttRuntime?.message || 'unknown error'}`);
  // Detect missing native libraries before waiting for an ASR stage to finish.
  execFileSync(health.sttRuntime.binaryPath, ['--help'], { timeout: 15_000, stdio: 'pipe' });
  const session = await request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Native live dictation smoke', language: 'en' }),
  });
  const started = await request(`/api/sessions/${encodeURIComponent(session.id)}/dictation/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language: 'en' }),
  });
  if (!started.stagedAsr) throw new Error('Dictation fell back to legacy ASR; staged Version C is not active.');
  const progress = [];
  const snapshotBefore = await runtime.handler.runtimeSnapshot();
  const readSession = () => request(`/api/sessions/${encodeURIComponent(session.id)}`);
  for (const [sequence, chunk] of chunks.entries()) {
    const acknowledged = await request(`/api/sessions/${encodeURIComponent(session.id)}/dictation/chunks?sequence=${sequence}&startMs=${chunk.startMs}&endMs=${chunk.endMs}&speech=1&boundary=speech-boundary`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: chunk.buffer,
    });
    progress.push({ sequence, at: new Date().toISOString(), raw: acknowledged.artifacts?.rawTranscript?.content || '', asr: acknowledged.asr });
    if (sequence === 0) {
      await waitFor('provisional live transcript', readSession, (current) => stageComplete(current, 'provisional'), Date.now() + timeoutMs);
      const provisional = await readSession();
      progress.push({ sequence, stage: 'provisional', at: new Date().toISOString(), raw: provisional.artifacts?.rawTranscript?.content || '', asr: provisional.asr });
    }
  }
  const finalized = await request(`/api/sessions/${encodeURIComponent(session.id)}/dictation/finalize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const beforeRequestedRevision = await readSession();
  if (stageComplete(beforeRequestedRevision, 'revised')) {
    throw new Error('Whisper revision ran before the explicit Improve transcript request.');
  }
  // Whisper revision is deliberately deferred until the user chooses Improve transcript.
  await request(`/api/sessions/${encodeURIComponent(session.id)}/asr/revise`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const deadline = Date.now() + timeoutMs;
  await waitFor('user-requested revised transcript', readSession, (current) => stageComplete(current, 'revised') && Boolean(current.artifacts?.rawTranscript?.content), deadline);
  await runtime.handler.idle();
  const afterRevision = await readSession();
  progress.push({ stage: 'revised', at: new Date().toISOString(), raw: afterRevision.artifacts?.rawTranscript?.content || '', asr: afterRevision.asr });
  const snapshotAfter = await waitFor('background queue cleanup', () => runtime.handler.runtimeSnapshot(), (snapshot) => (
    snapshot.whisper.processes === 0
      && snapshot.whisper.tempDirs === 0
      && snapshot.whisper.queued === 0
      && snapshot.whisper.active === 0
      && snapshot.rawTranslationJobs === 0
      && snapshot.llm.active === 0
  ), deadline);
  if (!afterRevision.artifacts?.rawTranscript?.content) throw new Error('Whisper completed but Raw transcript is empty.');
  if (snapshotAfter.whisper.processes !== 0 || snapshotAfter.whisper.tempDirs !== 0 || snapshotAfter.whisper.queued !== 0 || snapshotAfter.whisper.active !== 0) {
    throw new Error(`Whisper resources were retained after finalization: ${JSON.stringify(snapshotAfter.whisper)}`);
  }
  await save({
    ok: true,
    platform: process.platform,
    arch: process.arch,
    audio: { path: audioPath, bytes: input.length, sampleRate: wav.sampleRate, chunks: chunks.length },
    serverUrl: runtime.url,
    sessionId: session.id,
    stagedAsr: started.stagedAsr,
    asrModels: started.asrModels,
    progress,
    transcript: {
      provisional: progress.find((item) => item.stage === 'provisional')?.raw || '',
      revised: afterRevision.artifacts.rawTranscript.content,
      finalized: finalized.dictation?.status,
    },
    snapshots: { before: snapshotBefore, after: snapshotAfter },
    memory: { before: memoryBefore, after: process.memoryUsage() },
    checkedAt: new Date().toISOString(),
  });
  console.log(`Live dictation smoke test passed; result: ${outputPath}`);
} catch (error) {
  await save({ ok: false, platform: process.platform, arch: process.arch, audio: audioPath || null, error: error.stack || error.message, checkedAt: new Date().toISOString() });
  console.error(error);
  process.exitCode = 1;
} finally {
  await runtime?.stop().catch(() => {});
  if (runRoot) await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
}

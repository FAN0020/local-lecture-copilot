import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { combinePcmWav } from '../src/audio.js';
import { CORRECTION_REVISION } from '../src/conservative-correction.js';
import { retrieveCorrectionEvidence } from '../src/conservative-retrieval.js';

export const SPEECH_FIXTURE = Object.freeze({
  url: 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/371b5a7561823ab2bb32142d2751e35e7534727b/samples/jfk.wav',
  sha256: '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e',
  description: 'John F. Kennedy inaugural address excerpt, real recorded speech from whisper.cpp samples/jfk.wav',
});
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tempDirectories = async () => (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith('lecture-copilot-stt-'));

export function assertRuntimeIdle(snapshot) {
  for (const key of ['activeLocks', 'derivedJobs', 'recoveryJobs', 'revisionJobs', 'rawTranslationJobs', 'liveTranslationJobs']) {
    assert.equal(snapshot[key], 0, `${key} must drain`);
  }
  for (const key of ['active', 'queued', 'processes', 'transcriptions', 'tempDirs']) {
    assert.equal(snapshot.whisper[key], 0, `Whisper ${key} must drain`);
  }
  assert.equal(snapshot.llm.active, 0);
  assert.equal(snapshot.llm.queued, 0);
}

/** Exercise the real HTTP dictation API inside the actual Electron process. */
export async function validateLiveAudio(runtime, audioPath, evidence = {}) {
  Object.assign(evidence, { ok: false, physicalMicrophoneTested: false, fixture: SPEECH_FIXTURE, pipelineRevision: CORRECTION_REVISION });
  const original = await fs.readFile(audioPath);
  evidence.inputSha256 = hash(original);
  assert.equal(evidence.inputSha256, SPEECH_FIXTURE.sha256, 'Real-speech fixture must match the pinned recording');
  const wav = combinePcmWav([original]);
  const durationMs = (wav.length - 44) / wav.readUInt32LE(28) * 1000;
  evidence.durationMs = durationMs;
  const priorTemps = new Set(await tempDirectories());
  async function request(endpoint, { method = 'GET', json, body, headers = {}, expected = 200 } = {}) {
    const response = await fetch(`${runtime.url}${endpoint}`, {
      method, headers: json === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: json === undefined ? body : JSON.stringify(json), signal: AbortSignal.timeout(180_000),
    });
    const data = await response.json();
    assert.equal(response.status, expected, `${endpoint}: ${JSON.stringify(data)}`);
    return data;
  }
  const health = await request('/api/health');
  evidence.health = health;
  assert.equal(health.sttReady, true);
  assert.deepEqual(health.sttRuntime.installedModels, ['base']);
  assert.equal(health.asrPipeline.enabled, true);
  assert.equal(health.asrPipeline.revisionSource, 'rawTranscript');
  assert.equal(health.ollamaReady, false, 'This scenario requires unavailable Ollama');
  const session = await request('/api/sessions', { method: 'POST', json: { title: 'Native real-speech validation', language: 'en', targetLanguage: 'Chinese' }, expected: 201 });
  evidence.sessionId = session.id;
  const endpoint = `/api/sessions/${session.id}`;
  await request(`${endpoint}/dictation/start`, { method: 'POST', json: { model: 'base', language: 'en' }, expected: 201 });
  await request(`${endpoint}/live-translation`, { method: 'POST', json: { enabled: true } });
  await request(`${endpoint}/dictation/chunks?sequence=0&startMs=0&endMs=${durationMs}&speech=1&boundary=speech-boundary`, {
    method: 'POST', body: wav, headers: { 'content-type': 'audio/wav' },
  });
  await runtime.handler.idle();
  let current = await runtime.store.get(session.id);
  evidence.versions = current.transcriptSegments.map(({ id, stages, versions }) => ({ id, stages, versions }));
  assert.equal(evidence.versions.length, 1);
  for (const stage of ['provisional']) {
    const version = evidence.versions[0].versions[stage];
    assert.equal(version?.stage, stage);
    assert.equal(version.model, 'base');
    assert.equal(version.provider, 'whisper.cpp');
    assert.match(version.content, /country/iu, `${stage} must contain recognized speech`);
    assert.match(version.content, /ask/iu);
    assert.equal(evidence.versions[0].stages[stage].status, 'complete');
  }
  const failedAttempts = (await runtime.handler.runtimeSnapshot()).llm.lifecycle.failed;
  evidence.translationBeforeRetryTriggers = current.artifacts.rawTranslation;
  assert.ok(failedAttempts > 0, 'Live translation must attempt the unavailable provider');
  assert.ok(current.artifacts.rawTranslation.segments.some((unit) => unit.status === 'error' && unit.liveTranslationAttemptedAt));
  // Repeated renderer-style triggers must not resubmit the failed sentence.
  for (let index = 0; index < 3; index += 1) {
    await request(`${endpoint}/live-translation`, { method: 'POST', json: { enabled: true } });
    await runtime.handler.idle();
  }
  await delay(1000);
  evidence.translationRetries = { failedAttempts, afterTriggers: (await runtime.handler.runtimeSnapshot()).llm.lifecycle.failed, triggers: 3 };
  assert.equal(evidence.translationRetries.afterTriggers, failedAttempts);
  await request(`${endpoint}/dictation/finalize`, { method: 'POST', json: {} });
  current = await runtime.store.get(session.id);
  assert.equal(current.transcriptSegments[0].versions.revised, undefined, 'Whisper revision must wait for explicit user action');
  // The current product defers the stronger Whisper pass until an explicit user action.
  await request(`${endpoint}/asr/revise`, { method: 'POST', json: {} });
  await runtime.handler.idle();
  current = await runtime.store.get(session.id);
  const revised = current.transcriptSegments[0].versions.revised;
  assert.equal(revised?.stage, 'revised');
  assert.equal(revised.model, 'base');
  assert.equal(revised.provider, 'whisper.cpp');
  assert.match(revised.content, /country/iu, 'User-requested revised transcript must contain recognized speech');
  evidence.versions = current.transcriptSegments.map(({ id, stages, versions }) => ({ id, stages, versions }));
  evidence.rawTranscript = current.artifacts.rawTranscript;
  const savedAudio = await runtime.store.readFile(current.audio.storedPath);
  evidence.savedAudio = { bytes: savedAudio.length, sha256: hash(savedAudio), uploadedPcmWavSha256: hash(wav) };
  assert.equal(hash(savedAudio), hash(wav), 'Finalized audio must preserve the actual uploaded PCM');
  assert.equal(current.artifacts.highQualityTranscript, null);
  await request(`${endpoint}/materials`, { method: 'POST', body: 'My fellow Americans: ask not what your country can do for you; ask what you can do for your country.', headers: { 'content-type': 'text/plain', 'x-filename': 'jfk-reference.txt' }, expected: 201 });
  current = await runtime.store.get(session.id);
  evidence.retrieval = retrieveCorrectionEvidence(current.materials, current.artifacts.rawTranscript.content);
  assert.ok(evidence.retrieval.snippets.length > 0, 'C6 must retrieve the relevant uploaded reference');
  assert.ok(evidence.retrieval.text.length <= 2400);
  evidence.cleanupUnavailable = await request(`${endpoint}/artifacts/cleanedTranscript/ensure`, { method: 'POST', json: {}, expected: 503 });
  assert.match(evidence.cleanupUnavailable.error, /Ollama/iu);
  current = await runtime.store.get(session.id);
  assert.equal(current.processing.stage, 'cleanup');
  assert.equal(current.processing.status, 'error');
  assert.equal(current.artifacts.cleanedTranscript, null);
  assert.equal(current.artifacts.rawTranscript.content, evidence.rawTranscript.content);
  assert.equal(hash(await runtime.store.readFile(current.audio.storedPath)), hash(wav));
  evidence.cleanup = { status: 'retryable-provider-error', processing: current.processing, activityLog: current.activityLog, successfulModelCorrectionTested: false };
  await runtime.handler.idle();
  evidence.idle = await runtime.handler.runtimeSnapshot();
  assertRuntimeIdle(evidence.idle);
  evidence.remainingNewTempDirectories = (await tempDirectories()).filter((name) => !priorTemps.has(name));
  assert.deepEqual(evidence.remainingNewTempDirectories, []);
  evidence.ok = true;
  return evidence;
}

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeRun, parseArguments, prepareRun } from '../scripts/rerun-version-c.js';
import { fingerprint } from '../src/lib.js';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const stableCode = async () => ({ sha256: 'fixture-code', files: [] });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'version-c-rerun-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'assignment_transcriptions');
  await fs.mkdir(path.join(source, 'raw_asr'), { recursive: true });
  await fs.mkdir(path.join(root, 'version_b'));
  await fs.mkdir(path.join(root, 'context_audio_1'));
  const material = 'Bayes theorem combines prior and evidence.\n';
  await fs.writeFile(path.join(root, 'context_audio_1/notes.txt'), material);
  const cases = [];
  for (let index = 1; index <= 2; index += 1) {
    const caseId = `audio_1_0${index}`;
    const audio = `audio sample ${index}`;
    const raw = `Base theorem combines prior and evidence ${index}.\n`;
    const baseline = `Base theorem combines a prior and evidence ${index}.\n`;
    const name = `${caseId}__slice.txt`;
    await fs.writeFile(path.join(root, `${caseId}.m4a`), audio);
    await fs.writeFile(path.join(source, 'raw_asr', name), raw);
    await fs.writeFile(path.join(root, 'version_b', name), baseline);
    cases.push({ caseId, set: 'audio_1', sourceAudio: `${caseId}.m4a`, sourceAudioSha256: sha256(audio), durationSeconds: 5, rawOutput: `raw_asr/${name}`, variants: { B: { output: `version_b/${name}`, outputSha256: sha256(baseline) } } });
  }
  const manifest = { status: 'complete', whisper: { model: 'base', language: 'auto' }, llm: { model: 'qwen3.5:4b' }, branchCommits: { B: 'baseline-commit' }, contextMapping: { audio_1: 'context_audio_1' }, contextDocuments: { audio_1: [{ filename: 'notes.txt', sha256: sha256(material), extractor: 'plain-text' }] }, cases };
  const manifestPath = path.join(source, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const options = { manifest: manifestPath, modelDigest: 'fixture-model-digest' };
  const plan = await prepareRun(options, { codeIdentity: stableCode });
  return { root, source, manifest, manifestPath, options, plan };
}

test('rerun supplies exact frozen raw/B text, no reference, and captures calls for safe resume', async (t) => {
  const { plan, root } = await fixture(t);
  let calls = 0;
  const provider = { async generate(request) { calls += 1; return { content: request.prompt.replace('Base', 'Bayes'), provider: 'test' }; } };
  const dependencies = { codeIdentity: stableCode, log() {}, provider, async runStage({ stage, session, llm, options }) {
    assert.equal(stage, 'cleanup');
    assert.equal(options.cleanupBaseline.sourceFingerprint, fingerprint(session.artifacts.rawTranscript.content));
    assert.equal(options.cleanupBaseline.provenance.variant, 'B');
    assert.equal(session.materials[0].extractedText, 'Bayes theorem combines prior and evidence.');
    assert.equal(Object.keys(session.artifacts).includes('reference'), false);
    const response = await llm.generate({ model: options.model, prompt: options.cleanupBaseline.content });
    return { artifact: { content: response.content, provider: 'test', baseline: options.cleanupBaseline.provenance, repairs: [{ accepted: true }], metrics: { regions: 1 } } };
  } };
  const completed = await executeRun(plan, dependencies);
  assert.equal(completed.status, 'complete');
  assert.equal(completed.cases.length, 2);
  assert.equal(calls, 2);
  const diagnostic = JSON.parse(await fs.readFile(path.join(plan.outputDirectory, 'diagnostics/audio_1_01.json'), 'utf8'));
  assert.match(diagnostic.attempts[0].calls[0].request.prompt, /Base theorem/);
  assert.match(diagnostic.attempts[0].calls[0].response.content, /Bayes theorem/);
  assert.equal(await fs.readFile(path.join(root, 'version_b/audio_1_01__slice.txt'), 'utf8'), 'Base theorem combines a prior and evidence 1.\n');
  await executeRun(plan, dependencies);
  assert.equal(calls, 2, 'matching completed cases must not invoke the model again');
});

test('tampered frozen B fails preflight before inference', async (t) => {
  const { root, options } = await fixture(t);
  await fs.writeFile(path.join(root, 'version_b/audio_1_01__slice.txt'), 'changed');
  await assert.rejects(prepareRun(options, { codeIdentity: stableCode }), /Frozen Version B SHA256 mismatch/);
});

test('audio and material identity changes fail preflight rather than mixing datasets', async (t) => {
  const { root, options } = await fixture(t);
  await fs.writeFile(path.join(root, 'audio_1_01.m4a'), 'different audio');
  await assert.rejects(prepareRun(options, { codeIdentity: stableCode }), /Audio SHA256 mismatch/);
  await fs.writeFile(path.join(root, 'context_audio_1/notes.txt'), 'different course material');
  await assert.rejects(prepareRun(options, { codeIdentity: stableCode }), /Course material SHA256 mismatch/);
});

test('a source directory cannot be selected as the rerun output directory', async (t) => {
  const { options, root } = await fixture(t);
  await assert.rejects(prepareRun({ ...options, outputDirectory: path.join(root, 'version_b') }, { codeIdentity: stableCode }), /overlap existing source/);
});

test('resume refuses changed configuration and changed output without overwriting files', async (t) => {
  const { plan, options } = await fixture(t);
  const dependencies = { codeIdentity: stableCode, log() {}, async runStage({ options: stageOptions }) { return { artifact: { content: stageOptions.cleanupBaseline.content } }; } };
  await executeRun(plan, dependencies);
  const changed = await prepareRun({ ...options, modelDigest: 'different-model' }, { codeIdentity: stableCode });
  await assert.rejects(executeRun(changed, dependencies), /different source\/code\/material\/model\/config/);
  const output = path.join(plan.outputDirectory, plan.cases[0].output);
  await fs.writeFile(output, 'manual edit');
  await assert.rejects(executeRun(plan, dependencies), /Completed Version C rerun output SHA256 mismatch/);
  assert.equal(await fs.readFile(output, 'utf8'), 'manual edit');
});

test('interrupted persistence recovers from completed diagnostics without another model call', async (t) => {
  const { plan } = await fixture(t);
  let calls = 0;
  const dependencies = { codeIdentity: stableCode, log() {}, async runStage({ options }) { calls += 1; return { artifact: { content: options.cleanupBaseline.content } }; } };
  const manifest = await executeRun(plan, dependencies);
  manifest.cases = manifest.cases.slice(1);
  manifest.status = 'running';
  await fs.writeFile(path.join(plan.outputDirectory, 'manifest.json'), JSON.stringify(manifest));
  await fs.rm(path.join(plan.outputDirectory, plan.cases[0].output));
  const completed = await executeRun(plan, dependencies);
  assert.equal(completed.cases.length, 2);
  assert.equal(calls, 2);
  assert.equal(await fs.readFile(path.join(plan.outputDirectory, plan.cases[0].output), 'utf8'), plan.cases[0].baselineText);
});

test('failed attempts retain raw request/error diagnostics and resume the same case', async (t) => {
  const { plan } = await fixture(t);
  let fail = true;
  const dependencies = { codeIdentity: stableCode, log() {}, provider: { async generate() { if (fail) throw new Error('provider unavailable'); return { content: 'Base theorem.' }; } }, async runStage({ llm }) { const response = await llm.generate({ prompt: 'repair terms' }); return { artifact: response }; } };
  await assert.rejects(executeRun(plan, dependencies), /provider unavailable/);
  fail = false;
  await executeRun(plan, dependencies);
  const diagnostic = JSON.parse(await fs.readFile(path.join(plan.outputDirectory, 'diagnostics/audio_1_01.json'), 'utf8'));
  assert.equal(diagnostic.attempts.length, 2);
  assert.equal(diagnostic.attempts[0].calls[0].error.message, 'provider unavailable');
  assert.equal(diagnostic.status, 'complete');
});

test('safe outputs after caught inference errors remain degraded and retry only those cases', async (t) => {
  const { plan } = await fixture(t);
  const calls = new Map();
  let recovered = false;
  const dependencies = { codeIdentity: stableCode, log() {}, async runStage({ session, options }) {
    calls.set(session.id, (calls.get(session.id) || 0) + 1);
    const failure = session.id === 'audio_1_01' && !recovered;
    return { artifact: { content: recovered && session.id === 'audio_1_01' ? options.cleanupBaseline.content.replace('Base', 'Bayes') : options.cleanupBaseline.content, metrics: { repairErrors: Number(failure) } } };
  } };
  const degraded = await executeRun(plan, dependencies);
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.degradedCases, 1);
  assert.equal(degraded.inferenceErrors, 1);
  assert.equal(await fs.readFile(path.join(plan.outputDirectory, plan.cases[0].output), 'utf8'), plan.cases[0].baselineText);
  recovered = true;
  const complete = await executeRun(plan, dependencies);
  assert.equal(complete.status, 'complete');
  assert.equal(complete.degradedCases, 0);
  assert.equal(calls.get('audio_1_01'), 2);
  assert.equal(calls.get('audio_1_02'), 1);
  assert.match(await fs.readFile(path.join(plan.outputDirectory, plan.cases[0].output), 'utf8'), /^Bayes/);
  const diagnostic = JSON.parse(await fs.readFile(path.join(plan.outputDirectory, 'diagnostics/audio_1_01.json'), 'utf8'));
  assert.deepEqual(diagnostic.attempts.map((attempt) => attempt.status), ['degraded', 'complete']);
  assert.equal(diagnostic.attempts[0].outputText, plan.cases[0].baselineText, 'safe output history must survive a retry');
});

test('degraded-output retries also refuse manual edits before invoking correction', async (t) => {
  const { plan } = await fixture(t);
  let calls = 0;
  const dependencies = { codeIdentity: stableCode, log() {}, async runStage({ options }) { calls += 1; return { artifact: { content: options.cleanupBaseline.content, metrics: { repairErrors: 1 } } }; } };
  await executeRun(plan, dependencies);
  const output = path.join(plan.outputDirectory, plan.cases[0].output);
  await fs.writeFile(output, 'manual edit');
  await assert.rejects(executeRun(plan, dependencies), /Existing output differs/);
  assert.equal(calls, 2);
  assert.equal(await fs.readFile(output, 'utf8'), 'manual edit');
});

test('CLI rejects missing values and supports a validation-only dry run', () => {
  assert.deepEqual(parseArguments(['--manifest', '/tmp/input.json', '--dry-run']), { manifest: '/tmp/input.json', dryRun: true });
  assert.throws(() => parseArguments(['--output-dir', '--dry-run']), /missing value/);
});

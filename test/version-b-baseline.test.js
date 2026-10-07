import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  runVersionBBaseline,
  VERSION_B_BASELINE_REVISION,
  VERSION_B_CLEANUP_SYSTEM,
} from '../src/version-b-baseline.js';

const RAW = 'We define conditional probability. Bayes theorem combines a prior with evidence.';
const SENTINEL = 'EXTERNAL_LECTURE_EVIDENCE_9283';
const SYSTEM = `You are a transcript correction assistant.

Correct obvious speech-recognition errors in the transcript below and improve its readability.

Rules:

1. Preserve the original meaning.
2. Correct obvious transcription errors.
3. Do not add facts that are not present in the transcript.
4. Do not use external lecture context.
5. Preserve technical terms when they are clear.
6. If a correction is uncertain, preserve the original wording.
7. Return only the corrected transcript.`;

function makeSession() {
  return {
    llmModel: 'local-test:4b',
    materials: [{ id: 'material-1', filename: 'slides.md', extractedText: SENTINEL }],
    lectureContext: SENTINEL,
    artifacts: { rawTranscript: { content: RAW }, highQualityTranscript: null, cleanedTranscript: null },
  };
}

const SCENARIOS = [
  { name: 'default transcript-only correction' },
  { name: 'accepted obvious recognition repair', source: 'We use probablity to explain the observed events in this experiment.', outputs: ['We use probability to explain the observed events in this experiment.'] },
  { name: 'successful preservation retry', outputs: ['Unrelated unsupported fabrication.'] },
  { name: 'two rejected drafts fall back', outputs: ['Unrelated unsupported fabrication.', 'Another unsupported fabrication.'] },
  { name: 'commentary skips retry', outputs: ['Here is the cleaned transcript: an invalid response.'] },
  { name: 'numeric correction retains original B rejection', source: 'The image has 28 by 28 pixels, giving 748 inputs to the neural network.', outputs: [
    'The image has 28 by 28 pixels, giving 784 inputs to the neural network.',
    'The image has 28 by 28 pixels, giving 784 inputs to the neural network.',
  ] },
  { name: 'ASR artifacts and duplicate sentence fallback', source: 'We explain probability using evidence. We explain probability using evidence. [BLANK_AUDIO] The prior changes after observation.', outputs: ['Unrelated unsupported fabrication.', 'Another unsupported fabrication.'] },
  { name: 'bounded multiple regions', source: 'Conditional probability connects an event with known evidence. The prior encodes knowledge before any observations arrive. Likelihood measures compatibility between hypotheses and observations. The posterior combines prior knowledge with the newly observed evidence.', options: { cleanupMaxCharacters: 80 } },
  { name: 'high-quality source and paragraph structure', highQuality: true },
  { name: 'explicit model and generation clamps', model: 'explicit-model:4b', options: { model: 'ignored-model:4b', numCtx: 1, numPredict: 1, context: SENTINEL, variant: 'C' } },
  { name: 'options select model and generation settings', options: { model: 'options-model:4b', numCtx: 16384, numPredict: 4096 } },
  { name: 'own B cache is reused', cache: 'B' },
  { name: 'force regenerates own B cache', cache: 'B', options: { forceCleanup: true } },
  { name: 'C cache cannot enter B baseline', cache: 'C' },
  { name: 'legacy cache cannot enter B baseline', cache: 'legacy' },
  { name: 'material-backed B cache is rejected', cache: 'materials' },
];

function recordingLlm(outputs = []) {
  const remaining = outputs.slice();
  return {
    calls: [],
    async generate(args) {
      this.calls.push(structuredClone(args));
      return { content: remaining.shift() ?? args.prompt.slice('Transcript:\n'.length), provider: 'test', model: args.model };
    },
  };
}

async function traceScenario(scenario, run = runVersionBBaseline) {
  const session = makeSession();
  if (scenario.source) session.artifacts.rawTranscript.content = scenario.source;
  if (scenario.highQuality) {
    session.artifacts.rawTranscript.content = 'Draft speech with recognition mistakes.';
    session.artifacts.highQualityTranscript = { content: RAW, generationState: 'complete' };
    session.highQualityParagraphization = { paragraphs: [
      { id: 'hq-first', segmentIds: ['s1'] },
      { id: 'hq-second', segmentIds: ['s2'] },
    ] };
  }
  if (scenario.cache) {
    const prior = await run({ session, llm: recordingLlm() });
    session.artifacts.cleanedTranscript = {
      ...prior,
      source: 'cleanup',
      experimentVariant: scenario.cache === 'legacy' ? undefined : scenario.cache === 'C' ? 'C' : 'B',
      ...(scenario.cache === 'materials' ? { materialIds: ['material-1'] } : {}),
    };
  }
  const before = structuredClone(session);
  const llm = recordingLlm(scenario.outputs);
  const progress = [];
  const result = await run({
    session, llm, model: scenario.model, options: scenario.options,
    onProgress: async (partial) => progress.push(structuredClone(partial)),
  });
  assert.deepEqual(session, before, `${scenario.name}: input session must not be mutated`);
  return { calls: llm.calls, progress, result };
}

function traceDigest(trace) {
  return createHash('sha256').update(JSON.stringify(trace)).digest('hex');
}

// Golden digests were captured from the actual experiment/version-b pipeline at
// 48ec0c1cd77fa9e8eedd71455da80453e33ee57c using the scenarios above and fake LLMs.
// They cover every call argument, progress payload, region, validation decision,
// output byte, chunk, cache counter, and fallback. Original artifact-envelope
// timestamps/provenance are omitted because the baseline API returns cleanup.
// No Git checkout, Ollama server, network, or original branch is needed at test time.
const GOLDEN = {
  "accepted obvious recognition repair": "dc3857c088d4cb4b3bd29fffb972fc20d6f597566f0ff390874c0bfaf51e8f0c",
  "default transcript-only correction": "060c398fcd6ca03d0dbfb3ee4696329ab55d9de240ec2324344ee3bfea44f298",
  "successful preservation retry": "9c1219f33027c212740407e639a2f55ebe410fdd1aaeea12f782b6deeac1f06a",
  "two rejected drafts fall back": "e5577e124a5a5c2b0359be48d1deb173d14e11b601db8ac2a04d635edfbbb9d4",
  "commentary skips retry": "0abf366e2ead07522393b8adb43f564cb35988151ccb8520d71d3a9c408bb1e0",
  "numeric correction retains original B rejection": "ae6827fe3ba8549a327c59d109dabbeac866dd783cdcd2c740609a80b7cf1156",
  "ASR artifacts and duplicate sentence fallback": "1f75fd3ad5cb0fa6fbb46957c55c2cc1b11994c003c5595f1eaff10d816f0b6a",
  "bounded multiple regions": "9441dd2fe45b5a15e01ddc248084b49349bb045938eae51aa7be22f6b746c259",
  "high-quality source and paragraph structure": "71b29731df249d787265b5d0829381fccfda947d9c9fe83827ab3ba7a5fae819",
  "explicit model and generation clamps": "03dca5dcc9f2bb9f1d7413edb66a7bfbec9d89f63b3072c8fd2e4928b5be5542",
  "options select model and generation settings": "875d0f358b58521dfb8bd7011f89bd6a76bf0a7ef11247d1f7acbe4effa182f6",
  "own B cache is reused": "9bf6bd46d7773c2f37c30dc65a0d26cc8b110b5e6f10074421da5a923f852c3e",
  "force regenerates own B cache": "060c398fcd6ca03d0dbfb3ee4696329ab55d9de240ec2324344ee3bfea44f298",
  "C cache cannot enter B baseline": "060c398fcd6ca03d0dbfb3ee4696329ab55d9de240ec2324344ee3bfea44f298",
  "legacy cache cannot enter B baseline": "060c398fcd6ca03d0dbfb3ee4696329ab55d9de240ec2324344ee3bfea44f298",
  "material-backed B cache is rejected": "060c398fcd6ca03d0dbfb3ee4696329ab55d9de240ec2324344ee3bfea44f298"
};

for (const scenario of SCENARIOS) {
  test(`frozen B matches original B trace: ${scenario.name}`, async () => {
    const trace = await traceScenario(scenario);
    assert.equal(traceDigest(trace), GOLDEN[scenario.name], 'frozen B behavior differs from the original B control');
    for (const call of trace.calls) {
      assert.equal(call.system, SYSTEM);
      assert.equal(call.temperature, 0.1);
      assert.equal(call.retrievedContextCharacters, 0);
      assert.ok(call.prompt.startsWith('Transcript:\n'));
      assert.doesNotMatch(JSON.stringify(call), new RegExp(SENTINEL));
    }
    for (const region of trace.result.regions) {
      assert.equal(region.previousContext, '');
      assert.equal(region.followingContext, '');
      assert.equal(region.lectureReference, '');
    }
  });
}

test('baseline records its frozen revision and exact B system prompt', () => {
  assert.equal(VERSION_B_BASELINE_REVISION, '48ec0c1cd77fa9e8eedd71455da80453e33ee57c');
  assert.equal(VERSION_B_CLEANUP_SYSTEM, SYSTEM);
});

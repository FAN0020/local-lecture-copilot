import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRepairEdits, runConservativeCleanup, suggestRepairCandidates, CORRECTION_REVISION } from '../src/conservative-correction.js';
import { fingerprint } from '../src/lib.js';

const original = 'Base theorem combines a prior with likelihood and evidence.';
const quote = 'Bayes theorem combines a prior with likelihood and evidence.';
const snippets = [{ id: 'M1:S1', text: quote, materialId: 'probability' }];
const materials = [{ id: 'probability', filename: 'probability.md', extractedText: quote }];
const edit = { original: 'Base', replacement: 'Bayes', occurrence: 1, kind: 'term', evidenceId: 'M1:S1', evidenceQuote: quote };
const response = (edits) => JSON.stringify({ edits });
const session = (raw = original, documents = materials) => ({ llmModel: 'test:4b', materials: documents, artifacts: { rawTranscript: { content: raw } } });
const supplied = (raw = original, content = raw) => ({ cleanupBaseline: { content, sourceFingerprint: fingerprint(raw), model: 'test:4b', provenance: { variant: 'B' } } });

test('applies a supported spelling repair while preserving every other byte', () => {
  const source = `${original}\n\n  Further explanation stays, stays exactly here.\n`;
  const result = applyRepairEdits(source, response([edit]), snippets);
  assert.equal(result.content, source.replace('Base', 'Bayes'));
  assert.equal(result.accepted.length, 1);
});

test('malformed responses, empty edits, fabricated evidence, missing or ambiguous spans retain baseline', () => {
  for (const candidate of ['Here is the corrected transcript.', '{}', response([]), response([{ ...edit, evidenceQuote: 'A fabricated quotation about Bayes theorem and prior likelihood evidence.' }]), response([{ ...edit, original: 'Missing' }])]) {
    assert.equal(applyRepairEdits(original, candidate, snippets).content, original);
  }
  assert.equal(applyRepairEdits(`${original} ${original}`, response([{ ...edit, occurrence: undefined }]), snippets).accepted.length, 0);
});

test('occurrence selects one repeated recognition error without touching its neighbors', () => {
  const source = 'I heard lava. The lava model combines vision and language.';
  const evidenceQuote = 'LLaVA is a model that combines vision and language.';
  const result = applyRepairEdits(source, response([{
    original: 'lava', replacement: 'LLaVA', occurrence: 2, kind: 'name', evidenceId: 'M1:S1', evidenceQuote,
  }]), [{ ...snippets[0], text: evidenceQuote }]);
  assert.equal(result.content, 'I heard lava. The LLaVA model combines vision and language.');
  assert.equal(result.accepted[0].start, 18);
});

test('accepts a retrieved technical acronym even when its immediate sentence has no repeated anchor', () => {
  const source = 'This shows the multimodal alarm.';
  const evidenceQuote = 'An example multimodal LLM: LLaVA.';
  const result = applyRepairEdits(source, response([{
    original: 'alarm', replacement: 'LLM', occurrence: 1, kind: 'name', evidenceId: 'M1:S1', evidenceQuote,
  }]), [{ ...snippets[0], text: evidenceQuote }]);
  assert.equal(result.content, 'This shows the multimodal LLM.');
});

test('accepts a supported multiword ASR repair while preserving surrounding grammar', () => {
  const source = 'The change still has vision in power and a projection for the image input.';
  const evidenceQuote = 'A vision encoder maps image features before the projection layer.';
  const result = applyRepairEdits(source, response([{
    original: 'vision in power', replacement: 'vision encoder', occurrence: 1, kind: 'term', evidenceId: 'M1:S1', evidenceQuote,
  }]), [{ ...snippets[0], text: evidenceQuote }]);
  assert.equal(result.content, 'The change still has vision encoder and a projection for the image input.');
  assert.equal(result.accepted.length, 1);
});

test('accepts harmless evidence typography normalization but still requires a verbatim phrase', () => {
  const source = 'The jacket frontier separates the feasible region.';
  const stored = 'The “jagged frontier” separates the feasible region.';
  const quoted = 'The "jagged frontier" separates the feasible region.';
  const result = applyRepairEdits(source, response([{
    original: 'jacket frontier', replacement: 'jagged frontier', occurrence: 1, kind: 'term', evidenceId: 'M1:S1', evidenceQuote: quoted,
  }]), [{ ...snippets[0], text: stored }]);
  assert.equal(result.content, 'The jagged frontier separates the feasible region.');
});

test('builds exact candidate patches for the observed multiword and repeated-name errors', () => {
  const source = 'The jacket frontier leads on. The vision in power connects images. I heard lava. Lava is a vision language model version of lava.';
  const evidence = { snippets: [
    { id: 'M1:S1', text: 'The jagged frontier leads on.', materialId: 'course' },
    { id: 'M1:S2', text: 'The vision encoder connects images.', materialId: 'course' },
    { id: 'M1:S3', text: 'LLaVA is a vision LM of LLAMA.', materialId: 'course' },
  ] };
  const candidates = suggestRepairCandidates(source, evidence);
  assert.equal(candidates.some((item) => item.original === 'jacket' && item.replacement === 'jagged'), true);
  assert.equal(candidates.some((item) => item.original === 'in power' && item.replacement === 'encoder'), true);
  assert.equal(candidates.some((item) => item.original === 'lava' && item.occurrence === 2 && item.replacement === 'LLAMA'), true);
});

test('does not offer a grammatical suffix change as a terminology repair', () => {
  const evidence = { snippets: [{ id: 'M1:S1', text: 'Use a code-based stack.', materialId: 'course' }] };
  const candidates = suggestRepairCandidates('We inspected the code base as well.', evidence);
  assert.equal(candidates.some((item) => item.original === 'base' && item.replacement === 'based'), false);
});

test('does not offer morphology or paraphrase candidates observed in the batch', () => {
  const cases = [
    ['This is called a compile time error.', 'An ORM call became costly.'],
    ['This is language generation.', 'Generative AI uses language.'],
    ['A patch is usually 14 by 14 pixels.', 'A patch is typically 14 by 14 pixels.'],
  ];
  for (const [source, material] of cases) {
    const evidence = { snippets: [{ id: 'M1:S1', text: material, materialId: 'course' }] };
    assert.deepEqual(suggestRepairCandidates(source, evidence), []);
  }
});

test('conflicting alternatives for the same occurrence are never applied', async () => {
  const raw = 'I heard lava in a vision language model lecture.';
  const evidenceText = 'LLaVA is a vision language model of LLAMA.';
  const result = await runConservativeCleanup({
    session: session(raw, [{ id: 'course', filename: 'course.txt', extractedText: evidenceText }]),
    model: 'test:4b', options: supplied(raw),
    llm: { async generate() { return { content: JSON.stringify({ candidateIds: ['C2', 'C3'] }) }; } },
  });
  assert.equal(result.content, raw);
  assert.equal(result.repairs[0].rejected.every((item) => item.reason === 'conflicting-candidate-selection'), true);
});

test('rejects unrelated insertions, punctuation rewriting, grammar and changes to claims or uncertainty', () => {
  const cases = [
    ['The vision encoder maps image features into vector space.', 'maps', 'maps the', 'The vision encoder maps the image features into vector space.'],
    ['Gradient descent does not minimize squared error.', 'does not minimize', 'does minimize', 'Gradient descent does minimize squared error.'],
    ['Gradient descent decreases squared error.', 'decreases', 'increases', 'Gradient descent increases squared error.'],
    ['The [unclear] model predicts disease severity.', '[unclear]', 'nuclear', 'The nuclear model predicts disease severity.'],
    ['The vision encoder uses images; transformers map features.', 'images; transformers', 'images and transformers', 'The vision encoder uses images and transformers to map features.'],
  ];
  for (const [source, before, after, evidenceQuote] of cases) {
    const result = applyRepairEdits(source, response([{ ...edit, original: before, replacement: after, evidenceQuote }]), [{ ...snippets[0], text: evidenceQuote }]);
    assert.equal(result.content, source, `${before} -> ${after}`);
    assert.equal(result.accepted.length, 0);
  }
});

test('accepts an explicitly supported numeric repair without requiring the incorrect source number to survive', () => {
  const source = 'The image has 28 by 28 pixels, giving 748 inputs to the neural network.';
  const evidenceQuote = 'The image has 28 by 28 pixels, giving 784 inputs to the neural network.';
  const result = applyRepairEdits(source, response([{ ...edit, original: '748', replacement: '784', kind: 'number', evidenceQuote }]), [{ ...snippets[0], text: evidenceQuote }]);
  assert.equal(result.content, evidenceQuote);
  assert.equal(result.accepted.length, 1);
});

test('a quantity for a different model cannot authorize a numeric edit', () => {
  const source = 'Model Falcon contains 4 hidden layers.';
  const evidenceQuote = 'Model Falcon contains 4 hidden layers. Model Eagle contains 8 hidden layers.';
  const result = applyRepairEdits(source, response([{ ...edit, original: '4', replacement: '8', kind: 'number', evidenceQuote }]), [{ ...snippets[0], text: evidenceQuote }]);
  assert.equal(result.content, source);
  assert.equal(result.rejected[0].reason, 'numeric-evidence-context-mismatch');
  const compound = evidenceQuote.replace('. Model Eagle', ', whereas Model Eagle');
  const other = applyRepairEdits(source, response([{ ...edit, original: '4', replacement: '8', kind: 'number', evidenceQuote: compound }]), [{ ...snippets[0], text: compound }]);
  assert.equal(other.content, source);
  assert.equal(other.rejected[0].reason, 'conflicting-numeric-evidence');
});

test('accepts valid edits individually without applying overlapping or unsupported edits', () => {
  const result = applyRepairEdits(original, response([edit, edit, { ...edit, original: 'likelihood', replacement: 'likelihood and accuracy' }]), snippets);
  assert.equal(result.content, quote);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 2);
});

test('provided B baseline is preserved exactly when retrieval abstains, including whitespace', async () => {
  const raw = 'I think that is the idea.';
  const baseline = 'I think that is the idea.\n\nAnd so, we continue.\n';
  const result = await runConservativeCleanup({ session: session(raw, []), model: 'test:4b', options: supplied(raw, baseline), llm: { generate() { throw new Error('Must not invoke LLM'); } } });
  assert.equal(result.content, baseline);
  assert.equal(result.pipelineRevision, CORRECTION_REVISION);
  assert.equal(result.metrics.baselineRetained, true);
});

test('patch failure or provider error retains B correction rather than the worse raw source', async () => {
  const raw = 'Base theorem combines a prior with likelihood and evidance.';
  for (const providerError of [false, true]) {
    let calls = 0;
    const result = await runConservativeCleanup({ session: session(raw), model: 'test:4b', options: supplied(raw, original), llm: { async generate() {
      calls += 1;
      if (providerError) throw new Error('provider unavailable');
      return { content: 'Rewrite the entire transcript instead.' };
    } } });
    assert.equal(result.content, original);
    assert.equal(calls, providerError ? 1 : 2);
    assert.equal(result.metrics.repairErrors, providerError ? 1 : 0);
    assert.equal(result.baseline.content, original);
  }
});

test('retry can recover a valid minimal edit and records both rejected and accepted drafts', async () => {
  let calls = 0;
  const result = await runConservativeCleanup({ session: session(), model: 'test:4b', options: supplied(), llm: { async generate() {
    calls += 1;
    return { content: calls === 1 ? 'bad json' : response([edit]) };
  } } });
  assert.equal(result.content, quote);
  assert.equal(result.repairs[0].attempts.length, 2);
  assert.equal(result.metrics.acceptedEdits, 1);
  assert.deepEqual(result.materialIds, ['probability']);
});

test('repair calls use the bounded JSON schema instead of a transcript-sized response budget', async () => {
  let request;
  await runConservativeCleanup({ session: session(), model: 'test:4b', options: supplied(), llm: { async generate(options) {
    request = options;
    return { content: response([]) };
  } } });
  assert.equal(request.temperature, 0);
  assert.equal(request.numPredict, 128);
  assert.equal(request.format.properties.candidateIds.items.enum[0], 'C1');
  assert.ok(request.format.properties.candidateIds.items.enum.length <= 18);
  assert.equal(request.format.properties.candidateIds.maxItems, 8);
});

test('mismatched ASR fingerprint or model rejects a supplied baseline before inference', async () => {
  for (const invalid of [{ sourceFingerprint: 'wrong' }, { model: 'wrong:4b' }]) {
    const options = supplied();
    Object.assign(options.cleanupBaseline, invalid);
    await assert.rejects(runConservativeCleanup({ session: session(), model: 'test:4b', options, llm: { generate() { throw new Error('Must not call'); } } }), { code: 'BASELINE_MISMATCH' });
  }
});

test('a partially generated baseline is resumed, never mistaken for the complete transcript', async () => {
  const raw = 'First sentence retains its detail. Second sentence retains its explanation.';
  let saved;
  let count = 0;
  const s = session(raw, []);
  await assert.rejects(runConservativeCleanup({ session: s, model: 'test:4b', options: { cleanupMaxCharacters: 40 }, onProgress: (partial) => { saved = partial; }, llm: { async generate(args) {
    count += 1;
    if (count > 1) throw new Error('baseline interrupted');
    return { content: args.prompt.split('Transcript:\n')[1] };
  } } }), /baseline interrupted/);
  assert.ok(saved.baseline.content.length < raw.length);
  s.artifacts.cleanedTranscript = saved;
  const result = await runConservativeCleanup({ session: s, model: 'test:4b', options: { cleanupMaxCharacters: 40 }, llm: { async generate(args) { return { content: args.prompt.split('Transcript:\n')[1] }; } } });
  assert.match(result.content, /First sentence retains its detail/);
  assert.match(result.content, /Second sentence retains its explanation/);
  assert.equal(result.baseline.generationState, 'complete');
});

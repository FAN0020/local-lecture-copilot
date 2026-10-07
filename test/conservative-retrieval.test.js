import assert from 'node:assert/strict';
import test from 'node:test';
import { retrieveCorrectionEvidence } from '../src/conservative-retrieval.js';

function material(extractedText, id = 'course') {
  return { id, filename: `${id}.pdf`, extractedText };
}

test('abstains on conversational words, numbers, and formula overlap', () => {
  const materials = [material('Four interface rules. Think before the model writes.\n\nWeek 6: same model, same system.\n\nt1 t2 t3. The light stays the same.\n\n28 × 28 = 784.')];
  for (const query of [
    'We will look at this in the next class in three or four days.',
    'In six months the models started to become better.',
    'T1 T2 T3 are on the right.',
    '28 × 28 = 784.',
  ]) assert.deepEqual(retrieveCorrectionEvidence(materials, query).snippets, []);
});

test('retrieves the build-versus-buy criteria instead of generic numbered rules', () => {
  const useful = 'Build-vs-buy, per layer: own-vs-rent judged on cost, latency, control, data gravity, regulation.';
  const evidence = retrieveCorrectionEvidence([
    material('Four interface rules: room to think, familiar formats, no bookkeeping. The next class is in four days.', 'rules'),
    material(useful, 'criteria'),
  ], 'Building versus buying is decided using five criteria. We will look at this in the next class in four days.');
  assert.deepEqual(evidence.materialIds, ['criteria']);
  assert.equal(evidence.snippets[0].text, useful);
});

test('allows a near miss only next to a shared terminology anchor', () => {
  const materials = [material('Bayes theorem relates a posterior probability to a prior and likelihood.')];
  assert.equal(retrieveCorrectionEvidence(materials, 'We use Base theorem.').snippets.length, 1);
  assert.equal(retrieveCorrectionEvidence(materials, 'We use the base.').snippets.length, 0);
  assert.equal(retrieveCorrectionEvidence([material('The light matrix is stable.')], 'The right matrix is here.').snippets.length, 0);
  assert.equal(retrieveCorrectionEvidence([material('A jagged frontier separates the feasible region.')], 'The jacket frontier separates the feasible region.').snippets.length, 1);
});

test('does not let dates support an accidental medical anchor in corrupted model names', () => {
  const materials = [material('Check kidney function and repeat the renal panel in three months.')];
  assert.equal(retrieveCorrectionEvidence(materials, 'In six months moonshot kidney models became better.').snippets.length, 0);
});

test('uses co-occurring contrastive terminology and excludes video time indices', () => {
  const evidence = retrieveCorrectionEvidence([
    material('CLIP uses contrastive learning to align image and text representations.', 'clip'),
    material('t1 t2 t3 t4 t5. Objects stay the same and light must not flicker between frames.', 'video'),
  ], 'We use contrastive learning for image and text representations. T1, T2, T3 are on the right matrix.');
  assert.deepEqual(evidence.materialIds, ['clip']);
  assert.equal(retrieveCorrectionEvidence([material('CLIP aligns images and captions.')], 'CLIP').snippets.length, 1);
});

test('prefers a discriminative compact terminology passage over a long topical passage', () => {
  const evidence = retrieveCorrectionEvidence([
    material('Contrastive learning optimizes paired embeddings.', 'focused'),
    material('Contrastive learning is discussed with agents, governance, mathematics, education, planning, banking, software, robotics, economics, transport, optimization and deployment.', 'broad'),
  ], 'Contrastive learning produces paired embeddings.');
  assert.equal(evidence.snippets[0].materialId, 'focused');
});

test('aligns singular and plural inflections for embedding terminology', () => {
  const materials = [material('The embedding matrix represents vocabulary tokens.')];
  assert.equal(retrieveCorrectionEvidence(materials, 'These embeddings are in a matrix.').snippets.length, 1);
});

test('keeps selected text whole and within the complete formatted budget', () => {
  const long = `Bayes theorem ${'probability '.repeat(20)}ends here.`;
  const short = 'Bayes theorem updates probability.';
  const materials = [material(long, 'long'), material(short, 'short')];
  const evidence = retrieveCorrectionEvidence(materials, 'Bayes theorem probability', { maxCharacters: 100 });
  assert.ok(evidence.text.length <= 100);
  assert.equal(evidence.snippets.length, 1);
  assert.equal(evidence.snippets[0].text, short);
  assert.deepEqual(retrieveCorrectionEvidence(materials, 'Bayes theorem', { maxCharacters: 20 }).snippets, []);
});

test('re-scores complete sentence excerpts rather than retaining a full-block score', () => {
  const introductory = `${'General background is supplied. '.repeat(70)}`;
  const relevant = 'Bayes theorem combines prior probability with likelihood.';
  const evidence = retrieveCorrectionEvidence([material(introductory + relevant)], 'Bayes theorem likelihood', { maxCharacters: 180 });
  assert.equal(evidence.snippets.length, 1);
  assert.ok(evidence.snippets[0].text.includes(relevant));
  assert.ok(evidence.snippets[0].text.endsWith('.'));
  assert.ok(evidence.text.length <= 180);
  const selectedAlone = retrieveCorrectionEvidence([material(evidence.snippets[0].text)], 'Bayes theorem likelihood', { maxCharacters: 180 });
  // Corpus rarity may change the score; the complete selected excerpt must still qualify on its own.
  assert.equal(selectedAlone.snippets.length, 1);
});

test('honors zero limits, deduplicates evidence, and returns stable identifiers', () => {
  const materials = [material('Bayes theorem uses probability.', 'first'), material('Bayes theorem uses probability.', 'duplicate')];
  assert.deepEqual(retrieveCorrectionEvidence(materials, 'Bayes theorem', { maxSnippets: 0 }).snippets, []);
  assert.deepEqual(retrieveCorrectionEvidence(materials, 'Bayes theorem', { maxCharacters: 0 }).snippets, []);
  const first = retrieveCorrectionEvidence(materials, 'Bayes theorem');
  assert.equal(first.snippets.length, 1);
  assert.equal(first.snippets[0].id, 'M1:S1');
  assert.deepEqual(first, retrieveCorrectionEvidence(materials, 'Bayes theorem'));
});

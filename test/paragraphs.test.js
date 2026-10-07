import assert from 'node:assert/strict';
import test from 'node:test';
import { mergePreviousParagraph, normalizeSegments, paragraphize, paragraphText, splitParagraph } from '../src/paragraphs.js';

function segments(items) {
  return items.map((text, index) => ({ id: `s${index}`, text, start: index * 2, end: index * 2 + 1 }));
}

test('paragraphing combines pause, sentence, transition, length, and topic signals', () => {
  const result = paragraphize(segments([
    'We define conditional probability.',
    'The denominator is the evidence.',
    'Now we move to a completely different topic about Fourier transforms.',
  ]), { mode: 'final' });
  assert.equal(result.paragraphs.length, 2);
  assert.equal(result.boundaries[0].enabled, false, 'pause alone inside one idea does not split');
  assert.equal(result.boundaries[1].enabled, true, 'transition/topic shift splits');
});

test('a long pause without a sentence or discourse/topic cue does not create a paragraph', () => {
  const result = paragraphize([
    { id: 'p0', text: 'The idea continues without a completed sentence', start: 0, end: 1 },
    { id: 'p1', text: 'with related detail and the same subject', start: 6, end: 7 },
  ], { mode: 'final' });
  assert.equal(result.paragraphs.length, 1);
  assert.equal(result.boundaries[0].signals.pause >= 2, true);
  assert.equal(result.boundaries[0].enabled, false);
});

test('short pauses within one idea and long paragraphs stay coherent unless other signals agree', () => {
  const result = paragraphize([
    { id: 'a', text: 'This is one idea with a short pause.', start: 0, end: 1 },
    { id: 'b', text: 'It continues with related evidence.', start: 1.2, end: 2 },
  ], { mode: 'final' });
  assert.equal(result.paragraphs.length, 1);
  const long = paragraphize(Array.from({ length: 8 }, (_, index) => ({ id: `l${index}`, text: 'A very long lecture sentence with many details and context '.repeat(4), start: index, end: index + .5 })), { mode: 'final' });
  assert.ok(long.paragraphs.length > 1, 'length guard eventually introduces a boundary');
});

test('manual split and merge are locked and survive automatic refinement', () => {
  let result = paragraphize(segments(['First sentence.', 'Second sentence.', 'Third sentence.']), { mode: 'final' });
  result = splitParagraph(result, { paragraphId: result.paragraphs[0].id, afterSegmentId: 's0' });
  assert.equal(result.paragraphs.length, 2);
  const splitBoundary = result.boundaries.find((item) => item.afterSegmentId === 's0');
  assert.equal(splitBoundary.manualLocked, true);
  result = mergePreviousParagraph(result, { paragraphId: result.paragraphs[1].id });
  assert.equal(result.paragraphs.length, 1);
  const mergeBoundary = result.boundaries.find((item) => item.afterSegmentId === 's0');
  assert.equal(mergeBoundary.enabled, false);
  const refined = paragraphize(result.segments, { previous: result, mode: 'final' });
  assert.equal(refined.paragraphs.length, 1);
  assert.equal(paragraphText(refined), 'First sentence. Second sentence. Third sentence.');
});

test('paragraph text is a projection and never changes raw wording', () => {
  const raw = 'uh, Bayes theorem   combines a prior with evidence.';
  const result = paragraphize([{ id: 's', text: raw, start: 0, end: 1 }], { mode: 'final' });
  assert.equal(result.segments[0].text, raw);
  assert.equal(paragraphText(result), raw);
});

test('provider segment disagreement falls back to canonical Raw sentence text', () => {
  const canonical = 'Canonical sentence one. Canonical sentence two.';
  const result = normalizeSegments([{ start: 0, end: 1, text: 'Different provider wording.' }], canonical);
  assert.equal(result.map((segment) => segment.text).join(' '), canonical);
});

test('paragraph sentence units share cleanup-safe boundaries for abbreviations and decimals', () => {
  const content = 'Dr. Smith explains the value 3.14. Next point follows.';
  const result = normalizeSegments([{ id: 'provider', start: 0, end: 3, text: content }], content);
  assert.deepEqual(result.map((segment) => segment.text), [
    'Dr. Smith explains the value 3.14.',
    'Next point follows.',
  ]);
});

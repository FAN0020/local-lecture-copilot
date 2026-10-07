import assert from 'node:assert/strict';
import test from 'node:test';
import { sentenceParagraphText, splitSentences } from '../src/sentences.js';

test('sentence splitting handles common punctuation without breaking abbreviations or decimals', () => {
  const text = 'This is Dr. Smith. The value is 3.14. We use e.g. this example. Next topic.';
  assert.deepEqual(splitSentences(text), [
    'This is Dr. Smith.',
    'The value is 3.14.',
    'We use e.g. this example.',
    'Next topic.',
  ]);
});

test('sentence splitting handles CJK punctuation, ellipses, and missing spaces', () => {
  assert.deepEqual(splitSentences('他说这是第一句。然后这是第二句！ It was surprising... But useful.'), [
    '他说这是第一句。',
    '然后这是第二句！',
    'It was surprising...',
    'But useful.',
  ]);
  assert.deepEqual(splitSentences('First sentence.Second sentence.'), ['First sentence.', 'Second sentence.']);
});

test('sentence formatting groups sentences while preserving semantic paragraph breaks', () => {
  const text = 'First sentence. Second sentence.\nwrapped continuation.\n\nNew paragraph starts here! Final thought?';
  assert.equal(sentenceParagraphText(text), 'First sentence. Second sentence. wrapped continuation.\n\nNew paragraph starts here! Final thought?');
});

test('sentence formatting does not invent boundaries in an unfinished tail', () => {
  assert.equal(sentenceParagraphText('The lecturer begins an unfinished thought'), 'The lecturer begins an unfinished thought');
});

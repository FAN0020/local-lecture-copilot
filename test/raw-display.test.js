import assert from 'node:assert/strict';
import test from 'node:test';
import { blockSourceText, blockTranslationText, buildRawAlignmentUnits, groupRawDisplayBlocks } from '../web/raw-display.js';

const units = (items) => items.map(([id, sourceText, translatedText = '']) => ({ id, sourceText, translatedText, status: translatedText ? 'translated' : 'pending' }));

test('Raw display grouping keeps one mutable trailing block instead of tiny fragment rows', () => {
  const first = groupRawDisplayBlocks(units([
    ['a', 'This is'],
  ]), '...', []);
  const second = groupRawDisplayBlocks(units([
    ['a', 'This is'],
    ['b', 'a useful example.'],
  ]), '', first);
  assert.equal(second.length, 1);
  assert.equal(second[0].id, first[0].id);
  assert.equal(blockSourceText(second[0]), 'This is a useful example.');
});

test('finalized Raw blocks retain IDs through translation updates and appended speech', () => {
  const initial = groupRawDisplayBlocks(units([
    ['a', 'First sentence.', '第一句。'],
    ['b', 'Second sentence.', '第二句。'],
    ['c', 'Third sentence.'],
  ]), '', []);
  initial[0].finalized = true;
  const translated = groupRawDisplayBlocks(units([
    ['a', 'First sentence.', '第一句。'],
    ['b', 'Second sentence.', '第二句。'],
    ['c', 'Third sentence.', '第三句。'],
    ['d', 'Fourth sentence.'],
  ]), '', initial);
  assert.equal(translated[0].id, initial[0].id);
  assert.equal(blockTranslationText(translated[0]), '第一句。 第二句。 第三句。');
  assert.equal(translated.map(blockSourceText).join(' '), 'First sentence. Second sentence. Third sentence. Fourth sentence.');
});

test('Compact display grouping is presentation-only and preserves identical source text', () => {
  const source = units([
    ['a', 'One short sentence.', '一句。'],
    ['b', 'Another short sentence.', '另一句。'],
    ['c', 'A final sentence.', '最后一句。'],
  ]);
  const blocks = groupRawDisplayBlocks(source, '', []);
  assert.equal(blocks.map(blockSourceText).join(' '), source.map((item) => item.sourceText).join(' '));
  assert.equal(blocks.flatMap((block) => block.segments).length, source.length);
  assert.equal(source.map((item) => item.sourceText).join(' '), 'One short sentence. Another short sentence. A final sentence.');
});

test('translation status churn and stale retries do not change finalized display blocks', () => {
  const source = units([
    ['a', 'The first idea is complete.', '第一点已完成。'],
    ['b', 'The second idea is also complete.', '第二点也完成了。'],
    ['c', 'The trailing idea is still arriving.'],
  ]);
  const initial = groupRawDisplayBlocks(source, '', []);
  initial[0].finalized = true;
  const retrying = source.map((item, index) => ({
    ...item,
    translatedText: index === 0 ? '' : item.translatedText,
    status: index === 0 ? 'error' : item.status,
  }));
  const updated = groupRawDisplayBlocks(retrying, 'and the sentence continues', initial);
  assert.equal(updated[0].id, initial[0].id);
  assert.equal(updated.map(blockSourceText).join(' ').trim(), source.map((item) => item.sourceText).join(' '));
  assert.equal(updated.at(-1).pendingText, 'and the sentence continues');
});

test('Raw alignment units keep unequal source and translation content in one ordered pair sequence', () => {
  const longSource = Array.from({ length: 80 }, (_, index) => `source${index}`).join(' ');
  const longTranslation = Array.from({ length: 90 }, (_, index) => `译文${index}`).join('');
  const blocks = groupRawDisplayBlocks(units([
    ['a', longSource, '短译文。'],
    ['b', 'Short source.', longTranslation],
  ]), '', [], { semanticGroups: [['a'], ['b']] });
  const aligned = buildRawAlignmentUnits(blocks);

  assert.deepEqual(aligned.map((unit) => unit.id), blocks.map((block) => block.id));
  assert.equal(aligned[0].sourceText, longSource);
  assert.equal(aligned[0].translatedText, '短译文。');
  assert.equal(aligned[1].sourceText, 'Short source.');
  assert.equal(aligned[1].translatedText, longTranslation);
  assert.equal(aligned.map((unit) => unit.translatedText).join(''), `短译文。${longTranslation}`);
});

test('an asynchronous translation update preserves alignment IDs and changes only its matching row', () => {
  const source = units([
    ['a', 'First source sentence.'],
    ['b', 'Second source sentence.'],
  ]);
  const initialBlocks = groupRawDisplayBlocks(source, '', [], { semanticGroups: [['a'], ['b']] });
  initialBlocks[0].finalized = true;
  const initial = buildRawAlignmentUnits(initialBlocks);
  const translatedBlocks = groupRawDisplayBlocks(source.map((unit, index) => ({
    ...unit,
    translatedText: index === 1 ? '只更新第二行。' : '',
    status: index === 1 ? 'translated' : 'pending',
  })), '', initialBlocks, { semanticGroups: [['a'], ['b']] });
  const translated = buildRawAlignmentUnits(translatedBlocks);

  assert.deepEqual(translated.map((unit) => unit.id), initial.map((unit) => unit.id));
  assert.equal(translated[0].translatedText, '');
  assert.equal(translated[1].translatedText, '只更新第二行。');
  assert.deepEqual(translated.map((unit) => unit.sourceText), initial.map((unit) => unit.sourceText));
});

test('a revised source keeps its previous translation visible while replacement is pending', () => {
  const aligned = buildRawAlignmentUnits(groupRawDisplayBlocks([{
    id: 'stable-segment',
    sourceText: 'Revised source sentence.',
    sourceRevision: 'revision-2',
    translatedText: '上一版译文。',
    translatedRevision: 'revision-1',
    status: 'updating',
  }]));

  assert.equal(aligned[0].sourceText, 'Revised source sentence.');
  assert.equal(aligned[0].translatedText, '上一版译文。');
  assert.equal(aligned[0].status, 'partial');
});

test('persisted and pending Raw data remain compatible with alignment units', () => {
  const aligned = buildRawAlignmentUnits([{
    id: 'persisted-block',
    segmentIds: ['persisted-unit'],
    segments: [{ id: 'persisted-unit', sourceText: 'Saved source.', translatedText: '已保存译文。', status: 'translated' }],
    finalized: true,
  }, {
    id: 'live-tail',
    segmentIds: [],
    segments: [],
    pendingText: 'Interim speech',
    finalized: false,
  }]);

  assert.deepEqual(aligned.map(({ id, sourceText, translatedText, status }) => ({ id, sourceText, translatedText, status })), [{
    id: 'persisted-block', sourceText: 'Saved source.', translatedText: '已保存译文。', status: 'translated',
  }, {
    id: 'live-tail', sourceText: 'Interim speech', translatedText: '', status: 'pending',
  }]);
});

test('a provisional tail shows its immediate translation and keeps it visible while source text grows', () => {
  const translatedTail = {
    id: 'pending-unit', sourceText: 'Interim speech', translatedText: '临时语音',
    previousTranslatedText: '', status: 'translated',
  };
  const initialBlocks = groupRawDisplayBlocks([], 'Interim speech', [], { pendingTranslation: translatedTail });
  const initial = buildRawAlignmentUnits(initialBlocks);
  assert.deepEqual(initial.map(({ id, sourceText, displayTranslatedText, status }) => ({ id, sourceText, displayTranslatedText, status })), [{
    id: 'pending-unit', sourceText: 'Interim speech', displayTranslatedText: '临时语音', status: 'translated',
  }]);

  const refreshingTail = {
    ...translatedTail,
    sourceText: 'Interim speech continues',
    translatedText: '',
    previousTranslatedText: '临时语音',
    status: 'pending',
  };
  const updated = buildRawAlignmentUnits(groupRawDisplayBlocks([], 'Interim speech continues', initialBlocks, {
    pendingTranslation: refreshingTail,
  }));
  assert.equal(updated[0].id, initial[0].id);
  assert.equal(updated[0].sourceText, 'Interim speech continues');
  assert.equal(updated[0].displayTranslatedText, '临时语音');
  assert.equal(updated[0].hasPreviousTranslation, true);
  assert.equal(updated[0].status, 'pending');
});

test('Raw alignment keeps the previous translation visible while its source is revised', () => {
  const aligned = buildRawAlignmentUnits([{
    id: 'revising-block',
    segmentIds: ['revising-unit'],
    segments: [{
      id: 'revising-unit', sourceText: 'Corrected source.', translatedText: '',
      previousTranslatedText: '先前的译文。', status: 'pending',
    }],
    finalized: true,
  }]);

  assert.equal(aligned[0].translatedText, '');
  assert.equal(aligned[0].displayTranslatedText, '先前的译文。');
  assert.equal(aligned[0].hasPreviousTranslation, true);
  assert.equal(aligned[0].status, 'pending');
});

test('an interim tail becoming final stays in the same alignment row', () => {
  const interimBlocks = groupRawDisplayBlocks(units([
    ['a', 'Stable opening.', '稳定开头。'],
  ]), 'interim tail', []);
  const interim = buildRawAlignmentUnits(interimBlocks);
  const finalBlocks = groupRawDisplayBlocks(units([
    ['a', 'Stable opening.', '稳定开头。'],
    ['b', 'Interim tail is now final.', '临时内容现已完成。'],
  ]), '', interimBlocks);
  const final = buildRawAlignmentUnits(finalBlocks);

  assert.equal(final[0].id, interim[0].id);
  assert.equal(interim[0].sourceText, 'Stable opening. interim tail');
  assert.equal(final[0].sourceText, 'Stable opening. Interim tail is now final.');
  assert.equal(final[0].translatedText, '稳定开头。 临时内容现已完成。');
});

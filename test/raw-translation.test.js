import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleRawUnits, rawTranslationContext, rawTranslationPrompt } from '../src/raw-translation.js';

test('partial Whisper text remains structurally provisional but is immediately translatable', () => {
  const assembled = assembleRawUnits("Today we're going to talk about");
  assert.equal(assembled.segments.length, 0);
  assert.equal(assembled.pendingText, "Today we're going to talk about");
  assert.equal(assembled.pendingTranslation.sourceText, "Today we're going to talk about");
  assert.equal(assembled.pendingTranslation.status, 'pending');
  assert.equal(assembled.status, 'partial');
});

test('continuation completes one stable sentence without translating the earlier partial separately', () => {
  const partial = assembleRawUnits("Today we're going to talk about");
  const completed = assembleRawUnits("Today we're going to talk about operating systems.", partial, {
    sourceSegments: [
      { text: "Today we're going to talk about", timelineStart: 0, timelineEnd: 4 },
      { text: 'operating systems.', timelineStart: 4, timelineEnd: 6 },
    ],
  });
  assert.equal(completed.segments.length, 1);
  assert.equal(completed.segments[0].sourceText, "Today we're going to talk about operating systems.");
  assert.equal(completed.segments[0].startTime, 0);
  assert.equal(completed.segments[0].endTime, 6);
  assert.equal(completed.pendingText, '');
  assert.equal(completed.pendingTranslation, null);
});

test('a growing provisional tail keeps its last translation visible until the refresh completes', () => {
  const first = assembleRawUnits('A provisional thought');
  first.pendingTranslation.translatedText = '一个临时想法';
  first.pendingTranslation.status = 'translated';

  const grown = assembleRawUnits('A provisional thought with more detail', first);
  assert.equal(grown.pendingTranslation.id, first.pendingTranslation.id);
  assert.equal(grown.pendingTranslation.translatedText, '');
  assert.equal(grown.pendingTranslation.previousTranslatedText, '一个临时想法');
  assert.equal(grown.pendingTranslation.status, 'pending');

  const completed = assembleRawUnits('A provisional thought with more detail.', grown);
  assert.equal(completed.segments[0].id, first.pendingTranslation.id);
  assert.equal(completed.segments[0].previousTranslatedText, '一个临时想法');
  assert.equal(completed.pendingTranslation, null);
});

test('stable identities survive corrections while the last translation remains available during revision', () => {
  const initial = assembleRawUnits('First sentence.');
  initial.segments[0].translatedText = '第一句。';
  initial.segments[0].status = 'translated';
  const appended = assembleRawUnits('First sentence. Second sentence.', initial);
  assert.equal(appended.segments[0].id, initial.segments[0].id);
  assert.equal(appended.segments[0].translatedText, '第一句。');
  assert.equal(appended.segments[1].status, 'pending');

  const corrected = assembleRawUnits('Corrected first sentence. Second sentence.', appended);
  assert.equal(corrected.segments[0].id, initial.segments[0].id);
  assert.equal(corrected.segments[0].translatedText, '第一句。');
  assert.equal(corrected.segments[0].translatedRevision, initial.segments[0].sourceRevision);
  assert.equal(corrected.segments[0].status, 'updating');
  assert.notEqual(corrected.segments[0].sourceRevision, initial.segments[0].sourceRevision);

  const correctedAgain = assembleRawUnits('Revised first sentence. Second sentence.', corrected);
  assert.equal(correctedAgain.segments[0].translatedText, '第一句。');
});

test('inserting a sentence does not steal stable IDs from unchanged later units', () => {
  const initial = assembleRawUnits('Alpha. Beta.');
  initial.segments[0].translatedText = '甲。';
  initial.segments[0].status = 'translated';
  initial.segments[1].translatedText = '乙。';
  initial.segments[1].status = 'translated';

  const inserted = assembleRawUnits('New introduction. Alpha. Beta.', initial);
  assert.notEqual(inserted.segments[0].id, initial.segments[0].id);
  assert.equal(inserted.segments[1].id, initial.segments[0].id);
  assert.equal(inserted.segments[1].translatedText, '甲。');
  assert.equal(inserted.segments[2].id, initial.segments[1].id);
  assert.equal(inserted.segments[2].translatedText, '乙。');
});

test('Chinese sentence boundaries work without whitespace and a final tail is committed only at finalization', () => {
  const live = assembleRawUnits('第一句。第二句还没有结束');
  assert.deepEqual(live.segments.map((segment) => segment.sourceText), ['第一句。']);
  assert.equal(live.pendingText, '第二句还没有结束');
  const final = assembleRawUnits('第一句。第二句还没有结束', live, { finalizeTail: true });
  assert.deepEqual(final.segments.map((segment) => segment.sourceText), ['第一句。', '第二句还没有结束']);
  assert.equal(final.pendingText, '');
});

test('live translation context contains preceding sentences but the prompt identifies only the current target', () => {
  const assembled = assembleRawUnits('One. Two. Three. Four.');
  const context = rawTranslationContext(assembled.segments, 3);
  assert.deepEqual(context, ['One.', 'Two.', 'Three.']);
  const prompt = rawTranslationPrompt({ sourceText: 'Four.', context, targetLanguage: 'Japanese' });
  assert.match(prompt, /PRECEDING CONTEXT[\s\S]*One\. Two\. Three\./);
  assert.match(prompt, /CURRENT SENTENCE:\nFour\.$/);
  assert.doesNotMatch(prompt, /CURRENT SENTENCE:\nOne\./);
});

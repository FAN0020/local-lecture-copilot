import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileStorageAdapter } from '../src/storage.js';
import { SessionStore } from '../src/store.js';
import { fingerprint } from '../src/lib.js';
import { CORRECTION_REVISION, correctionMaterialsFingerprint } from '../src/conservative-correction.js';
import { assembleRawUnits } from '../src/raw-translation.js';

test('raw transcript preserves its original and revision history', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-store-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const session = await store.create({ title: 'History' });
  assert.equal(session.sttModel, 'base');
  await store.setArtifact(session.id, 'rawTranscript', { content: 'Original words', source: 'transcription' }, { preserve: true });
  await store.setArtifact(session.id, 'rawTranscript', { content: 'Corrected words', source: 'manual-edit' }, { preserve: true });
  const restored = await store.get(session.id);
  assert.equal(restored.artifacts.rawTranscript.content, 'Corrected words');
  assert.equal(restored.artifacts.rawTranscript.originalContent, 'Original words');
  assert.equal(restored.artifacts.rawTranscript.revisions.length, 1);
  assert.equal(restored.artifacts.rawTranscript.revisions[0].content, 'Original words');
});

test('running processing state is made recoverable after restart', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-restart-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = new SessionStore(root);
  await first.init();
  const session = await first.create();
  await first.processing(session.id, { stage: 'notes', status: 'running', message: 'Working' });
  const restarted = new SessionStore(root);
  await restarted.init();
  const restored = await restarted.get(session.id);
  assert.equal(restored.processing.status, 'error');
  assert.match(restored.processing.message, /rerun/i);
});

test('restart migrates old automatically queued Raw revisions to manual deferred work', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-revision-migration-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = new SessionStore(root);
  await first.init();
  const session = await first.create();
  session.transcriptSegments = [{
    id: 'legacy-segment',
    hasSpeech: true,
    versions: { provisional: { content: 'Saved draft.' } },
    stages: {
      provisional: { status: 'complete', attempt: 1, token: null },
      revised: { status: 'pending', attempt: 0, token: null },
      highQuality: { status: 'skipped', attempt: 0, token: null },
    },
  }];
  session.asr = { mode: 'rag-revision', status: 'background' };
  await first.save(session);

  const restarted = new SessionStore(root);
  await restarted.init();
  const restored = await restarted.get(session.id);
  assert.equal(restored.transcriptSegments[0].stages.revised.status, 'deferred');
  assert.deepEqual(restored.asr.backlog.refinement, { queued: 0, active: 0, total: 0 });
});

test('interrupted Cleaned generation remains recoverable and keeps completed regions after restart', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-cleanup-restart-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = new SessionStore(root);
  await first.init();
  const session = await first.create();
  await first.setArtifact(session.id, 'rawTranscript', { content: 'First sentence. Second sentence.', source: 'manual-edit' }, { preserve: true });
  await first.setArtifact(session.id, 'cleanedTranscript', {
    content: 'First sentence.', source: 'cleanup', generationState: 'running',
    regions: [{ sourceText: 'First sentence.', cleanedText: 'First sentence.', status: 'complete' }],
  });
  const restarted = new SessionStore(root);
  await restarted.init();
  const restored = await restarted.get(session.id);
  assert.equal(restored.artifacts.cleanedTranscript.generationState, 'error');
  assert.equal(restored.artifacts.cleanedTranscript.regions.length, 1);
  assert.match(restored.artifacts.cleanedTranscript.interruptionReason, /reused safely/i);
});

test('interrupted Raw translation becomes retryable after restart without losing translated units', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-translation-restart-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = new SessionStore(root);
  await first.init();
  const session = await first.create({ targetLanguage: 'Chinese' });
  await first.setArtifact(session.id, 'rawTranscript', { content: 'One. Two.', source: 'manual-edit' }, { preserve: true });
  const rawFingerprint = (await first.get(session.id)).artifacts.rawTranscript.contentFingerprint;
  await first.saveRawTranslation(session.id, {
    targetLanguage: 'Chinese',
    generationState: 'running',
    segments: [
      { id: 'one', sourceText: 'One.', sourceRevision: 'r1', translatedText: '一。', status: 'translated' },
      { id: 'two', sourceText: 'Two.', sourceRevision: 'r2', translatedText: '', status: 'translating' },
    ],
  }, { expectedSourceFingerprint: rawFingerprint, expectedTargetLanguage: 'Chinese' });

  const restarted = new SessionStore(root);
  await restarted.init();
  const restored = await restarted.get(session.id);
  assert.equal(restored.artifacts.rawTranslation.generationState, 'error');
  assert.equal(restored.artifacts.rawTranslation.segments[0].translatedText, '一。');
  assert.equal(restored.artifacts.rawTranslation.segments[1].status, 'error');
  assert.match(restored.artifacts.rawTranslation.segments[1].error, /interrupted/i);
});

test('an interrupted provisional-tail translation becomes retryable after restart', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-tail-translation-restart-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = new SessionStore(root);
  await first.init();
  const session = await first.create({ targetLanguage: 'Chinese' });
  await first.setArtifact(session.id, 'rawTranscript', { content: 'An unfinished thought', source: 'manual-edit' }, { preserve: true });
  const current = await first.get(session.id);
  const assembled = assembleRawUnits(current.artifacts.rawTranscript.content, null, { targetLanguage: 'Chinese' });
  assembled.pendingTranslation.status = 'translating';
  await first.saveRawTranslation(session.id, { ...assembled, generationState: 'running' }, {
    expectedSourceFingerprint: current.artifacts.rawTranscript.contentFingerprint,
    expectedTargetLanguage: 'Chinese',
  });

  const restarted = new SessionStore(root);
  await restarted.init();
  const restored = await restarted.get(session.id);
  assert.equal(restored.artifacts.rawTranslation.generationState, 'error');
  assert.equal(restored.artifacts.rawTranslation.pendingTranslation.status, 'error');
  assert.match(restored.artifacts.rawTranslation.pendingTranslation.error, /interrupted/i);
});

test('a changed Raw sentence retains its previous translation while the replacement is pending', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-translation-revision-display-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const session = await store.create({ targetLanguage: 'Chinese' });
  await store.setArtifact(session.id, 'rawTranscript', { content: 'Draft sentence.', source: 'manual-edit' }, { preserve: true });
  await store.saveRawTranslation(session.id, {
    targetLanguage: 'Chinese',
    segments: [{
      id: 'draft-unit', sourceText: 'Draft sentence.', sourceRevision: fingerprint('Draft sentence.'),
      translatedText: '草稿译文。', status: 'translated',
    }],
  });

  await store.setArtifact(session.id, 'rawTranscript', { content: 'Revised sentence.', source: 'manual-edit' }, { preserve: true });
  const restored = await store.get(session.id);
  assert.equal(restored.artifacts.rawTranslation.stale, true);
  assert.equal(restored.artifacts.rawTranslation.sourceFingerprint, fingerprint('Revised sentence.'));
  assert.equal(restored.artifacts.rawTranslation.segments[0].sourceText, 'Revised sentence.');
  assert.equal(restored.artifacts.rawTranslation.segments[0].translatedText, '草稿译文。');
  assert.equal(restored.artifacts.rawTranslation.segments[0].translatedRevision, fingerprint('Draft sentence.'));
  assert.equal(restored.artifacts.rawTranslation.segments[0].status, 'updating');
});

test('unchanged Raw translation snapshots are not rewritten to session storage', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-translation-dedupe-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const session = await store.create({ targetLanguage: 'Chinese' });
  await store.setArtifact(session.id, 'rawTranscript', { content: 'One sentence.', source: 'manual-edit' }, { preserve: true });
  let writes = 0;
  const originalSave = store.save.bind(store);
  store.save = async (value) => { writes += 1; return originalSave(value); };
  const value = {
    targetLanguage: 'Chinese',
    generationState: 'idle',
    segments: [{ id: 'one', sourceText: 'One sentence.', sourceRevision: 'one', translatedText: '一句。', status: 'translated' }],
  };
  await store.saveRawTranslation(session.id, value, { expectedTargetLanguage: 'Chinese' });
  await store.saveRawTranslation(session.id, value, { expectedTargetLanguage: 'Chinese' });
  assert.equal(writes, 1);
});

test('interrupted document translations recover as retryable without losing source or the previous valid output', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-document-interruption-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = new SessionStore(root);
  await first.init();
  const cases = [
    ['cleaned-translation', 'cleanedTranscript', 'cleanedTranslation', 'Cleaned source v1.', 'Cleaned source v2.', 'Previous cleaned translation.'],
    ['notes-translation', 'notes', 'notesTranslation', '# Notes v1', '# Notes v2', '# Previous notes translation'],
    ['outline-translation', 'outline', 'outlineTranslation', '# Outline v1', '# Outline v2', '# Previous outline translation'],
  ];

  const sessionIds = [];
  for (const [stage, sourceKey, translationKey, firstSource, latestSource, translated] of cases) {
    const session = await first.create({ targetLanguage: 'Chinese' });
    sessionIds.push(session.id);
    if (sourceKey === 'cleanedTranscript') {
      await first.setArtifact(session.id, 'rawTranscript', { content: 'Raw source.', source: 'manual-edit' }, { preserve: true });
    }
    await first.setArtifact(session.id, sourceKey, { content: firstSource, source: 'manual-edit' });
    await first.setArtifact(session.id, translationKey, { content: translated, source: 'manual-edit', targetLanguage: 'Chinese' });
    await first.setArtifact(session.id, sourceKey, { content: latestSource, source: 'manual-edit' });
    await first.processing(session.id, { stage, status: 'running', message: 'Translating…', startedAt: new Date().toISOString() });
  }

  const restarted = new SessionStore(root);
  await restarted.init();
  for (const [index, [, sourceKey, translationKey, , latestSource, translated]] of cases.entries()) {
    const restored = await restarted.get(sessionIds[index]);
    assert.equal(restored.processing.status, 'error');
    assert.match(restored.processing.message, /rerun/i);
    assert.equal(restored.artifacts[sourceKey].content, latestSource);
    assert.equal(restored.artifacts[translationKey].content, translated);
    assert.equal(restored.artifacts[translationKey].stale, true);
  }
});

test('translation artifacts persist when the workspace path contains spaces and non-ASCII characters', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-unicode-workspace-test-'));
  const root = path.join(base, '课程 工作区');
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const first = new SessionStore(root);
  await first.init();
  const session = await first.create({ title: '路径测试', targetLanguage: 'Japanese' });
  await first.setArtifact(session.id, 'rawTranscript', { content: 'Source sentence.', source: 'manual-edit' }, { preserve: true });
  await first.setArtifact(session.id, 'notes', { content: '# Notes', source: 'manual-edit' });
  await first.setArtifact(session.id, 'notesTranslation', { content: '# ノート', source: 'manual-edit', targetLanguage: 'Japanese' });

  const restarted = new SessionStore(root);
  await restarted.init();
  const restored = await restarted.get(session.id);
  assert.equal(restored.title, '路径测试');
  assert.equal(restored.artifacts.notesTranslation.content, '# ノート');
  assert.equal(restored.artifacts.notesTranslation.targetLanguage, 'Japanese');
});

test('artifact-specific changes invalidate only their corresponding translations', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-translation-invalidation-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const session = await store.create({ targetLanguage: 'Chinese' });
  await store.setArtifact(session.id, 'rawTranscript', { content: 'Raw sentence.', source: 'manual-edit' }, { preserve: true });
  await store.setArtifact(session.id, 'cleanedTranscript', { content: 'Cleaned sentence.', source: 'manual-edit' });
  await store.setArtifact(session.id, 'notes', { content: '# Notes\n- Point', source: 'manual-edit' });
  await store.setArtifact(session.id, 'outline', { content: '# Outline\n  - Child', source: 'manual-edit' });
  for (const [key, content] of [
    ['cleanedTranslation', '清理。'],
    ['notesTranslation', '# 笔记\n- 要点'],
    ['outlineTranslation', '# 大纲\n  - 子项'],
  ]) {
    await store.setArtifact(session.id, key, { content, source: 'manual-edit', targetLanguage: 'Chinese' });
  }

  await store.setArtifact(session.id, 'notes', { content: '# Updated notes\n- New point', source: 'manual-edit' });
  let restored = await store.get(session.id);
  assert.equal(restored.artifacts.notesTranslation.stale, true);
  assert.equal(restored.artifacts.cleanedTranslation.stale, false);
  assert.equal(restored.artifacts.outlineTranslation.stale, false);

  await store.setArtifact(session.id, 'outline', { content: '# Updated outline\n  - New child', source: 'manual-edit' });
  restored = await store.get(session.id);
  assert.equal(restored.artifacts.outlineTranslation.stale, true);
  assert.equal(restored.artifacts.cleanedTranslation.stale, false);
});

test('a generated translation cannot overwrite a newer source revision', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-stale-result-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const session = await store.create({ targetLanguage: 'Chinese' });
  await store.setArtifact(session.id, 'rawTranscript', { content: 'Raw.', source: 'manual-edit' }, { preserve: true });
  await store.setArtifact(session.id, 'cleanedTranscript', { content: 'Cleaned old.', source: 'manual-edit' });
  const snapshot = await store.get(session.id);
  const dependency = store.dependencyFor(snapshot, 'cleanedTranslation');
  await store.setArtifact(session.id, 'cleanedTranscript', { content: 'Cleaned new.', source: 'manual-edit' });

  await assert.rejects(() => store.setArtifact(session.id, 'cleanedTranslation', {
    content: 'Stale translated output',
    source: 'cleaned-translation',
    targetLanguage: 'Chinese',
    dependsOn: dependency,
  }), (error) => error.code === 'STALE_RESULT');
  const restored = await store.get(session.id);
  assert.equal(restored.artifacts.cleanedTranscript.content, 'Cleaned new.');
  assert.equal(restored.artifacts.cleanedTranslation, null);
});

test('target-language changes invalidate every translation while unrelated metadata does not', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-target-invalidation-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const session = await store.create({ targetLanguage: 'Chinese' });
  await store.setArtifact(session.id, 'rawTranscript', { content: 'Raw.', source: 'manual-edit' }, { preserve: true });
  await store.setArtifact(session.id, 'cleanedTranscript', { content: 'Cleaned.', source: 'manual-edit' });
  await store.setArtifact(session.id, 'notes', { content: '# Notes', source: 'manual-edit' });
  await store.setArtifact(session.id, 'outline', { content: '# Outline', source: 'manual-edit' });
  await store.saveRawTranslation(session.id, {
    targetLanguage: 'Chinese',
    segments: [{ id: 'raw', sourceText: 'Raw.', sourceRevision: 'raw', translatedText: '原始。', status: 'translated' }],
  }, { expectedTargetLanguage: 'Chinese' });
  for (const key of ['cleanedTranslation', 'notesTranslation', 'outlineTranslation']) {
    await store.setArtifact(session.id, key, { content: `${key} Chinese`, source: 'manual-edit', targetLanguage: 'Chinese' });
  }

  await store.updateMeta(session.id, { title: 'Renamed', language: 'en', llmModel: 'another-model' });
  let restored = await store.get(session.id);
  assert.equal(['rawTranslation', 'cleanedTranslation', 'notesTranslation', 'outlineTranslation'].every((key) => !restored.artifacts[key].stale), true);

  await store.updateMeta(session.id, { targetLanguage: 'Japanese' });
  restored = await store.get(session.id);
  assert.equal(['rawTranslation', 'cleanedTranslation', 'notesTranslation', 'outlineTranslation'].every((key) => restored.artifacts[key].stale), true);
});

test('legacy sessions with one Translation artifact migrate to Cleaned Translation and still open', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-translation-legacy-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const session = await store.create();
  const legacy = await store.get(session.id);
  legacy.schemaVersion = 1;
  delete legacy.artifacts.rawTranslation;
  delete legacy.artifacts.cleanedTranslation;
  delete legacy.artifacts.notesTranslation;
  delete legacy.artifacts.outlineTranslation;
  legacy.artifacts.translation = { content: 'Legacy translation', targetLanguage: legacy.targetLanguage };
  await store.save(legacy);

  const restarted = new SessionStore(root);
  await restarted.init();
  const restored = await restarted.get(session.id);
  assert.equal(restored.artifacts.cleanedTranslation.content, 'Legacy translation');
  assert.equal(restored.artifacts.cleanedTranslation.sourceArtifact, 'cleanedTranscript');
  assert.equal(restored.artifacts.notesTranslation, null);
});

test('concurrent artifact writes to one session do not lose outputs', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-concurrency-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const session = await store.create();
  await Promise.all([
    store.setArtifact(session.id, 'cleanedTranslation', { content: 'Translation', source: 'cleaned-translation' }),
    store.setArtifact(session.id, 'keyPoints', { content: 'Key points', source: 'key-points' }),
    store.setArtifact(session.id, 'qa', { content: 'Questions', source: 'qa' }),
    store.setArtifact(session.id, 'structuredAnalysis', { content: 'Analysis', source: 'analysis' }),
  ]);
  const restored = await store.get(session.id);
  assert.equal(restored.artifacts.cleanedTranslation.content, 'Translation');
  assert.equal(restored.artifacts.keyPoints.content, 'Key points');
  assert.equal(restored.artifacts.qa.content, 'Questions');
  assert.equal(restored.artifacts.structuredAnalysis.content, 'Analysis');
});

test('deleting a session removes its complete directory and every associated local file', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-delete-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const session = await store.create({ title: 'Delete everything', language: 'en' });
  await store.saveUpload(session.id, 'audio', 'lecture.wav', Buffer.from('audio bytes'), 'audio/wav');
  await store.saveUpload(session.id, 'material', 'slides.md', Buffer.from('# Slides'), 'text/markdown');
  for (const key of ['rawTranscript', 'rawTranslation', 'cleanedTranscript', 'cleanedTranslation', 'translation', 'keyPoints', 'qa', 'structuredAnalysis', 'notes', 'notesTranslation', 'outline', 'outlineTranslation']) {
    await store.setArtifact(session.id, key, { content: `${key} content`, source: 'test' }, { preserve: key === 'rawTranscript' });
  }
  const sessionDir = store.dir(session.id);
  await store.storage.writeFile(path.join(sessionDir, 'generated', 'study-guide.md'), '# Generated');
  await store.storage.writeFile(path.join(sessionDir, 'temporary', 'in-progress.tmp'), 'temporary');
  await store.storage.writeFile(path.join(sessionDir, 'recovery', 'session.json.bak'), 'recovery');

  const deleted = await store.deleteSession(session.id);
  assert.equal(deleted.id, session.id);
  await assert.rejects(() => fs.access(sessionDir), (error) => error.code === 'ENOENT');
  assert.equal((await store.list()).some((item) => item.id === session.id), false);
});

test('a filesystem deletion failure is reported without removing the session entry or files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-delete-failure-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  class FailingRemovalStorage extends FileStorageAdapter {
    async rm() {
      throw Object.assign(new Error('Permission denied while deleting session files'), { code: 'EACCES' });
    }
  }
  const store = new SessionStore(new FailingRemovalStorage(root));
  await store.init();
  const session = await store.create({ title: 'Must remain' });
  await store.saveUpload(session.id, 'audio', 'protected.wav', Buffer.from('protected audio'), 'audio/wav');

  await assert.rejects(() => store.deleteSession(session.id), /permission denied/i);
  const restored = await store.get(session.id);
  assert.equal(restored.title, 'Must remain');
  assert.equal((await store.list()).some((item) => item.id === session.id), true);
  assert.equal(await store.storage.readFile(restored.audio.storedPath, 'utf8'), 'protected audio');
});

const aug27 = { automaticTitle: { date: '2026-08-27', label: 'Aug 27' } };

test('automatic titles use stable same-day indexes stored with each session', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-title-index-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();

  const sessions = await Promise.all([store.create(aug27), store.create(aug27), store.create(aug27)]);

  assert.deepEqual(sessions.map((session) => session.title), [
    'Lecture — Aug 27 — 1',
    'Lecture — Aug 27 — 2',
    'Lecture — Aug 27 — 3',
  ]);
  assert.deepEqual(sessions.map((session) => session.automaticTitle.index), [1, 2, 3]);
  assert.equal(sessions.every((session) => session.titleSource === 'automatic'), true);
});

test('deleting an automatic session does not renumber or reuse its index', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-title-delete-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const first = await store.create(aug27);
  const second = await store.create(aug27);

  await store.deleteSession(second.id);
  const restarted = new SessionStore(root);
  await restarted.init();
  const third = await restarted.create(aug27);

  assert.equal((await restarted.get(first.id)).title, 'Lecture — Aug 27 — 1');
  assert.equal(third.title, 'Lecture — Aug 27 — 3');
});

test('automatic title indexes survive a complete store restart', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-title-restart-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const firstStore = new SessionStore(root);
  await firstStore.init();
  const first = await firstStore.create(aug27);

  const restarted = new SessionStore(root);
  await restarted.init();
  const second = await restarted.create(aug27);

  assert.equal((await restarted.get(first.id)).title, 'Lecture — Aug 27 — 1');
  assert.equal(second.title, 'Lecture — Aug 27 — 2');
});

test('legacy sessions without automatic-title metadata remain unchanged and seed the next index', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-title-legacy-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const legacy = await store.create({ title: 'Lecture — Aug 27' });
  legacy.createdAt = '2026-08-27T01:00:00.000Z';
  delete legacy.titleSource;
  delete legacy.automaticTitle;
  await store.save(legacy);

  const created = await store.create(aug27);

  assert.equal((await store.get(legacy.id)).title, 'Lecture — Aug 27');
  assert.equal(created.title, 'Lecture — Aug 27 — 2');
});

test('automatic title indexes are independent per date and custom titles are preserved', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-title-dates-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const first = await store.create(aug27);
  await store.updateMeta(first.id, { title: 'Probability review' });
  const nextDate = await store.create({ automaticTitle: { date: '2026-08-28', label: 'Aug 28' } });
  const second = await store.create(aug27);

  assert.equal((await store.get(first.id)).title, 'Probability review');
  assert.equal((await store.get(first.id)).titleSource, 'custom');
  assert.equal(nextDate.title, 'Lecture — Aug 28 — 1');
  assert.equal(second.title, 'Lecture — Aug 27 — 2');
});

async function correctionStore(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-correction-metadata-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const session = await store.create({ targetLanguage: 'Chinese' });
  await store.setArtifact(session.id, 'rawTranscript', { content: 'The prior combines with observed evidence.', source: 'transcription' });
  return { store, sessionId: session.id };
}

function correctionSnapshot(store, session, content = 'The prior combines with observed evidence.') {
  return {
    content, source: 'cleanup', pipelineRevision: CORRECTION_REVISION,
    materialContextFingerprint: correctionMaterialsFingerprint(session.materials),
    cleanupBaseSource: session.artifacts.cleanedTranscript?.source,
    cleanupBaseFingerprint: fingerprint(session.artifacts.cleanedTranscript?.content || ''),
    dependsOn: store.dependencyFor(session, 'cleanedTranscript'), generationState: 'complete',
  };
}

async function saveCorrectionGraph(store, sessionId) {
  const snapshot = await store.get(sessionId);
  await store.setArtifact(sessionId, 'cleanedTranscript', correctionSnapshot(store, snapshot));
  for (const key of ['cleanedTranslation', 'translation', 'keyPoints', 'qa', 'structuredAnalysis', 'notes', 'outline', 'notesTranslation', 'outlineTranslation']) {
    await store.setArtifact(sessionId, key, { content: `${key} generated output`, source: key, targetLanguage: 'Chinese' });
  }
}

test('cleanup validity requires the current correction revision and exact material snapshot', async (t) => {
  const { store, sessionId } = await correctionStore(t);
  const session = await store.get(sessionId);
  const current = correctionSnapshot(store, session);
  session.artifacts.cleanedTranscript = { ...current, pipelineRevision: undefined };
  assert.equal(store.artifactIsValid(session, 'cleanedTranscript'), false, 'existing C1 output must regenerate');
  session.artifacts.cleanedTranscript = { ...current, pipelineRevision: 'C1' };
  assert.equal(store.artifactIsValid(session, 'cleanedTranscript'), false);
  session.artifacts.cleanedTranscript = { ...current, materialContextFingerprint: undefined };
  assert.equal(store.artifactIsValid(session, 'cleanedTranscript'), false, 'untracked material provenance is not current');
  session.artifacts.cleanedTranscript = current;
  assert.equal(store.artifactIsValid(session, 'cleanedTranscript'), true);
  session.materials.push({ id: 'new', filename: 'new.md', extractedText: 'New evidence.' });
  assert.equal(store.artifactIsValid(session, 'cleanedTranscript'), false, 'even an unmarked material edit invalidates cached output');
  session.artifacts.cleanedTranscript = { ...current, source: 'manual-edit' };
  assert.equal(store.artifactIsValid(session, 'cleanedTranscript'), true, 'manual wording remains authoritative');
});

test('material upload, extraction, and deletion invalidate cleanup and every generated dependent', async (t) => {
  const { store, sessionId } = await correctionStore(t);
  await saveCorrectionGraph(store, sessionId);
  const original = await store.get(sessionId);
  const assertInvalidated = async () => {
    const session = await store.get(sessionId);
    for (const key of ['cleanedTranscript', 'cleanedTranslation', 'translation', 'keyPoints', 'qa', 'structuredAnalysis', 'notes', 'outline', 'notesTranslation', 'outlineTranslation']) {
      assert.equal(session.artifacts[key].stale, true, `${key} must be regenerated after materials change`);
      assert.equal(session.artifacts[key].staleReason, 'Course materials changed');
    }
    assert.deepEqual(session.artifacts.rawTranscript, original.artifacts.rawTranscript);
  };
  const { record } = await store.saveUpload(sessionId, 'material', 'slides.md', Buffer.from('The posterior combines prior and evidence.'), 'text/markdown');
  await assertInvalidated();
  await saveCorrectionGraph(store, sessionId);
  await store.setMaterialExtraction(sessionId, record.id, { extractedText: 'The posterior combines prior and evidence.' });
  await assertInvalidated();
  await saveCorrectionGraph(store, sessionId);
  await store.deleteMaterial(sessionId, record.id);
  await assertInvalidated();
});

test('material invalidation stops at manual documents and preserves their unchanged dependents', async (t) => {
  const { store, sessionId } = await correctionStore(t);
  await store.setArtifact(sessionId, 'cleanedTranscript', { content: 'My corrected wording.', source: 'manual-edit' });
  await store.setArtifact(sessionId, 'notes', { content: 'My lecture notes.', source: 'manual-edit' });
  for (const key of ['cleanedTranslation', 'keyPoints', 'notesTranslation', 'outline', 'outlineTranslation']) {
    await store.setArtifact(sessionId, key, { content: `${key} generated output`, source: key, targetLanguage: 'Chinese' });
  }
  const before = await store.get(sessionId);
  await store.saveUpload(sessionId, 'material', 'slides.md', Buffer.from('Additional material.'), 'text/markdown');
  const after = await store.get(sessionId);
  for (const key of ['cleanedTranscript', 'notes', 'cleanedTranslation', 'keyPoints', 'notesTranslation']) {
    assert.deepEqual(after.artifacts[key], before.artifacts[key], `${key} has unchanged authoritative source text`);
  }
  for (const key of ['outline', 'outlineTranslation']) assert.equal(after.artifacts[key].stale, true);
});

test('stale material snapshots cannot write running progress or final cleanup results', async (t) => {
  const { store, sessionId } = await correctionStore(t);
  const { record } = await store.saveUpload(sessionId, 'material', 'slides.md', Buffer.from('Prior evidence.'), 'text/markdown');
  await store.setMaterialExtraction(sessionId, record.id, { extractedText: 'Prior evidence.' });
  await saveCorrectionGraph(store, sessionId);
  const snapshot = await store.get(sessionId);
  const pending = correctionSnapshot(store, snapshot, 'Obsolete generated content.');
  await store.setMaterialExtraction(sessionId, record.id, { extractedText: 'Updated likelihood evidence.' });
  for (const generationState of ['running', 'complete']) {
    await assert.rejects(() => store.setArtifact(sessionId, 'cleanedTranscript', { ...pending, generationState }),
      (error) => error.status === 409 && error.code === 'STALE_RESULT' && /materials changed/i.test(error.message));
  }
  let restored = await store.get(sessionId);
  assert.equal(restored.artifacts.cleanedTranscript.content, snapshot.artifacts.cleanedTranscript.content);
  assert.equal(restored.artifacts.cleanedTranscript.stale, true);
  await store.setArtifact(sessionId, 'cleanedTranscript', correctionSnapshot(store, restored, 'Fresh material correction.'));
  restored = await store.get(sessionId);
  assert.equal(store.artifactIsValid(restored, 'cleanedTranscript'), true);
});

test('cleanup rejects changed Raw source bytes and combined source/material races', async (t) => {
  for (const change of ['source', 'source-and-materials']) {
    await t.test(change, async (subtest) => {
      const { store, sessionId } = await correctionStore(subtest);
      const snapshot = await store.get(sessionId);
      const pending = correctionSnapshot(store, snapshot, 'Obsolete generated content.');
      await store.setArtifact(sessionId, 'rawTranscript', { content: 'The source wording was edited.', source: 'manual-edit' });
      if (change === 'source-and-materials') await store.saveUpload(sessionId, 'material', 'new.md', Buffer.from('New evidence.'), 'text/markdown');
      await assert.rejects(() => store.setArtifact(sessionId, 'cleanedTranscript', pending),
        (error) => error.status === 409 && error.code === 'STALE_RESULT');
      assert.equal((await store.get(sessionId)).artifacts.cleanedTranscript, null);
    });
  }
});

test('an optional high-quality comparison cannot replace or invalidate Version C Raw RAG input', async (t) => {
  const { store, sessionId } = await correctionStore(t);
  const snapshot = await store.get(sessionId);
  const pending = correctionSnapshot(store, snapshot, 'Current Raw-based correction.');
  await store.setArtifact(sessionId, 'highQualityTranscript', {
    content: 'Optional high-quality comparison.', source: 'transcription', generationState: 'complete',
  });
  const saved = await store.setArtifact(sessionId, 'cleanedTranscript', pending);
  assert.equal(saved.dependsOn.key, 'rawTranscript');
  assert.equal(store.artifactIsValid(await store.get(sessionId), 'cleanedTranscript'), true);
});

test('in-flight derived results cannot revive an artifact whose cleanup source became stale', async (t) => {
  const { store, sessionId } = await correctionStore(t);
  await saveCorrectionGraph(store, sessionId);
  const snapshot = await store.get(sessionId);
  const pending = {
    content: 'Obsolete translation.', source: 'cleaned-translation', targetLanguage: 'Chinese',
    dependsOn: store.dependencyFor(snapshot, 'cleanedTranslation'),
  };
  await store.saveUpload(sessionId, 'material', 'new.md', Buffer.from('New evidence.'), 'text/markdown');
  await assert.rejects(() => store.setArtifact(sessionId, 'cleanedTranslation', pending),
    (error) => error.status === 409 && error.code === 'STALE_RESULT');
  assert.equal((await store.get(sessionId)).artifacts.cleanedTranslation.stale, true);
});

test('a manual edit during correction is preserved against later progress and final writes', async (t) => {
  const { store, sessionId } = await correctionStore(t);
  const pending = correctionSnapshot(store, await store.get(sessionId), 'Generated content.');
  await store.setArtifact(sessionId, 'cleanedTranscript', { content: 'My chosen wording.', source: 'manual-edit' });
  for (const generationState of ['running', 'complete']) {
    await assert.rejects(() => store.setArtifact(sessionId, 'cleanedTranscript', { ...pending, generationState }),
      (error) => error.status === 409 && error.code === 'STALE_RESULT' && /manual edit/i.test(error.message));
  }
  const restored = await store.get(sessionId);
  assert.equal(restored.artifacts.cleanedTranscript.content, 'My chosen wording.');
  assert.equal(store.artifactIsValid(restored, 'cleanedTranscript'), true);
});

test('explicit regeneration can replace its original manual snapshot but not a newer manual edit', async (t) => {
  const { store, sessionId } = await correctionStore(t);
  await store.setArtifact(sessionId, 'cleanedTranscript', { content: 'My original edited wording.', source: 'manual-edit' });
  const first = correctionSnapshot(store, await store.get(sessionId), 'Explicitly regenerated wording.');
  await store.setArtifact(sessionId, 'cleanedTranscript', first);
  assert.equal((await store.get(sessionId)).artifacts.cleanedTranscript.content, first.content);

  await store.setArtifact(sessionId, 'cleanedTranscript', { content: 'My original edited wording.', source: 'manual-edit' });
  const pending = correctionSnapshot(store, await store.get(sessionId), 'A second regeneration.');
  await store.setArtifact(sessionId, 'cleanedTranscript', { content: 'My newer manual correction.', source: 'manual-edit' });
  await assert.rejects(() => store.setArtifact(sessionId, 'cleanedTranscript', pending),
    (error) => error.status === 409 && error.code === 'STALE_RESULT' && /manual edit/i.test(error.message));
  assert.equal((await store.get(sessionId)).artifacts.cleanedTranscript.content, 'My newer manual correction.');
});

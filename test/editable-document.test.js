import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionStore } from '../src/store.js';
import { mergeExternalDocument } from '../web/editable-document.js';

const indexPath = new URL('../web/index.html', import.meta.url);
const appPath = new URL('../web/app.js', import.meta.url);
const packagePath = new URL('../package.json', import.meta.url);

test('one contenteditable document surface replaces textarea and explicit edit/save modes', async () => {
  const [html, app] = await Promise.all([fs.readFile(indexPath, 'utf8'), fs.readFile(appPath, 'utf8')]);
  assert.equal((html.match(/id="artifact-editor"/g) || []).length, 1);
  assert.match(html, /id="artifact-editor"[^>]*contenteditable="true"/);
  assert.doesNotMatch(html, /<textarea[^>]*id="artifact-editor"/);
  assert.doesNotMatch(html, /id="save-button"|data-action="edit-raw"/);
  assert.match(app, /new EditableDocument/);
  assert.match(app, /setTimeout\(\(\) => \{ void flushAutosave\(\); \}, 450\)/);
});

test('localhost startup prepares Whisper and Start dictation remains actionable when setup is missing', async () => {
  const [app, packageSource] = await Promise.all([fs.readFile(appPath, 'utf8'), fs.readFile(packagePath, 'utf8')]);
  const packageJson = JSON.parse(packageSource);
  assert.equal(packageJson.scripts.prestart, 'npm run stt:prepare');
  assert.equal(packageJson.scripts.predev, 'npm run stt:prepare');
  const renderer = app.slice(app.indexOf('function renderDictationControl'), app.indexOf('function renderMaterials'));
  assert.match(renderer, /record-button'\)\.disabled = \(isProcessing && !recording\) \|\| transitioning/);
  assert.doesNotMatch(renderer, /selectedModelReady|sttReady|model.*ready/i);
  assert.match(app.slice(app.indexOf('async function toggleRecording'), app.indexOf('function updateRecordTimer')), /settings-dialog.*showModal/s);
});

test('live append merging preserves local document edits', () => {
  assert.equal(
    mergeExternalDocument('Original sentence.', 'Corrected sentence.', 'Original sentence. New confirmed speech.'),
    'Corrected sentence. New confirmed speech.',
  );
  assert.equal(
    mergeExternalDocument('Original sentence.', 'Corrected sentence. New confirmed speech.', 'Original sentence. New confirmed speech.'),
    'Corrected sentence. New confirmed speech.',
  );
});

test('manual Raw, Cleaned, Notes, and Outline edits persist across a store restart', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-inline-edit-persistence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = new SessionStore(root);
  await first.init();
  const session = await first.create({ title: 'Inline edits' });
  await first.setArtifact(session.id, 'rawTranscript', { content: 'Edited raw.', source: 'manual-edit' }, { preserve: true });
  await first.setArtifact(session.id, 'cleanedTranscript', { content: 'Edited cleaned.', source: 'manual-edit' });
  await first.setArtifact(session.id, 'notes', { content: '# Edited notes\n- Kept point', source: 'manual-edit' });
  await first.setArtifact(session.id, 'outline', { content: '# Edited outline\n- Kept branch', source: 'manual-edit' });
  await first.setArtifact(session.id, 'rawTranscript', { content: 'Edited raw again.', source: 'manual-edit' }, { preserve: true });

  const restarted = new SessionStore(root);
  await restarted.init();
  const reopened = await restarted.get(session.id);
  assert.equal(reopened.artifacts.rawTranscript.content, 'Edited raw again.');
  assert.equal(reopened.artifacts.cleanedTranscript.content, 'Edited cleaned.');
  assert.equal(reopened.artifacts.notes.content, '# Edited notes\n- Kept point');
  assert.equal(reopened.artifacts.outline.content, '# Edited outline\n- Kept branch');
  for (const key of ['rawTranscript', 'cleanedTranscript', 'notes', 'outline']) {
    assert.equal(reopened.artifacts[key].source, 'manual-edit');
    assert.equal(restarted.artifactIsValid(reopened, key), true);
  }
});

test('confirmed dictation appends around Raw edits without restoring older wording', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-inline-edit-recording-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const session = await store.create({ title: 'Recording edits' });
  await store.setArtifact(session.id, 'rawTranscript', { content: 'Opening statement.', source: 'manual-edit' }, { preserve: true });
  await store.startDictation(session.id, { model: 'tiny', language: 'en' });

  await store.saveDictationChunk(session.id, 0, Buffer.from('chunk-0'));
  await store.setDictationChunkResult(session.id, 0, { content: 'First confirmed.', language: 'en' });
  await store.setArtifact(session.id, 'rawTranscript', {
    content: 'Edited opening.',
    source: 'manual-edit',
  }, { preserve: true, baseContent: 'Opening statement.' });

  await store.saveDictationChunk(session.id, 1, Buffer.from('chunk-1'));
  await store.setDictationChunkResult(session.id, 1, { content: 'Second confirmed.', language: 'en' });
  let current = await store.get(session.id);
  assert.equal(current.artifacts.rawTranscript.content, 'Edited opening. First confirmed. Second confirmed.');
  assert.equal((current.artifacts.rawTranscript.content.match(/First confirmed\./g) || []).length, 1);

  await store.setArtifact(session.id, 'rawTranscript', {
    content: 'Edited opening. Corrected first. Second confirmed.',
    source: 'manual-edit',
  }, { preserve: true, baseContent: current.artifacts.rawTranscript.content });
  await store.saveDictationChunk(session.id, 2, Buffer.from('chunk-2'));
  await store.setDictationChunkResult(session.id, 2, { content: 'Third confirmed.', language: 'en' });
  current = await store.get(session.id);
  assert.equal(current.artifacts.rawTranscript.content, 'Edited opening. Corrected first. Second confirmed. Third confirmed.');
  assert.doesNotMatch(current.artifacts.rawTranscript.content, /Opening statement/);
  assert.equal(current.artifacts.rawTranscript.originalContent, 'Opening statement. First confirmed. Second confirmed. Third confirmed.');
});

test('manual derived edits remain visible when Raw changes while retaining stale dependency metadata', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-inline-edit-derived-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const session = await store.create({ title: 'Derived edit preservation' });
  await store.setArtifact(session.id, 'rawTranscript', { content: 'Original raw.', source: 'manual-edit' }, { preserve: true });
  await store.setArtifact(session.id, 'cleanedTranscript', { content: 'Manual cleaned.', source: 'manual-edit' });
  await store.setArtifact(session.id, 'notes', { content: '# Manual notes', source: 'manual-edit' });
  await store.setArtifact(session.id, 'outline', { content: '# Manual outline', source: 'manual-edit' });
  await store.setArtifact(session.id, 'rawTranscript', { content: 'Edited raw.', source: 'manual-edit' }, { preserve: true });

  const changed = await store.get(session.id);
  assert.equal(changed.artifacts.cleanedTranscript.content, 'Manual cleaned.');
  assert.equal(changed.artifacts.notes.content, '# Manual notes');
  assert.equal(changed.artifacts.outline.content, '# Manual outline');
  assert.equal(changed.artifacts.cleanedTranscript.stale, true);
  assert.equal(store.artifactIsValid(changed, 'cleanedTranscript'), true);
  assert.equal(store.artifactIsValid(changed, 'notes'), true);
  assert.equal(store.artifactIsValid(changed, 'outline'), true);
  assert.notEqual(changed.artifacts.cleanedTranscript.dependsOn.fingerprint, changed.artifacts.rawTranscript.contentFingerprint);
});

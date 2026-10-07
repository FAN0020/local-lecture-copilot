import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionStore } from '../src/store.js';
import { bindSessionTitleInput, SessionTitleDraft } from '../web/session-title.js';

const session = (title, updatedAt, id = 'session_1') => ({ id, title, updatedAt });

test('title draft remains user-owned across transcript and session refreshes', () => {
  const title = new SessionTitleDraft();
  title.sync(session('Original title', '2026-09-07T01:00:00.000Z'));
  title.beginEditing();
  title.update('A new title in progress');

  title.sync(session('Original title', '2026-09-07T01:00:01.000Z'));

  assert.equal(title.canonicalTitle, 'Original title');
  assert.equal(title.value, 'A new title in progress');
  assert.equal(title.editing, true);
});

test('successful save updates the canonical header and sidebar title together', () => {
  const title = new SessionTitleDraft();
  title.sync(session('Original title', '2026-09-07T01:00:00.000Z'));
  title.beginEditing();
  title.update('Renamed lecture');
  const request = title.prepareSave();

  assert.equal(title.acceptSave(request, session('Renamed lecture', '2026-09-07T01:00:02.000Z')), true);
  assert.equal(title.value, 'Renamed lecture');
  assert.equal(title.titleFor(session('Stale sidebar title', '2026-09-07T01:00:00.000Z')), 'Renamed lecture');
  assert.equal(title.editing, false);
});

test('editing that continues during a save is retained for the next commit', () => {
  const title = new SessionTitleDraft();
  title.sync(session('Original title', '2026-09-07T01:00:00.000Z'));
  title.beginEditing();
  title.update('First edit');
  const first = title.prepareSave();
  title.update('Second edit');

  assert.equal(title.acceptSave(first, session('First edit', '2026-09-07T01:00:01.000Z')), true);
  assert.equal(title.canonicalTitle, 'First edit');
  assert.equal(title.value, 'Second edit');
  assert.equal(title.editing, true);
  assert.equal(title.prepareSave().draftTitle, 'Second edit');
});

test('failed saves keep the draft visible and expose the error for feedback', () => {
  const title = new SessionTitleDraft();
  title.sync(session('Original title', '2026-09-07T01:00:00.000Z'));
  title.beginEditing();
  title.update('Unsaved title');
  const request = title.prepareSave();
  const error = new Error('disk is read-only');

  assert.equal(title.rejectSave(request, error), true);
  assert.equal(title.value, 'Unsaved title');
  assert.equal(title.error, error);
  assert.equal(title.editing, true);
});

test('only an older request from the same edit is treated as a superseded failure', () => {
  const title = new SessionTitleDraft();
  title.sync(session('Original title', '2026-09-07T01:00:00.000Z'));
  title.beginEditing();
  title.update('First edit');
  const first = title.prepareSave();
  title.update('Latest edit');
  title.prepareSave();
  assert.equal(title.requestWasSuperseded(first), true);

  title.sync(session('Other lecture', '2026-09-07T01:00:01.000Z', 'session_2'));
  assert.equal(title.requestWasSuperseded(first), false);
});

test('stale save and refresh responses cannot restore an older title', () => {
  const title = new SessionTitleDraft();
  title.sync(session('Original title', '2026-09-07T01:00:00.000Z'));
  title.beginEditing();
  title.update('First save');
  const first = title.prepareSave();
  title.update('Latest save');
  const latest = title.prepareSave();

  assert.equal(title.acceptSave(latest, session('Latest save', '2026-09-07T01:00:02.000Z')), true);
  assert.equal(title.acceptSave(first, session('First save', '2026-09-07T01:00:01.000Z')), false);
  assert.equal(title.sync(session('First save', '2026-09-07T01:00:01.000Z')), false);
  assert.equal(title.sync(session('First save', '2026-09-07T01:00:02.000Z')), false);
  assert.equal(title.value, 'Latest save');
});

test('a pending save can be superseded by restoring the previous title', () => {
  const title = new SessionTitleDraft();
  title.sync(session('Original title', '2026-09-07T01:00:00.000Z'));
  title.beginEditing();
  title.update('Temporary title');
  const first = title.prepareSave();
  title.update('Original title');
  const restored = title.prepareSave();

  assert.notEqual(restored.id, first.id);
  assert.equal(restored.draftTitle, 'Original title');
});

test('blur commits once and Enter commits through blur, never on each input', async () => {
  class TitleInput extends EventTarget {
    constructor() {
      super();
      this.value = '';
    }

    blur() {
      this.dispatchEvent(new Event('blur'));
    }
  }

  const input = new TitleInput();
  let focuses = 0;
  const values = [];
  let commits = 0;
  bindSessionTitleInput(input, {
    onFocus: () => { focuses += 1; },
    onInput: (value) => values.push(value),
    onCommit: async () => { commits += 1; },
  });

  input.dispatchEvent(new Event('focus'));
  input.value = 'Draft';
  input.dispatchEvent(new Event('input'));
  assert.equal(commits, 0);

  const enter = new Event('keydown', { cancelable: true });
  Object.defineProperty(enter, 'key', { value: 'Enter' });
  input.dispatchEvent(enter);
  await Promise.resolve();
  assert.equal(enter.defaultPrevented, true);
  assert.equal(commits, 1);

  input.dispatchEvent(new Event('blur'));
  await Promise.resolve();
  assert.equal(focuses, 1);
  assert.deepEqual(values, ['Draft']);
  assert.equal(commits, 2);
});

test('saved title survives a store restart', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-title-edit-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  const created = await store.create({ title: 'Original title' });

  await store.updateMeta(created.id, { title: 'Persisted edit' });

  const reopened = new SessionStore(root);
  await reopened.init();
  assert.equal((await reopened.get(created.id)).title, 'Persisted edit');
  assert.equal((await reopened.list()).find((item) => item.id === created.id).title, 'Persisted edit');
});

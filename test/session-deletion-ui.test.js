import assert from 'node:assert/strict';
import test from 'node:test';
import {
  closeSessionContextMenu,
  confirmAndDeleteSession,
  deletionConfirmationCopy,
  openSessionContextMenu,
  selectedSessionAfterDeletion,
} from '../web/session-deletion.js';

function fakeMenu() {
  const classes = new Set(['hidden']);
  let focused = false;
  return {
    offsetWidth: 176,
    offsetHeight: 42,
    dataset: {},
    style: {},
    classList: {
      add(value) { classes.add(value); },
      remove(value) { classes.delete(value); },
      contains(value) { return classes.has(value); },
    },
    querySelector() { return { focus() { focused = true; } }; },
    get focused() { return focused; },
  };
}

const sessions = [
  { id: 'session_newest', title: 'Newest' },
  { id: 'session_middle', title: 'Middle' },
  { id: 'session_oldest', title: 'Oldest' },
];

test('right-click opens the session context menu at a viewport-safe position', () => {
  const menu = fakeMenu();
  let prevented = false;
  openSessionContextMenu({
    event: { clientX: 395, clientY: 298, preventDefault() { prevented = true; } },
    menu,
    sessionId: sessions[1].id,
    viewport: { innerWidth: 400, innerHeight: 300 },
  });
  assert.equal(prevented, true);
  assert.equal(menu.classList.contains('hidden'), false);
  assert.equal(menu.dataset.sessionId, sessions[1].id);
  assert.equal(menu.style.left, '216px');
  assert.equal(menu.style.top, '250px');
  assert.equal(menu.focused, true);

  closeSessionContextMenu(menu);
  assert.equal(menu.classList.contains('hidden'), true);
  assert.equal('sessionId' in menu.dataset, false);
});

test('deletion confirmation clearly identifies all permanently removed content', () => {
  const copy = deletionConfirmationCopy(sessions[0]);
  assert.match(copy.heading, /Newest/);
  for (const item of [
    ['transcript', '转录'],
    ['audio', '音频'],
    ['generated content', '生成内容'],
    ['temporary files', '临时文件'],
    ['recovery files', '恢复文件'],
  ]) {
    assert.match(copy.description, new RegExp(`${item[0]}|${item[1]}`, 'i'));
  }
  assert.match(copy.description, /cannot be undone|无法撤销/i);
});

test('canceling deletion makes no state or storage request changes', async () => {
  let removeCalls = 0;
  const result = await confirmAndDeleteSession({
    session: sessions[1],
    sessions,
    selectedId: sessions[1].id,
    confirmDelete: async () => false,
    remove: async () => { removeCalls += 1; },
  });
  assert.equal(result.status, 'cancelled');
  assert.strictEqual(result.sessions, sessions);
  assert.equal(result.selectedId, sessions[1].id);
  assert.equal(removeCalls, 0);
});

test('confirmed deletion removes the sidebar entry and selects the next session', async () => {
  const removed = [];
  const result = await confirmAndDeleteSession({
    session: sessions[1],
    sessions,
    selectedId: sessions[1].id,
    confirmDelete: async () => true,
    remove: async (id) => removed.push(id),
  });
  assert.equal(result.status, 'deleted');
  assert.deepEqual(removed, [sessions[1].id]);
  assert.deepEqual(result.sessions.map((session) => session.id), [sessions[0].id, sessions[2].id]);
  assert.equal(result.selectedId, sessions[2].id);
});

test('deleting the last remaining session returns the normal empty selection', async () => {
  const only = [sessions[0]];
  const result = await confirmAndDeleteSession({
    session: only[0],
    sessions: only,
    selectedId: only[0].id,
    confirmDelete: async () => true,
    remove: async () => {},
  });
  assert.deepEqual(result.sessions, []);
  assert.equal(result.selectedId, null);
});

test('deleting a non-selected session preserves the current selection', () => {
  assert.equal(selectedSessionAfterDeletion(sessions, sessions[0].id, sessions[2].id), sessions[2].id);
});

test('filesystem deletion failures leave sidebar and selected-session state unchanged', async () => {
  const failure = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
  await assert.rejects(() => confirmAndDeleteSession({
    session: sessions[1],
    sessions,
    selectedId: sessions[1].id,
    confirmDelete: async () => true,
    remove: async () => { throw failure; },
  }), failure);
  assert.deepEqual(sessions.map((session) => session.id), ['session_newest', 'session_middle', 'session_oldest']);
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileStorageAdapter } from '../src/storage.js';
import { SessionStore } from '../src/store.js';

test('filesystem storage keeps workspace paths safe and supports switching roots', async (t) => {
  const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-storage-a-'));
  const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-storage-b-'));
  t.after(() => Promise.all([fs.rm(firstRoot, { recursive: true, force: true }), fs.rm(secondRoot, { recursive: true, force: true })]));

  const storage = new FileStorageAdapter(firstRoot);
  await storage.writeAtomicJson('sessions/example/session.json', { title: 'First' });
  assert.deepEqual(JSON.parse(await storage.readFile('sessions/example/session.json', 'utf8')), { title: 'First' });
  await assert.rejects(() => storage.writeFile('../outside.txt', 'unsafe'), /escapes the workspace/i);

  storage.setRoot(secondRoot);
  await storage.writeAtomicJson('sessions/example/session.json', { title: 'Second' });
  assert.deepEqual(JSON.parse(await storage.readFile('sessions/example/session.json', 'utf8')), { title: 'Second' });
  assert.equal(await fs.access(path.join(firstRoot, 'sessions/example/session.json')).then(() => true), true);
});

test('workspace migration copies existing session files without overwriting the source', async (t) => {
  const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-storage-migrate-a-'));
  const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-storage-migrate-b-'));
  t.after(() => Promise.all([fs.rm(firstRoot, { recursive: true, force: true }), fs.rm(secondRoot, { recursive: true, force: true })]));
  const storage = new FileStorageAdapter(firstRoot);
  await storage.writeFile('sessions/a/session.json', '{"title":"Migrated"}');
  await storage.copyTo(secondRoot);
  assert.equal(await fs.readFile(path.join(secondRoot, 'sessions/a/session.json'), 'utf8'), '{"title":"Migrated"}');
  await assert.rejects(() => storage.copyTo(path.join(firstRoot, 'nested')), /inside or contain/i);
});

test('session storage reports invalid and missing session files clearly', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-storage-errors-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.init();
  await assert.rejects(() => store.get('not-a-session'), (error) => error.status === 400);
  await assert.rejects(() => store.get('session_00000000-0000-0000-0000-000000000000'), (error) => error.status === 404);
});

test('Windows locked session saves retry atomically and failed replacements retain old JSON', async (t) => {
  const { atomicJson } = await import('../src/lib.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-atomic-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.json');
  await atomicJson(file, { revision: 1 });
  let attempts = 0;
  await atomicJson(file, { revision: 2 }, {
    platform: 'win32', wait: async () => {},
    moveFile: async (source, destination) => {
      assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), { revision: 1 });
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('reader lock'), { code: 'EPERM' });
      await fs.rename(source, destination);
    },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { revision: 2 });
  await assert.rejects(atomicJson(file, { revision: 3 }, {
    platform: 'win32', retries: 1, wait: async () => {},
    moveFile: async () => { throw Object.assign(new Error('persistent lock'), { code: 'EPERM' }); },
  }), /persistent lock/);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { revision: 2 });
  assert.deepEqual(await fs.readdir(root), ['session.json']);
});

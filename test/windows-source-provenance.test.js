import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  collectSourceProvenance,
  verifySourceSnapshot,
  verifyWindowsResult,
  writeSourceSnapshotMetadata,
} from '../scripts/windows-source-provenance.js';

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

async function createRepository(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'llc-source-provenance-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, 'init');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Source Test');
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored/\n', 'utf8');
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'keep.txt'), 'original\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'delete.txt'), 'delete me\n', 'utf8');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  return root;
}

test('source snapshot records the current worktree and preserves dirty deletions', async (t) => {
  const repo = await createRepository(t);
  const clean = await collectSourceProvenance(repo, 'clean-snapshot');
  assert.equal(clean.clean, true);
  assert.equal(clean.commit, git(repo, 'rev-parse', 'HEAD'));
  assert.ok(clean.branch);

  await fs.writeFile(path.join(repo, 'src', 'keep.txt'), 'changed\n', 'utf8');
  await fs.rm(path.join(repo, 'src', 'delete.txt'));
  await fs.writeFile(path.join(repo, '路径 with spaces.txt'), 'untracked\n', 'utf8');
  await fs.mkdir(path.join(repo, 'ignored'));
  await fs.writeFile(path.join(repo, 'ignored', 'secret.txt'), 'ignored\n', 'utf8');

  const metadataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llc-source-metadata-'));
  t.after(() => fs.rm(metadataRoot, { recursive: true, force: true }));
  const manifestPath = path.join(metadataRoot, '.windows-validation-source.json');
  const fileList = path.join(metadataRoot, 'files');
  const provenance = await writeSourceSnapshotMetadata({
    repoRoot: repo,
    output: manifestPath,
    fileList,
    snapshotId: 'dirty-snapshot',
  });
  const paths = provenance.files.map((entry) => entry.path);
  assert.equal(provenance.clean, false);
  assert.ok(paths.includes('src/keep.txt'));
  assert.ok(paths.includes('路径 with spaces.txt'));
  assert.ok(!paths.includes('src/delete.txt'));
  assert.ok(!paths.includes('ignored/secret.txt'));
  assert.ok(provenance.gitStatus.some((line) => line.includes('src/delete.txt')));

  const snapshot = path.join(metadataRoot, 'snapshot');
  await fs.mkdir(snapshot);
  for (const entry of provenance.files) {
    const destination = path.join(snapshot, ...entry.path.split('/'));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(repo, ...entry.path.split('/')), destination);
  }
  await fs.copyFile(manifestPath, path.join(snapshot, '.windows-validation-source.json'));
  await verifySourceSnapshot(snapshot, path.join(snapshot, '.windows-validation-source.json'));

  await fs.writeFile(path.join(snapshot, 'unexpected.txt'), 'stale\n', 'utf8');
  await assert.rejects(
    verifySourceSnapshot(snapshot, path.join(snapshot, '.windows-validation-source.json')),
    /file set mismatch/,
  );
  await fs.rm(path.join(snapshot, 'unexpected.txt'));
  await fs.writeFile(path.join(snapshot, 'src', 'keep.txt'), 'tampered\n', 'utf8');
  await assert.rejects(
    verifySourceSnapshot(snapshot, path.join(snapshot, '.windows-validation-source.json')),
    /content mismatch/,
  );
});

test('returned Windows results must match the submitted source identity', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'llc-windows-result-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runId = '20260916T000000Z-42';
  const manifest = {
    snapshotId: 'snapshot-42',
    createdAt: '2026-09-16T00:00:00.000Z',
    branch: 'version-c-completed',
    commit: '0123456789abcdef0123456789abcdef01234567',
    clean: false,
    gitStatus: ['## version-c-completed', ' M src/app.js'],
    fileCount: 42,
    workingTreeSha256: 'a'.repeat(64),
  };
  const manifestPath = path.join(root, 'source.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
  await fs.mkdir(path.join(root, runId));
  await fs.writeFile(path.join(root, 'latest-run.txt'), `${runId}\n`, 'utf8');

  const summary = {
    startedAt: '2026-09-16T00:00:01.000Z',
    completedAt: '2026-09-16T00:01:00.000Z',
    node: 'v24.0.0',
    osArchitecture: 'Arm64',
    windows: { version: '10.0.26100' },
    source: { ...manifest, archiveSha256: 'b'.repeat(64) },
  };
  const summaryPath = path.join(root, runId, 'summary.json');
  await fs.writeFile(summaryPath, JSON.stringify(summary), 'utf8');
  const verified = await verifyWindowsResult({
    resultRoot: root,
    manifestPath,
    archiveSha256: 'b'.repeat(64),
  });
  assert.equal(verified.runId, runId);

  summary.source.commit = 'f'.repeat(40);
  await fs.writeFile(summaryPath, JSON.stringify(summary), 'utf8');
  await assert.rejects(
    verifyWindowsResult({ resultRoot: root, manifestPath, archiveSha256: 'b'.repeat(64) }),
    /commit does not match/,
  );
});

import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TRANSPORT_MANIFEST = '.windows-validation-source.json';

async function git(repoRoot, args, { encoding = 'utf8' } = {}) {
  const result = await execFileAsync('git', ['-C', repoRoot, ...args], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout;
}

async function sha256File(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function inspectSourceFile(repoRoot, relativePath) {
  const absolutePath = path.join(repoRoot, ...relativePath.split('/'));
  let stat;
  try {
    stat = await fs.lstat(absolutePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isDirectory()) {
    throw new Error(`Git entry resolves to a directory and cannot be snapshotted safely: ${relativePath}`);
  }
  if (stat.isSymbolicLink()) {
    const target = await fs.readlink(absolutePath);
    return {
      path: relativePath,
      type: 'symlink',
      bytes: Buffer.byteLength(target),
      sha256: createHash('sha256').update(target).digest('hex'),
    };
  }
  if (!stat.isFile()) throw new Error(`Unsupported source entry type: ${relativePath}`);
  return {
    path: relativePath,
    type: 'file',
    bytes: stat.size,
    sha256: await sha256File(absolutePath),
  };
}

function sourceDigest(files) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(JSON.stringify([file.path, file.type, file.bytes, file.sha256]));
    hash.update('\n');
  }
  return hash.digest('hex');
}

export async function collectSourceProvenance(repoRoot, snapshotId = randomUUID()) {
  const root = path.resolve(repoRoot);
  const topLevel = String(await git(root, ['rev-parse', '--show-toplevel'])).trim();
  const [canonicalRoot, canonicalTopLevel] = await Promise.all([fs.realpath(root), fs.realpath(topLevel)]);
  if (canonicalTopLevel !== canonicalRoot) throw new Error(`Expected repository root ${root}, received ${topLevel}`);

  const listed = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'buffer' });
  const paths = listed.toString('utf8').split('\0').filter(Boolean).sort((left, right) => left.localeCompare(right, 'en'));
  const files = [];
  for (const relativePath of paths) {
    const inspected = await inspectSourceFile(root, relativePath);
    if (inspected) files.push(inspected); // Deleted tracked paths intentionally stay deleted in the snapshot.
  }

  const branchOutput = String(await git(root, ['branch', '--show-current'])).trim();
  const statusOutput = String(await git(root, ['status', '--short', '--branch', '--untracked-files=all'])).trimEnd();
  const dirtyOutput = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'buffer' });
  return {
    schemaVersion: 1,
    snapshotId,
    createdAt: new Date().toISOString(),
    transport: 'macos-working-tree-snapshot',
    sourceWorktree: root,
    branch: branchOutput || '(detached)',
    commit: String(await git(root, ['rev-parse', 'HEAD'])).trim(),
    clean: dirtyOutput.length === 0,
    gitStatus: statusOutput ? statusOutput.split(/\r?\n/) : [],
    fileCount: files.length,
    workingTreeSha256: sourceDigest(files),
    archiveSha256: null,
    sourcePlatform: process.platform,
    sourceArchitecture: process.arch,
    files,
  };
}

export async function writeSourceSnapshotMetadata({ repoRoot, output, fileList, snapshotId }) {
  const provenance = await collectSourceProvenance(repoRoot, snapshotId);
  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  if (fileList) {
    const encoded = provenance.files.length ? `${provenance.files.map((entry) => entry.path).join('\0')}\0` : '';
    await fs.writeFile(fileList, encoded, 'utf8');
  }
  return provenance;
}

async function walkFiles(root, directory = root) {
  const found = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
    if (relativePath === TRANSPORT_MANIFEST) continue;
    if (entry.isDirectory()) found.push(...await walkFiles(root, absolutePath));
    else found.push(relativePath);
  }
  return found;
}

export async function verifySourceSnapshot(repoRoot, manifestPath) {
  const root = path.resolve(repoRoot);
  const manifest = JSON.parse((await fs.readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
  const expectedPaths = manifest.files.map((entry) => entry.path).sort((left, right) => left.localeCompare(right, 'en'));
  const actualPaths = (await walkFiles(root)).sort((left, right) => left.localeCompare(right, 'en'));
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    const expected = new Set(expectedPaths);
    const actual = new Set(actualPaths);
    const missing = expectedPaths.filter((entry) => !actual.has(entry));
    const extra = actualPaths.filter((entry) => !expected.has(entry));
    throw new Error(`Snapshot file set mismatch; missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`);
  }

  const files = [];
  for (const expected of manifest.files) {
    const actual = await inspectSourceFile(root, expected.path);
    if (!actual || actual.type !== expected.type || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new Error(`Snapshot content mismatch: ${expected.path}`);
    }
    files.push(actual);
  }
  const digest = sourceDigest(files);
  if (digest !== manifest.workingTreeSha256) {
    throw new Error(`Working-tree digest mismatch: expected ${manifest.workingTreeSha256}, received ${digest}`);
  }
  return manifest;
}

function parseJson(text) {
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

export async function verifyWindowsResult({ resultRoot, manifestPath, archiveSha256 }) {
  const expected = parseJson(await fs.readFile(manifestPath, 'utf8'));
  const runId = (await fs.readFile(path.join(resultRoot, 'latest-run.txt'), 'utf8')).trim();
  if (!runId) throw new Error('Returned Windows results do not identify a latest run.');
  const summaryPath = path.join(resultRoot, runId, 'summary.json');
  const summary = parseJson(await fs.readFile(summaryPath, 'utf8'));
  const source = summary.source;
  if (!source) throw new Error('Returned Windows summary has no source provenance.');

  const comparisons = {
    snapshotId: expected.snapshotId,
    branch: expected.branch,
    commit: expected.commit,
    clean: expected.clean,
    fileCount: expected.fileCount,
    workingTreeSha256: expected.workingTreeSha256,
    archiveSha256,
  };
  for (const [field, value] of Object.entries(comparisons)) {
    if (source[field] !== value) throw new Error(`Returned Windows source ${field} does not match the submitted snapshot.`);
  }
  if (JSON.stringify(source.gitStatus) !== JSON.stringify(expected.gitStatus)) {
    throw new Error('Returned Windows git status does not match the submitted snapshot.');
  }
  if (!summary.startedAt || !summary.completedAt || !summary.windows?.version || !summary.node || !summary.osArchitecture) {
    throw new Error('Returned Windows summary is missing timestamp, OS, Node, or architecture evidence.');
  }
  return { runId, summaryPath, summary };
}

function valueAfter(args, name, required = true) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (required && !value) throw new Error(`${name} is required.`);
  return value;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'create') {
    const provenance = await writeSourceSnapshotMetadata({
      repoRoot: valueAfter(args, '--repo'),
      output: valueAfter(args, '--output'),
      fileList: valueAfter(args, '--file-list', false),
      snapshotId: valueAfter(args, '--snapshot-id', false),
    });
    console.log(JSON.stringify({
      snapshotId: provenance.snapshotId,
      branch: provenance.branch,
      commit: provenance.commit,
      clean: provenance.clean,
      fileCount: provenance.fileCount,
      workingTreeSha256: provenance.workingTreeSha256,
    }));
    return;
  }
  if (command === 'verify-source') {
    const manifest = await verifySourceSnapshot(valueAfter(args, '--repo'), valueAfter(args, '--manifest'));
    console.log(`Verified source snapshot ${manifest.snapshotId} (${manifest.workingTreeSha256}).`);
    return;
  }
  if (command === 'verify-result') {
    const result = await verifyWindowsResult({
      resultRoot: valueAfter(args, '--result-root'),
      manifestPath: valueAfter(args, '--manifest'),
      archiveSha256: valueAfter(args, '--archive-sha256'),
    });
    console.log(`Verified Windows result ${result.runId}: ${result.summaryPath}`);
    return;
  }
  throw new Error('Usage: windows-source-provenance.js create|verify-source|verify-result [options]');
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invokedPath && realpathSync(fileURLToPath(import.meta.url)) === invokedPath) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

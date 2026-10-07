import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { downloadModelFile, retryWindowsFileOperation, WhisperModelManager } from '../src/providers/whisper-models.js';

function metadata(id, content, options = {}) {
  const buffer = Buffer.from(content);
  return {
    id,
    label: options.label || id,
    description: `${id} test model`,
    filename: options.filename || `ggml-${id}.bin`,
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    url: `https://example.invalid/${id}`,
    bundled: Boolean(options.bundled),
    content: buffer,
  };
}

async function roots(t, prefix = 'lecture-model-manager-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, bundledModelRoot: path.join(root, 'bundled'), installRoot: path.join(root, 'installed') };
}

function managerOptions(paths, models, overrides = {}) {
  return {
    ...paths,
    registry: models.map(({ content, ...model }) => model),
    logger: { error() {} },
    ...overrides,
  };
}

test('Windows transient file locks are retried before failing an atomic move', async () => {
  let attempts = 0;
  const waits = [];
  const result = await retryWindowsFileOperation(() => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('file is being scanned'), { code: 'EPERM' });
    return 'moved';
  }, {
    platform: 'win32',
    delayMs: 10,
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });

  assert.equal(result, 'moved');
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [10, 20]);
});

test('non-Windows and permanent file errors are not retried', async () => {
  for (const [platform, code] of [['darwin', 'EPERM'], ['win32', 'ENOENT']]) {
    let attempts = 0;
    await assert.rejects(retryWindowsFileOperation(() => {
      attempts += 1;
      throw Object.assign(new Error('not transient'), { code });
    }, { platform, wait: async () => {} }), /not transient/);
    assert.equal(attempts, 1);
  }
});

test('model download follows redirects, writes bytes, and reports progress', async (t) => {
  const paths = await roots(t);
  await fs.mkdir(paths.installRoot, { recursive: true });
  const destination = path.join(paths.installRoot, 'download.partial');
  const content = Buffer.from('redirected model response');
  const progress = [];
  const calls = [];

  const result = await downloadModelFile({
    url: 'https://example.invalid/model',
    destination,
    expectedBytes: content.length,
    attempts: 1,
    onProgress: (state) => progress.push(state),
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return new Response(content, { headers: { 'content-length': String(content.length) } });
    },
  });

  assert.deepEqual(calls, [{ url: 'https://example.invalid/model', options: { redirect: 'follow' } }]);
  assert.deepEqual(result, { downloadedBytes: content.length, totalBytes: content.length });
  assert.equal(progress.at(-1).downloadedBytes, content.length);
  assert.equal(await fs.readFile(destination, 'utf8'), content.toString());
});

test('model download preserves the final HTTP status in diagnostics', async (t) => {
  const paths = await roots(t);
  await fs.mkdir(paths.installRoot, { recursive: true });
  const destination = path.join(paths.installRoot, 'failed.partial');
  await assert.rejects(downloadModelFile({
    url: 'https://example.invalid/model',
    destination,
    expectedBytes: 10,
    attempts: 1,
    fetcher: async () => new Response('', { status: 503, statusText: 'Unavailable' }),
  }), (error) => error.httpStatus === 503 && /503 Unavailable/.test(error.message));
  await assert.rejects(fs.access(destination));
});

test('missing Whisper model is reported as missing and installable', async (t) => {
  const paths = await roots(t);
  const base = metadata('base', 'base-model');
  const manager = new WhisperModelManager(managerOptions(paths, [base]));
  const status = await manager.status();
  assert.equal(status.models.base, false);
  assert.equal(status.modelStates.base.state, 'missing');
  assert.equal(status.modelStates.base.canInstall, true);
  assert.deepEqual(status.installedModels, []);
});

test('successful install reports progress, verifies, atomically promotes, and becomes ready', async (t) => {
  const paths = await roots(t);
  const base = metadata('base', 'verified-base-model');
  const states = [];
  const manager = new WhisperModelManager(managerOptions(paths, [base], {
    onStateChange: (state) => states.push(state),
    downloader: async ({ destination, onProgress }) => {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, base.content);
      onProgress({ downloadedBytes: Math.floor(base.content.length / 2), totalBytes: base.content.length });
      onProgress({ downloadedBytes: base.content.length, totalBytes: base.content.length });
    },
  }));

  const installed = await manager.install('base');
  assert.equal(installed.state, 'ready');
  assert.equal(installed.source, 'downloaded');
  assert.equal(await fs.readFile(path.join(paths.installRoot, base.filename), 'utf8'), base.content.toString());
  await assert.rejects(fs.access(path.join(paths.installRoot, `${base.filename}.partial`)));
  assert.deepEqual([...new Set(states.map((state) => state.state))], ['downloading', 'verifying', 'ready']);
  assert.equal(states.some((state) => state.state === 'downloading' && state.progress > 0 && state.progress < 100), true);
});

test('Windows install succeeds when antivirus transiently locks the downloaded model', async (t) => {
  const paths = await roots(t);
  const base = metadata('base', 'windows-lock-model');
  let promoteAttempts = 0;
  const manager = new WhisperModelManager(managerOptions(paths, [base], {
    platform: 'win32',
    fileRetryDelayMs: 0,
    downloader: async ({ destination }) => {
      await fs.writeFile(destination, base.content);
    },
    moveFile: async (source, destination) => {
      if (source.endsWith('.partial') && promoteAttempts < 2) {
        promoteAttempts += 1;
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      }
      return fs.rename(source, destination);
    },
  }));

  const installed = await manager.install('base');
  assert.equal(installed.state, 'ready');
  assert.equal(promoteAttempts, 2);
  assert.equal(await fs.readFile(installed.path, 'utf8'), base.content.toString());
});

test('persistent Windows promotion lock reports its stage and leaves no installed marker', async (t) => {
  const paths = await roots(t);
  const base = metadata('base', 'windows-persistent-lock-model');
  const manager = new WhisperModelManager(managerOptions(paths, [base], {
    platform: 'win32',
    fileRetryDelayMs: 0,
    downloader: async ({ destination }) => {
      await fs.writeFile(destination, base.content);
    },
    moveFile: async (source, destination) => {
      if (source.endsWith('.partial')) throw Object.assign(new Error('file remains locked'), { code: 'EBUSY' });
      return fs.rename(source, destination);
    },
  }));

  await assert.rejects(manager.install('base'), /promote \(EBUSY\): file remains locked/);
  const status = await manager.status();
  assert.equal(status.modelStates.base.state, 'failed');
  assert.equal(status.modelStates.base.installStage, 'promote');
  assert.equal(status.modelStates.base.errorCode, 'EBUSY');
  await assert.rejects(fs.access(path.join(paths.installRoot, base.filename)));
  await assert.rejects(fs.access(path.join(paths.installRoot, `${base.filename}.install.json`)));
  await assert.rejects(fs.access(path.join(paths.installRoot, `${base.filename}.partial`)));
});

test('failed download remains failed and is never installed', async (t) => {
  const paths = await roots(t);
  const small = metadata('small', 'small-model');
  const logs = [];
  const manager = new WhisperModelManager(managerOptions(paths, [small], {
    logger: { error: (...values) => logs.push(values) },
    downloader: async ({ destination }) => {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, small.content.subarray(0, 3));
      throw new Error('network interrupted');
    },
  }));

  await assert.rejects(manager.install('small'), /network interrupted/);
  const status = await manager.status();
  assert.equal(status.models.small, false);
  assert.equal(status.modelStates.small.state, 'failed');
  assert.equal(status.modelStates.small.installStage, 'download');
  assert.equal(status.modelStates.small.targetPath, path.join(paths.installRoot, small.filename));
  assert.match(status.modelStates.small.error, /download: network interrupted/);
  assert.deepEqual(logs[0][1], {
    model: 'small',
    targetPath: path.join(paths.installRoot, small.filename),
    stage: 'download',
    code: null,
    status: null,
    message: 'network interrupted',
  });
  await assert.rejects(fs.access(path.join(paths.installRoot, small.filename)));
  await assert.rejects(fs.access(path.join(paths.installRoot, `${small.filename}.partial`)));
});

test('model filenames containing Windows or POSIX path separators are rejected', async (t) => {
  const paths = await roots(t);
  for (const filename of ['..\\outside.bin', '../outside.bin']) {
    const base = metadata('base', 'invalid-path-model', { filename });
    assert.throws(() => new WhisperModelManager(managerOptions(paths, [base])), /Invalid Whisper model metadata/);
  }
});

test('partial file is ignored and not rediscovered as installed', async (t) => {
  const paths = await roots(t);
  const medium = metadata('medium', 'medium-model');
  await fs.mkdir(paths.installRoot, { recursive: true });
  await fs.writeFile(path.join(paths.installRoot, `${medium.filename}.partial`), medium.content);
  const manager = new WhisperModelManager(managerOptions(paths, [medium]));
  const status = await manager.status();
  assert.equal(status.models.medium, false);
  assert.equal(status.modelStates.medium.state, 'missing');
});

test('verified downloaded model is rediscovered after manager restart', async (t) => {
  const paths = await roots(t);
  const base = metadata('base', 'persistent-base-model');
  const options = managerOptions(paths, [base], {
    downloader: async ({ destination }) => {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, base.content);
    },
  });
  const first = new WhisperModelManager(options);
  await first.install('base');

  const restarted = new WhisperModelManager(managerOptions(paths, [base]));
  const status = await restarted.status();
  assert.equal(status.models.base, true);
  assert.equal(status.modelStates.base.state, 'ready');
  assert.equal(status.modelStates.base.source, 'downloaded');
});

test('installation handles paths containing spaces and non-ASCII characters', async (t) => {
  const paths = await roots(t, '讲座 model workspace ');
  paths.installRoot = path.join(paths.root, '模型 downloads');
  paths.bundledModelRoot = path.join(paths.root, '应用 bundled');
  const base = metadata('base', 'unicode-path-model');
  const manager = new WhisperModelManager(managerOptions(paths, [base], {
    downloader: async ({ destination }) => {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, base.content);
    },
  }));
  const status = await manager.install('base');
  assert.equal(status.path, path.join(paths.installRoot, base.filename));
  assert.equal(await fs.readFile(status.path, 'utf8'), base.content.toString());
});

test('existing bundled Tiny remains ready without a downloaded install record', async (t) => {
  const paths = await roots(t);
  const tiny = metadata('tiny', 'bundled-tiny-model', { bundled: true });
  await fs.mkdir(paths.bundledModelRoot, { recursive: true });
  await fs.writeFile(path.join(paths.bundledModelRoot, tiny.filename), tiny.content);
  const manager = new WhisperModelManager(managerOptions(paths, [tiny]));
  const status = await manager.status();
  assert.equal(status.models.tiny, true);
  assert.equal(status.modelStates.tiny.state, 'ready');
  assert.equal(status.modelStates.tiny.source, 'bundled');
  assert.equal(status.modelStates.tiny.path, path.join(paths.bundledModelRoot, tiny.filename));
});

test('failed installation can be retried successfully', async (t) => {
  const paths = await roots(t);
  const base = metadata('base', 'retry-base-model');
  let attempts = 0;
  const manager = new WhisperModelManager(managerOptions(paths, [base], {
    downloader: async ({ destination }) => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary outage');
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, base.content);
    },
  }));
  await assert.rejects(manager.install('base'), /temporary outage/);
  assert.equal((await manager.modelStatus('base')).state, 'failed');
  assert.equal((await manager.install('base')).state, 'ready');
  assert.equal(attempts, 2);
});

test('same-size content with the wrong hash fails integrity verification', async (t) => {
  const paths = await roots(t);
  const base = metadata('base', 'expected-content');
  const wrong = Buffer.from('tampered-content');
  assert.equal(wrong.length, base.content.length);
  const manager = new WhisperModelManager(managerOptions(paths, [base], {
    downloader: async ({ destination }) => {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, wrong);
    },
  }));
  await assert.rejects(manager.install('base'), /Integrity check failed/);
  assert.equal((await manager.modelStatus('base')).state, 'failed');
});

test('concurrent install requests share one installation', async (t) => {
  const paths = await roots(t);
  const base = metadata('base', 'concurrent-base-model');
  let downloads = 0;
  const manager = new WhisperModelManager(managerOptions(paths, [base], {
    downloader: async ({ destination }) => {
      downloads += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, base.content);
    },
  }));
  const first = manager.install('base');
  const second = manager.install('base');
  assert.equal((await Promise.all([first, second])).every((state) => state.state === 'ready'), true);
  assert.equal(downloads, 1);
});

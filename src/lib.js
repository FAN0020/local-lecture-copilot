import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_LIVE_TRANSLATION_MODEL = 'qwen2.5:1.5b-instruct';

export const ARTIFACT_KEYS = new Set([
  'rawTranscript',
  'highQualityTranscript',
  'rawTranslation',
  'cleanedTranscript',
  'cleanedTranslation',
  'notesTranslation',
  'outlineTranslation',
  // Deprecated compatibility alias for pre-bilingual sessions.
  'translation',
  'keyPoints',
  'qa',
  'structuredAnalysis',
  'notes',
  'outline',
]);

export const STAGES = new Set([
  'cleanup',
  'translation',
  'cleaned-translation',
  'key-points',
  'qa',
  'analysis',
  'notes',
  'notes-translation',
  'outline',
  'outline-translation',
]);

export function now() {
  return new Date().toISOString();
}

export function id(prefix = '') {
  return `${prefix}${crypto.randomUUID()}`;
}

export function fingerprint(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function safeFilename(name) {
  const cleaned = path.basename(String(name || 'file'))
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
    .replace(/^\.+/, '')
    .slice(0, 140);
  return cleaned || 'file';
}

const WINDOWS_TRANSIENT_FILE_ERRORS = new Set(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM']);

export async function retryWindowsFileOperation(operation, {
  platform = process.platform,
  retries = 6,
  delayMs = 50,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (platform !== 'win32' || !WINDOWS_TRANSIENT_FILE_ERRORS.has(error.code) || attempt >= retries) throw error;
      await wait(delayMs * (2 ** attempt));
      attempt += 1;
    }
  }
}

export async function atomicJson(file, value, { moveFile = fs.rename, ...retryOptions } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    // Windows readers and antivirus can briefly lock the destination. Never
    // unlink it: retain the old valid JSON until atomic replacement succeeds.
    await retryWindowsFileOperation(() => moveFile(temp, file), retryOptions);
  } catch (error) {
    await retryWindowsFileOperation(() => fs.rm(temp, { force: true }), retryOptions).catch(() => {});
    throw error;
  }
}

export function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export async function readBody(req, limit = 100 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error(`Upload exceeds the ${Math.round(limit / 1024 / 1024)} MB limit`);
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit = 2 * 1024 * 1024) {
  const body = await readBody(req, limit);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON');
    error.status = 400;
    throw error;
  }
}

export function publicSession(session) {
  const publicAudio = (audio) => audio ? (({ storedPath, ...visible }) => visible)(audio) : null;
  const publicDictation = (dictation) => dictation ? {
    ...dictation,
    transcriptPrefix: undefined,
    transcriptPrefixFingerprint: undefined,
    originalTranscriptPrefix: undefined,
    chunks: (dictation.chunks || []).map(({ storedPath, transcript, ...chunk }) => ({
      ...chunk,
      hasTranscript: Boolean(transcript),
    })),
  } : null;
  return {
    ...session,
    paragraphization: session.paragraphization ? {
      ...session.paragraphization,
      // Segment text is a projection only; the raw transcript artifact remains
      // the immutable source of truth and is never rewritten by paragraphing.
      segments: session.paragraphization.segments,
    } : null,
    materials: (session.materials || []).map(({ storedPath, extractedText, text, ...material }) => material),
    audio: publicAudio(session.audio),
    recordingSegments: (session.recordingSegments || []).map((segment) => ({
      ...publicDictation(segment),
      audio: publicAudio(segment.audio),
    })),
    dictation: publicDictation(session.dictation),
  };
}

export function nonEmpty(value, label) {
  const text = String(value ?? '').trim();
  if (!text) {
    const error = new Error(`${label} is required`);
    error.status = 400;
    throw error;
  }
  return text;
}

import { fingerprint, id, now } from './lib.js';
import { splitSentences as splitTextSentences } from './sentences.js';

// Paragraphs are deliberately a separate projection of the transcript.  The
// text in a transcript artifact is never edited by this module; only segment
// IDs and boundary metadata are stored here.
const TRANSITIONS = /^(?:now|next|next,|however|on the other hand|in contrast|therefore|so|as a result|moving on|let(?:'|’)s move on|finally|to summarize|in summary|the next (?:topic|part)|another (?:important )?(?:point|thing)|by contrast)\b/i;
const WORDS = /[\p{L}\p{N}]+/gu;
const SENTENCE_END = /[.!?。！？]["'’”)]*$/u;

function wordSet(text) {
  return new Set((String(text || '').toLocaleLowerCase().match(WORDS) || []).filter((word) => word.length > 2));
}

function overlap(left, right) {
  const a = wordSet(left);
  const b = wordSet(right);
  if (!a.size || !b.size) return 1;
  let common = 0;
  for (const word of a) if (b.has(word)) common += 1;
  return common / Math.max(1, Math.min(a.size, b.size));
}

function splitSentences(text, start = 0, end = 0, prefix = 'seg') {
  const value = String(text || '').trim();
  if (!value) return [];
  const detected = splitTextSentences(value);
  if (!detected.length) return [];
  const pieces = [];
  let cursor = 0;
  for (const sentence of detected) {
    const offset = value.indexOf(sentence, cursor);
    const from = offset < 0 ? cursor : offset;
    const ratioStart = value.length ? from / value.length : 0;
    const ratioEnd = value.length ? (from + sentence.length) / value.length : 1;
    pieces.push({
      id: `${prefix}_${pieces.length}`,
      text: sentence,
      start: Number.isFinite(start) && Number.isFinite(end) && end > start ? start + (end - start) * ratioStart : start || 0,
      end: Number.isFinite(start) && Number.isFinite(end) && end > start ? start + (end - start) * ratioEnd : end || start || 0,
    });
    cursor = offset < 0 ? cursor : offset + sentence.length;
  }
  return pieces.length ? pieces : [{ id: `${prefix}_0`, text: value, start: start || 0, end: end || start || 0 }];
}

/** Normalize provider segments while retaining their timestamps. */
function normalizedWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Locate a provider segment in the canonical transcript. Whisper providers
 * occasionally differ only in whitespace/punctuation from the text persisted
 * in Raw. Keeping the canonical text here prevents paragraphization from
 * quietly becoming a second Raw transcript.
 */
function canonicalSlice(content, providerText, cursor = 0) {
  const source = normalizedWhitespace(content);
  const needle = normalizedWhitespace(providerText);
  if (!source || !needle) return null;
  const direct = source.indexOf(needle, cursor);
  if (direct >= 0) return { text: source.slice(direct, direct + needle.length), start: direct, end: direct + needle.length };
  const compactSource = source.toLocaleLowerCase();
  const compactNeedle = needle.toLocaleLowerCase();
  const folded = compactSource.indexOf(compactNeedle, cursor);
  if (folded >= 0) return { text: source.slice(folded, folded + needle.length), start: folded, end: folded + needle.length };
  return null;
}

export function normalizeSegments(segments, content, { prefix = 'seg', chunkId, canonical = true } = {}) {
  const canonicalRaw = String(content || '').trim();
  const canonicalContent = normalizedWhitespace(content);
  const values = Array.isArray(segments) && segments.length
    ? segments
    : [{ text: canonicalRaw, start: 0, end: 0 }];
  const result = [];
  let cursor = 0;
  for (const [index, segment] of values.entries()) {
    const providerText = String(segment?.text || '').trim();
    const located = canonical ? canonicalSlice(canonicalContent, providerText, cursor) : null;
    const text = located?.text || providerText;
    if (!text) continue;
    if (located) cursor = located.end;
    const parts = splitSentences(text, Number(segment?.start || 0), Number(segment?.end || 0), `${prefix}_${index}`);
    for (const [partIndex, part] of parts.entries()) result.push({
      ...part,
      id: parts.length === 1 && segment?.id ? String(segment.id) : `${prefix}_${result.length}`,
      chunkId: chunkId ?? segment?.chunkId ?? null,
      sourceSegmentId: segment?.id ?? null,
      sourceSegmentIndex: partIndex,
    });
  }
  // If provider text could not be aligned, fall back to sentence boundaries
  // from the canonical content rather than exposing a subtly different
  // provider projection to cleanup or the UI.
  if (canonical && canonicalContent && result.length && normalizedWhitespace(result.map((item) => item.text).join(' ')) !== canonicalContent) {
    return splitSentences(canonicalRaw, 0, 0, prefix).map((part, index) => ({
      ...part,
      id: `${prefix}_${index}`,
      chunkId: chunkId ?? null,
      sourceSegmentId: null,
      sourceSegmentIndex: index,
    }));
  }
  return result;
}

function boundaryKey(afterSegmentId, nextSegmentId) {
  return `${afterSegmentId}→${nextSegmentId}`;
}

function candidateBoundary(left, right, paragraphWordCount) {
  const sentence = SENTENCE_END.test(left.text);
  const pause = Math.max(0, Number(right.timelineStart ?? right.start ?? 0) - Number(left.timelineEnd ?? left.end ?? 0));
  const transition = TRANSITIONS.test(right.text);
  const words = (String(left.text).match(WORDS) || []).length;
  const long = paragraphWordCount >= 120 || words >= 180;
  const topicShift = sentence && words >= 5 && (overlap(left.text, right.text) < 0.12);

  // Pause is one signal, never a decision on its own. Sentence boundaries and
  // a semantic/discourse cue are required for normal pauses; length can force
  // a boundary in a very long run-on lecture paragraph.
  let score = 0;
  if (pause >= 2.0) score += 0.28;
  else if (pause >= 1.1) score += 0.14;
  if (sentence) score += 0.24;
  if (transition) score += 0.25;
  if (topicShift) score += 0.30;
  if (long) score += 0.22;
  const enabled = long ? score >= 0.22 : (sentence && score >= 0.48);
  return { enabled, score: Math.min(0.99, score), pause, sentence, transition, topicShift, long };
}

function priorMaps(previous) {
  const boundaries = new Map();
  for (const item of previous?.boundaries || []) boundaries.set(boundaryKey(item.afterSegmentId, item.nextSegmentId), item);
  return boundaries;
}

function buildParagraphs(segments, boundaries) {
  const enabled = new Set((boundaries || []).filter((item) => item.enabled !== false).map((item) => item.afterSegmentId));
  const paragraphs = [];
  let current = [];
  for (const segment of segments) {
    current.push(segment.id);
    if (enabled.has(segment.id)) {
      paragraphs.push(current);
      current = [];
    }
  }
  if (current.length || !paragraphs.length) paragraphs.push(current);
  return paragraphs.filter((group) => group.length).map((segmentIds, index) => {
    const edges = boundaries.filter((item) => item.enabled !== false && segmentIds.includes(item.afterSegmentId));
    const confidence = edges.length ? Math.min(...edges.map((item) => Number(item.confidence || 0))) : 1;
    const manualLocked = edges.some((item) => item.manualLocked);
    return { id: `paragraph_${index + 1}`, segmentIds, confidence, source: manualLocked ? 'manual' : (edges[0]?.source || 'heuristic-live'), manualLocked };
  });
}

export function paragraphize(segments, { previous = null, mode = 'live', sourceFingerprint = '' } = {}) {
  const values = (segments || []).filter((segment) => segment?.text).map((segment, index) => ({
    ...segment,
    id: String(segment.id || `seg_${index}`), text: String(segment.text).trim(), start: Number(segment.start || 0), end: Number(segment.end || 0), chunkId: segment.chunkId ?? null,
  }));
  const old = priorMaps(previous);
  const boundaries = [];
  let paragraphWords = 0;
  for (let index = 0; index < values.length - 1; index += 1) {
    const left = values[index];
    const right = values[index + 1];
    paragraphWords += (left.text.match(WORDS) || []).length;
    const key = boundaryKey(left.id, right.id);
    const prior = old.get(key);
    const candidate = candidateBoundary(left, right, paragraphWords);
    const isOldStable = mode === 'live' && index < values.length - 3 && prior?.stable && !prior.manualLocked;
    const item = prior ? { ...prior, afterSegmentId: left.id, nextSegmentId: right.id } : {
      id: id('boundary_'), afterSegmentId: left.id, nextSegmentId: right.id, enabled: candidate.enabled,
      confidence: candidate.score, source: mode === 'final' ? 'semantic-refinement' : 'heuristic-live', manualLocked: false,
    };
    if (!prior || (!isOldStable && !prior.manualLocked)) {
      item.enabled = candidate.enabled;
      item.confidence = candidate.score;
      item.source = mode === 'final' ? 'semantic-refinement' : 'heuristic-live';
    }
    item.stable = Boolean(item.manualLocked || mode === 'final' || index < values.length - 3);
    item.signals = { pause: candidate.pause, sentence: candidate.sentence, transition: candidate.transition, length: candidate.long, topicShift: candidate.topicShift };
    boundaries.push(item);
  }
  // Preserve manual merge tombstones even though their edge is no longer a
  // normal automatic candidate. This prevents a later refinement re-adding it.
  for (const item of previous?.boundaries || []) {
    if (item.manualLocked && item.enabled === false && !boundaries.some((candidate) => candidate.id === item.id)) boundaries.push(item);
  }
  boundaries.sort((a, b) => values.findIndex((s) => s.id === a.afterSegmentId) - values.findIndex((s) => s.id === b.afterSegmentId));
  const result = {
    schemaVersion: 1,
    status: mode === 'final' ? 'refined' : 'provisional',
    sourceFingerprint: sourceFingerprint || fingerprint(values.map((item) => item.text).join(' ')),
    segments: values,
    boundaries,
    paragraphs: buildParagraphs(values, boundaries),
    updatedAt: now(),
  };
  result.rendered = paragraphText(result);
  return result;
}

export function paragraphText(paragraphization, content = '') {
  if (!paragraphization?.paragraphs?.length) return String(content || '');
  const byId = new Map((paragraphization.segments || []).map((segment) => [segment.id, segment.text]));
  return paragraphization.paragraphs.map((paragraph) => paragraph.segmentIds.map((segmentId) => byId.get(segmentId) || '').filter(Boolean).join(' ')).join('\n\n');
}

export function splitParagraph(paragraphization, { paragraphId, afterSegmentId } = {}) {
  const paragraph = paragraphization?.paragraphs?.find((item) => item.id === paragraphId);
  const after = afterSegmentId || (paragraph?.segmentIds?.length > 1 ? paragraph.segmentIds[Math.ceil(paragraph.segmentIds.length / 2) - 1] : null);
  const index = paragraph?.segmentIds?.indexOf(after) ?? -1;
  if (!paragraph || index < 0 || index >= paragraph.segmentIds.length - 1) throw Object.assign(new Error('Choose a sentence inside a paragraph to split after'), { status: 400 });
  const next = paragraph.segmentIds[index + 1];
  const existing = paragraphization.boundaries.find((item) => item.afterSegmentId === after && item.nextSegmentId === next);
  if (existing) Object.assign(existing, { enabled: true, confidence: 1, source: 'manual-split', manualLocked: true, stable: true });
  else paragraphization.boundaries.push({ id: id('boundary_'), afterSegmentId: after, nextSegmentId: next, enabled: true, confidence: 1, source: 'manual-split', manualLocked: true, stable: true });
  paragraphization.paragraphs = buildParagraphs(paragraphization.segments, paragraphization.boundaries);
  paragraphization.rendered = paragraphText(paragraphization);
  paragraphization.status = 'refined';
  paragraphization.updatedAt = now();
  return paragraphization;
}

export function mergePreviousParagraph(paragraphization, { paragraphId } = {}) {
  const index = paragraphization?.paragraphs?.findIndex((item) => item.id === paragraphId) ?? -1;
  if (index <= 0) throw Object.assign(new Error('This paragraph has no previous paragraph'), { status: 400 });
  const previous = paragraphization.paragraphs[index - 1];
  const current = paragraphization.paragraphs[index];
  const afterSegmentId = previous.segmentIds.at(-1);
  const nextSegmentId = current.segmentIds[0];
  const existing = paragraphization.boundaries.find((item) => item.afterSegmentId === afterSegmentId && item.nextSegmentId === nextSegmentId);
  if (existing) Object.assign(existing, { enabled: false, confidence: 1, source: 'manual-merge', manualLocked: true, stable: true });
  else paragraphization.boundaries.push({ id: id('boundary_'), afterSegmentId, nextSegmentId, enabled: false, confidence: 1, source: 'manual-merge', manualLocked: true, stable: true });
  paragraphization.paragraphs = buildParagraphs(paragraphization.segments, paragraphization.boundaries);
  paragraphization.rendered = paragraphText(paragraphization);
  paragraphization.status = 'refined';
  paragraphization.updatedAt = now();
  return paragraphization;
}

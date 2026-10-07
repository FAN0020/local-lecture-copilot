import { fingerprint, id, now } from './lib.js';

function normalize(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function sentenceKey(text, occurrence) {
  return `${fingerprint(text)}:${occurrence}`;
}

function relatedSource(left, right) {
  const first = normalize(left);
  const second = normalize(right);
  return Boolean(first && second && (first.startsWith(second) || second.startsWith(first)));
}

export function rawUnitNeedsTranslation(segment) {
  if (!String(segment?.translatedText || '').trim()) return true;
  if (segment.targetLanguage && segment.translatedTargetLanguage !== segment.targetLanguage) return true;
  if (segment.translatedRevision) return segment.translatedRevision !== segment.sourceRevision;
  return segment.status !== 'translated';
}

function retainedTranslation(prior, sourceText, sourceRevision) {
  const translatedText = String(prior?.translatedText || '').trim();
  if (!translatedText) return { translatedText: '', translatedRevision: null, translatedTargetLanguage: null };
  // translatedRevision was not stored by older sessions. An unchanged source
  // is sufficient to migrate that successful translation to the new field.
  const translatedRevision = prior.translatedRevision
    || (normalize(prior.sourceText) === sourceText ? sourceRevision : prior.sourceRevision)
    || null;
  return { translatedText, translatedRevision, translatedTargetLanguage: prior?.translatedTargetLanguage || null };
}

function pendingTranslationState(sourceText, prior, { ordinal, targetLanguage, prefix = 'raw_pending_' } = {}) {
  const normalized = normalize(sourceText);
  const sourceRevision = fingerprint(normalized);
  const sourceUnchanged = normalize(prior?.sourceText) === normalized;
  const sameLanguage = !targetLanguage || !prior?.targetLanguage || prior.targetLanguage === targetLanguage;
  const translatedText = sameLanguage ? String(prior?.translatedText || '').trim() : '';
  const previousTranslatedText = sameLanguage
    ? sourceUnchanged
      ? String(prior?.previousTranslatedText || '')
      : translatedText || String(prior?.previousTranslatedText || '')
    : '';
  const currentTranslation = Boolean(sourceUnchanged && translatedText
    && (!targetLanguage || !prior?.translatedTargetLanguage || prior.translatedTargetLanguage === targetLanguage));
  return {
    id: prior?.id || id(prefix),
    sourceText: normalized,
    translatedText: sourceUnchanged ? translatedText : '',
    previousTranslatedText,
    translatedRevision: currentTranslation ? prior?.translatedRevision || sourceRevision : null,
    targetLanguage,
    translatedTargetLanguage: currentTranslation ? prior?.translatedTargetLanguage || targetLanguage : null,
    liveTranslationAttemptedAt: sourceUnchanged ? prior?.liveTranslationAttemptedAt || null : null,
    status: currentTranslation ? 'translated'
      : sourceUnchanged && prior?.status === 'error' ? 'error' : 'pending',
    sourceRevision,
    ordinal,
    error: sourceUnchanged ? prior?.error || null : null,
    provider: sourceUnchanged ? prior?.provider : undefined,
    model: sourceUnchanged ? prior?.model : undefined,
    translatedAt: sourceUnchanged ? prior?.translatedAt : undefined,
  };
}

function assemblePendingTranslation(tail, previous, { ordinal, targetLanguage }) {
  const sourceText = normalize(tail);
  if (!sourceText) return null;
  const candidate = previous?.pendingTranslation;
  const prior = relatedSource(sourceText, candidate?.sourceText) ? candidate : null;
  return pendingTranslationState(sourceText, prior, { ordinal, targetLanguage });
}

function splitStableSentences(normalized) {
  const stable = [];
  let cursor = 0;
  const matcher = /[^.!?。！？…]+[.!?。！？…]+["'”’»)]*/gu;
  let match;
  while ((match = matcher.exec(normalized))) {
    const text = normalize(match[0]);
    if (text) stable.push(text);
    cursor = matcher.lastIndex;
  }
  return { stable, tail: normalize(normalized.slice(cursor)) };
}

/**
 * Appended live transcript text is the common case. Reuse the already parsed
 * stable prefix and scan only the new suffix; corrections or insertions fall
 * back to the full parser below. This keeps sentence assembly proportional to
 * new speech instead of repeatedly rescanning the whole lecture.
 */
function appendOnlyAssembly(normalized, previousSegments, previousPending) {
  if (!previousSegments.length && !previousPending) return null;
  const stableTexts = previousSegments.map((segment) => normalize(segment.sourceText)).filter(Boolean);
  const candidates = [
    {
      stablePrefix: stableTexts.join(' '),
      canonical: normalize([...stableTexts, previousPending].filter(Boolean).join(' ')),
    },
    {
      stablePrefix: stableTexts.join(''),
      canonical: `${stableTexts.join('')}${previousPending}`,
    },
  ].filter((candidate) => candidate.canonical);
  const candidate = candidates.find((item) => normalized.startsWith(item.canonical));
  if (!candidate) return null;
  if (normalized === candidate.canonical) return { stable: stableTexts, tail: previousPending, appendOnly: true, newStable: [] };
  const suffix = normalized.slice(candidate.stablePrefix.length).trimStart();
  const parsed = splitStableSentences(suffix);
  return { stable: stableTexts.concat(parsed.stable), tail: parsed.tail, appendOnly: true, newStable: parsed.stable };
}

/**
 * Split a growing transcript into stable sentence units. The final non-terminal
 * tail remains structurally provisional, but also has one replaceable
 * translation unit so the bilingual pane never waits for perfect punctuation.
 */
function timingFor(text, sourceSegments) {
  const matches = sourceSegments.filter((segment) => {
    const candidate = normalize(segment.text);
    return candidate && (text.includes(candidate) || candidate.includes(text));
  });
  const starts = matches.map((segment) => Number(segment.timelineStart ?? segment.start)).filter(Number.isFinite);
  const ends = matches.map((segment) => Number(segment.timelineEnd ?? segment.end)).filter(Number.isFinite);
  return {
    startTime: starts.length ? Math.min(...starts) : null,
    endTime: ends.length ? Math.max(...ends) : null,
  };
}

export function assembleRawUnits(sourceText, previous = null, { finalizeTail = false, sourceSegments = [], targetLanguage = previous?.targetLanguage } = {}) {
  const normalized = normalize(sourceText);
  const previousSegments = (Array.isArray(previous?.segments) ? previous.segments : []).map((segment) => ({
    ...segment,
    targetLanguage,
    // Migrate older unit caches using their artifact's language. A new target
    // must not relabel a successfully cached translation in the old language.
    translatedTargetLanguage: segment.translatedTargetLanguage || (segment.translatedText ? previous?.targetLanguage : null),
  }));
  const previousPending = normalize(previous?.pendingText);
  const incremental = appendOnlyAssembly(normalized, previousSegments, previousPending);
  const parsed = incremental || splitStableSentences(normalized);
  const stable = parsed.stable;
  let tail = parsed.tail;
  const appendedStable = incremental?.appendOnly ? incremental.newStable.slice() : null;
  if (finalizeTail && tail) {
    stable.push(tail);
    appendedStable?.push(tail);
    tail = '';
  }
  if (appendedStable) {
    const occurrences = new Map();
    for (const segment of previousSegments) {
      const text = normalize(segment.sourceText);
      occurrences.set(text, (occurrences.get(text) || 0) + 1);
    }
    const segments = previousSegments.map((segment) => {
      const retained = { ...segment, ...retainedTranslation(segment, normalize(segment.sourceText), segment.sourceRevision) };
      if (retained.translatedText && targetLanguage && retained.translatedTargetLanguage !== targetLanguage) {
        retained.status = 'updating';
        retained.liveTranslationAttemptedAt = null;
      }
      return retained;
    });
    let reusedPending = false;
    for (const [offset, sourceTextValue] of appendedStable.entries()) {
      const occurrence = occurrences.get(sourceTextValue) || 0;
      occurrences.set(sourceTextValue, occurrence + 1);
      const timing = timingFor(sourceTextValue, sourceSegments);
      const prior = !reusedPending && relatedSource(sourceTextValue, previous?.pendingTranslation?.sourceText)
        ? previous.pendingTranslation : null;
      reusedPending ||= Boolean(prior);
      const translated = prior
        ? pendingTranslationState(sourceTextValue, prior, {
          ordinal: previousSegments.length + offset,
          targetLanguage,
          prefix: 'raw_unit_',
        })
        : null;
      segments.push({
        id: translated?.id || id('raw_unit_'),
        sourceText: sourceTextValue,
        translatedText: translated?.translatedText || '',
        previousTranslatedText: translated?.previousTranslatedText || '',
        translatedRevision: translated?.translatedRevision || null,
        targetLanguage,
        translatedTargetLanguage: translated?.translatedTargetLanguage || null,
        liveTranslationAttemptedAt: translated?.liveTranslationAttemptedAt || null,
        status: translated?.status || 'pending',
        startTime: timing.startTime,
        endTime: timing.endTime,
        sourceRevision: fingerprint(sourceTextValue),
        ordinal: previousSegments.length + offset,
        key: sentenceKey(sourceTextValue, occurrence),
        error: translated?.error || null,
      });
    }
    return {
      schemaVersion: 1,
      sourceArtifact: 'rawTranscript',
      targetLanguage,
      sourceFingerprint: fingerprint(normalized),
      segments,
      pendingText: tail,
      pendingTranslation: assemblePendingTranslation(tail, reusedPending ? null : previous, {
        ordinal: segments.length,
        targetLanguage,
      }),
      status: tail ? 'partial' : 'ready',
      updatedAt: now(),
    };
  }
  const previousByText = new Map();
  for (const segment of previousSegments) {
    const key = normalize(segment.sourceText);
    if (!key) continue;
    const list = previousByText.get(key) || [];
    list.push(segment);
    previousByText.set(key, list);
  }
  // Reserve exact text matches first. This keeps an inserted sentence from
  // taking the ID of a later unchanged sentence via the ordinal fallback.
  const exactPriors = stable.map((sourceTextValue) => previousByText.get(sourceTextValue)?.shift() || null);
  const reservedIds = new Set(exactPriors.map((segment) => segment?.id).filter(Boolean));
  const occurrences = new Map();
  const usedIds = new Set();
  let reusedPending = false;
  const segments = stable.map((sourceTextValue, index) => {
    const occurrence = occurrences.get(sourceTextValue) || 0;
    occurrences.set(sourceTextValue, occurrence + 1);
    let prior = exactPriors[index];
    if (!prior || usedIds.has(prior.id)) {
      const ordinalPrior = previousSegments[index];
      prior = ordinalPrior?.id && !reservedIds.has(ordinalPrior.id) && !usedIds.has(ordinalPrior.id) ? ordinalPrior : null;
    }
    const promotedPending = !prior && !reusedPending && relatedSource(sourceTextValue, previous?.pendingTranslation?.sourceText)
      ? previous.pendingTranslation : null;
    if (promotedPending) {
      prior = promotedPending;
      reusedPending = true;
    }
    if (prior?.id) usedIds.add(prior.id);
    const timing = timingFor(sourceTextValue, sourceSegments);
    const sourceUnchanged = prior?.sourceText === sourceTextValue;
    const sourceRevision = fingerprint(sourceTextValue);
    const retained = promotedPending
      ? pendingTranslationState(sourceTextValue, prior, { ordinal: index, targetLanguage, prefix: 'raw_unit_' })
      : retainedTranslation(prior, sourceTextValue, sourceRevision);
    const translationCurrent = Boolean(retained.translatedText && retained.translatedRevision === sourceRevision
      && (!targetLanguage || retained.translatedTargetLanguage === targetLanguage));
    return {
      id: prior?.id || id('raw_unit_'),
      sourceText: sourceTextValue,
      translatedText: retained.translatedText,
      previousTranslatedText: retained.previousTranslatedText || '',
      translatedRevision: retained.translatedRevision,
      targetLanguage,
      translatedTargetLanguage: retained.translatedTargetLanguage,
      liveTranslationAttemptedAt: translationCurrent ? prior?.liveTranslationAttemptedAt || null : null,
      status: translationCurrent ? 'translated'
        : retained.translatedText ? 'updating'
          : sourceUnchanged && prior?.status === 'error' ? 'error' : 'pending',
      startTime: timing.startTime ?? prior?.startTime ?? null,
      endTime: timing.endTime ?? prior?.endTime ?? null,
      sourceRevision,
      ordinal: index,
      key: sentenceKey(sourceTextValue, occurrence),
      error: prior?.error || null,
    };
  });
  return {
    schemaVersion: 1,
    sourceArtifact: 'rawTranscript',
    targetLanguage,
    sourceFingerprint: fingerprint(normalized),
    segments,
    pendingText: tail,
    pendingTranslation: assemblePendingTranslation(tail, reusedPending ? null : previous, {
      ordinal: segments.length,
      targetLanguage,
    }),
    status: tail ? 'partial' : 'ready',
    updatedAt: now(),
  };
}

export function rawTranslationContext(segments, index, count = 3) {
  return segments.slice(Math.max(0, index - count), index).map((segment) => segment.sourceText);
}

export const RAW_TRANSLATION_SYSTEM = 'You are a faithful translator. Translate every clause and detail of the CURRENT SENTENCE into the requested language. Do not summarize, omit information, add facts, or translate the preceding context. Return only the translation.';

export function rawTranslationPrompt({ sourceText, context = [], targetLanguage }) {
  const preceding = context.length ? `\nPRECEDING CONTEXT (do not translate separately):\n${context.join(' ')}` : '';
  return `Translate the CURRENT SENTENCE into ${targetLanguage}. Preserve names, technical terms, uncertainty, and every detail.${preceding}\n\nCURRENT SENTENCE:\n${sourceText}`;
}

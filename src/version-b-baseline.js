/**
 * Frozen Version B cleanup baseline from experiment/version-b at
 * 48ec0c1cd77fa9e8eedd71455da80453e33ee57c (src/pipeline.js).
 *
 * This intentionally retains B's prompt, segmentation, validation, retries,
 * fallback, and cache behavior. Only unreachable C and non-cleanup branches
 * were removed. Do not tune this module as part of C improvements: it is the
 * control used to measure whether a contextual correction is an improvement.
 * lib.js and sentences.js are unchanged from that revision; original-B trace
 * fixtures test the complete cleanup behavior, including those dependencies.
 */
export const VERSION_B_BASELINE_REVISION = '48ec0c1cd77fa9e8eedd71455da80453e33ee57c';

import { fingerprint, nonEmpty } from './lib.js';
import { sentenceParagraphText, splitSentences } from './sentences.js';

export const LLM_TASK_PROFILES = Object.freeze({
  cleanup: Object.freeze({ numCtx: 8192, numPredict: 2048 }),
});

function taskOptions(stage, options = {}) {
  const profile = LLM_TASK_PROFILES[stage];
  return {
    requestType: stage,
    numCtx: Math.max(512, Number(options.numCtx) || profile.numCtx),
    numPredict: Math.max(32, Number(options.numPredict) || profile.numPredict),
  };
}

export const VERSION_B_CLEANUP_SYSTEM = `You are a transcript correction assistant.

Correct obvious speech-recognition errors in the transcript below and improve its readability.

Rules:

1. Preserve the original meaning.
2. Correct obvious transcription errors.
3. Do not add facts that are not present in the transcript.
4. Do not use external lecture context.
5. Preserve technical terms when they are clear.
6. If a correction is uncertain, preserve the original wording.
7. Return only the corrected transcript.`;

const TOKEN_PATTERN = /[\p{L}\p{N}_]+/gu;
const COMMENTARY_PATTERN = /^(?:here(?:'s| is)\s+(?:the\s+)?(?:cleaned|revised)\s+transcript|the following (?:is|contains)\s+(?:the\s+)?(?:cleaned|revised)\s+transcript|below is\s+(?:the\s+)?(?:cleaned|revised)\s+transcript|(?:cleaned|revised) version(?: follows)?|sure[,!:]?|cleaned transcript\s*:?|the cleaned transcript\s*:?|i(?:'ve| have) cleaned|output\s*:|clean this raw lecture transcript)/iu;
const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu;
const FORMULA_PATTERN = /(?:\d+(?:\.\d+)?\s*[×x÷/*+−–—=-]\s*)+\d+(?:\.\d+)?|[λμσαβγθπ]\s*=\s*[^\s,.;]+/giu;
const FILLER_TOKENS = new Set(['uh', 'um', 'erm', 'hmm', 'mm', 'ah']);
const SUPPORT_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'because', 'been', 'but', 'by', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'here', 'him', 'his',
  'i', 'if', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'our', 'she', 'so', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
  'to', 'was', 'we', 'were', 'which', 'who', 'will', 'with', 'you', 'your',
]);
const NUMBER_WORDS = new Map([
  ['zero', 0], ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9],
  ['ten', 10], ['eleven', 11], ['twelve', 12], ['thirteen', 13], ['fourteen', 14], ['fifteen', 15], ['sixteen', 16], ['seventeen', 17], ['eighteen', 18], ['nineteen', 19],
  ['twenty', 20], ['thirty', 30], ['forty', 40], ['fifty', 50], ['sixty', 60], ['seventy', 70], ['eighty', 80], ['ninety', 90],
]);

function normalizedText(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

function tokens(value) {
  return normalizedText(value).toLocaleLowerCase().match(TOKEN_PATTERN) || [];
}

function editDistance(left, right) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function equivalentToken(left, right) {
  if (left === right) return true;
  if (left.length >= 4 && right.length >= 4 && left.replace(/s$/u, '') === right.replace(/s$/u, '')) return true;
  if (left.length >= 4 && right.length >= 4 && Math.abs(left.length - right.length) <= 5 && (left.includes(right) || right.includes(left))) return true;
  return left.length >= 5 && right.length >= 5 && editDistance(left, right) <= 1;
}

function tokenAppears(token, candidates) {
  return candidates.some((candidate) => equivalentToken(token, candidate));
}

function parsedNumberWords(list, start) {
  let current = 0;
  let total = 0;
  let cursor = start;
  let consumed = 0;
  let numericWords = 0;
  while (cursor < list.length) {
    const word = list[cursor];
    if (word === 'and' && numericWords) {
      cursor += 1;
      consumed += 1;
      continue;
    }
    if (NUMBER_WORDS.has(word)) {
      current += NUMBER_WORDS.get(word);
    } else if (word === 'hundred' && numericWords) {
      current = Math.max(1, current) * 100;
    } else if (word === 'thousand' && numericWords) {
      total += Math.max(1, current) * 1000;
      current = 0;
    } else {
      break;
    }
    numericWords += 1;
    consumed += 1;
    cursor += 1;
  }
  return numericWords ? { value: total + current, consumed } : null;
}

function numberConcepts(value) {
  const concepts = String(value || '').match(/\d+(?:\.\d+)?/gu)?.map(Number) || [];
  const list = tokens(value);
  for (let index = 0; index < list.length; index += 1) {
    const parsed = parsedNumberWords(list, index);
    if (!parsed) continue;
    concepts.push(parsed.value);
    index += parsed.consumed - 1;
  }
  return concepts.filter(Number.isFinite);
}

function meaningfulTokens(value) {
  return tokens(value).filter((token) => !FILLER_TOKENS.has(token));
}

function sourceSentences(value) {
  return splitSentences(value);
}

function removeAsrArtifacts(value) {
  const paragraphs = String(value || '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\[(?:UNCLEAR(?:[_\s]+AUDIO)?|INAUDIBLE(?:[_\s]+AUDIO)?)\]/giu, '[unclear]')
    .replace(/\[(?:BLANK_AUDIO|NO_SPEECH|SILENCE|MUSIC)\]/giu, ' ')
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph
      .split('\n')
      .map((line) => line
        .replace(/\b([\p{L}\p{N}]{4,})\s+\1\b/giu, '$1')
        .replace(/\s+([,.!?;:])/gu, '$1')
        .replace(/\s+/gu, ' ')
        .trim())
      .filter(Boolean)
      .join(' '))
    .filter(Boolean);
  return paragraphs.join('\n\n').trim();
}

// Exact adjacent sentence duplication is a safe indication of a chunk-boundary
// replay. Deliberate teaching repetition such as “this, this” is left alone.
function removeDuplicateSentences(value) {
  let output = removeAsrArtifacts(value);
  let previous;
  do {
    previous = output;
    output = output.replace(/(^|\s)([^.!?。！？]{2,160}[.!?。！？])\s+\2/giu, '$1$2');
  } while (output !== previous);
  return output;
}

function splitCanonicalSentences(content) {
  const pieces = splitSentences(content);
  return pieces.length ? pieces : (String(content || '').trim() ? [String(content).trim()] : []);
}

export function cleanupSourceArtifact(session) {
  const highQuality = session?.artifacts?.highQualityTranscript;
  if (highQuality?.content && highQuality.generationState === 'complete') {
    return { key: 'highQualityTranscript', content: String(highQuality.content), structure: session.highQualityParagraphization };
  }
  return { key: 'rawTranscript', content: String(session?.artifacts?.rawTranscript?.content || ''), structure: session?.paragraphization };
}

/** Build cleanup paragraphs from high-quality ASR, with Raw as a legacy fallback. */
export function cleanupSourceParagraphs(session) {
  const source = cleanupSourceArtifact(session);
  const raw = source.content.trim();
  if (!raw) return [];
  const sentences = splitCanonicalSentences(raw);
  const groups = (source.structure?.paragraphs || [])
    .filter((paragraph) => (paragraph.segmentIds || []).length > 0);
  const segmentCounts = groups.map((paragraph) => paragraph.segmentIds.length);
  const paragraphs = [];
  if (segmentCounts.length && segmentCounts.reduce((sum, count) => sum + count, 0) === sentences.length) {
    let cursor = 0;
    for (const [index, count] of segmentCounts.entries()) {
      paragraphs.push({ id: groups[index].id || `paragraph_${index + 1}`, ordinal: index, text: sentences.slice(cursor, cursor + count).join(' ') });
      cursor += count;
    }
  } else {
    // Old sessions can contain provider segments that do not line up with the
    // persisted Raw text. Fall back to bounded sentence groups, still sourced
    // entirely from canonical Raw content.
    let current = '';
    let ordinal = 0;
    for (const sentence of sentences) {
      if (current && current.length + sentence.length + 1 > 1200) {
        paragraphs.push({ id: `paragraph_${ordinal + 1}`, ordinal, text: current });
        ordinal += 1;
        current = '';
      }
      current = current ? `${current} ${sentence}` : sentence;
    }
    if (current) paragraphs.push({ id: `paragraph_${ordinal + 1}`, ordinal, text: current });
  }
  return paragraphs.filter((paragraph) => paragraph.text);
}

function splitOversizedParagraph(text, maxCharacters) {
  if (text.length <= maxCharacters) return [text];
  const pieces = [];
  let remaining = text;
  while (remaining.length > maxCharacters) {
    const window = remaining.slice(0, maxCharacters + 1);
    const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'));
    const whitespace = window.lastIndexOf(' ');
    const cut = sentence >= Math.floor(maxCharacters * 0.55) ? sentence + 1
      : whitespace >= Math.floor(maxCharacters * 0.55) ? whitespace : maxCharacters;
    pieces.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) pieces.push(remaining);
  return pieces;
}

function sourceJoin(left, right) {
  return left?.paragraphId === right?.paragraphId ? ' ' : '\n\n';
}

function joinSourceItems(items) {
  return (items || []).reduce((content, item, index) => `${content}${index ? sourceJoin(items[index - 1], item) : ''}${item.text}`, '');
}

/** Original B target segmentation, with every evidence field intentionally empty. */
export function cleanupWindows(paragraphs, { maxTargetCharacters = 7000 } = {}) {
  maxTargetCharacters = Math.max(40, Number(maxTargetCharacters) || 7000);
  const expanded = [];
  for (const paragraph of paragraphs || []) {
    const pieces = splitOversizedParagraph(String(paragraph.text || ''), maxTargetCharacters);
    pieces.forEach((text, index) => expanded.push({
      id: `${paragraph.id || `paragraph_${paragraph.ordinal}`}_${index + 1}`,
      paragraphId: paragraph.id,
      paragraphOrdinal: paragraph.ordinal,
      partIndex: index,
      partCount: pieces.length,
      ordinal: expanded.length,
      text,
    }));
  }
  const targets = [];
  let current = [];
  let length = 0;
  for (const paragraph of expanded) {
    const nextLength = length ? length + 2 + paragraph.text.length : paragraph.text.length;
    if (current.length && nextLength > maxTargetCharacters) {
      targets.push(current);
      current = [];
      length = 0;
    }
    current.push(paragraph);
    length = length ? length + 2 + paragraph.text.length : paragraph.text.length;
  }
  if (current.length) targets.push(current);
  return targets.map((target, index) => {
    const sourceText = joinSourceItems(target);
    const previous = '';
    const following = '';
    const reference = '';
    return {
      id: `cleanup_region_${index + 1}`,
      ordinal: index,
      sourceText,
      sourceFingerprint: fingerprint(sourceText),
      paragraphIds: target.map((item) => item.paragraphId),
      startsParagraphId: target[0].paragraphId,
      endsParagraphId: target.at(-1).paragraphId,
      continuesPreviousParagraph: target[0].partIndex > 0,
      continuesNextParagraph: target.at(-1).partIndex < target.at(-1).partCount - 1,
      previousContext: previous,
      followingContext: following,
      lectureReference: reference,
      contextFingerprint: fingerprint(reference),
    };
  });
}

export function cleanupPrompt(window) {
  return `Transcript:\n${window.sourceText}`;
}

function scriptRatio(value) {
  const text = normalizedText(value);
  if (!text) return 0;
  return (text.match(CJK_PATTERN) || []).length / Math.max(1, text.length);
}

function repeatedNgram(value, size = 5) {
  const list = tokens(value);
  for (let index = 0; index <= list.length - size * 2; index += 1) {
    const left = list.slice(index, index + size).join(' ');
    const right = list.slice(index + size, index + size * 2).join(' ');
    if (left === right) return left;
  }
  return null;
}

function duplicatedSentence(value) {
  return /(^|\s)([^.!?。！？]{2,160}[.!?。！？])\s+\2/iu.test(normalizedText(value));
}

function tokenCoverage(source, output) {
  const sourceTokens = meaningfulTokens(source);
  const outputTokens = meaningfulTokens(output);
  const sharedNumbers = new Set(numberConcepts(source).filter((number) => numberConcepts(output).includes(number)));
  const numericWords = new Set([...NUMBER_WORDS.keys(), 'hundred', 'thousand']);
  let matched = 0;
  for (const token of sourceTokens) {
    if (tokenAppears(token, outputTokens)) matched += 1;
    else if (numericWords.has(token) && sharedNumbers.size) matched += 1;
  }
  return { sourceTokens, outputTokens, matched, ratio: sourceTokens.length ? matched / sourceTokens.length : 1 };
}

function normalizedFormula(value) {
  return String(value || '').toLocaleLowerCase().replace(/[\s×]/gu, '').replace(/x/gu, '*').replace(/[−–—]/gu, '-');
}

function formulas(value) {
  return [...String(value || '').matchAll(FORMULA_PATTERN)].map((match) => normalizedFormula(match[0]));
}

function assembledCleanupContent(regions) {
  let content = '';
  let previous = null;
  for (const region of regions || []) {
    const cleaned = String(region.cleanedText || '').trim();
    if (!cleaned) continue;
    const sameSplitParagraph = Boolean(previous
      && region.continuesPreviousParagraph
      && previous.endsParagraphId === region.startsParagraphId);
    content = content ? `${content}${sameSplitParagraph ? ' ' : '\n\n'}${cleaned}` : cleaned;
    previous = region;
  }
  return removeDuplicateSentences(content).trim();
}

/**
 * Conservative deterministic guard around model output. It intentionally
 * permits legitimate grammar repairs and terminology substitutions while
 * rejecting outputs that lose whole source regions or become commentary.
 */
export function validateCleanupOutput(source, candidate, { previousContext = '', followingContext = '', lectureReference: reference = '' } = {}) {
  const original = removeDuplicateSentences(removeAsrArtifacts(source));
  const candidateRaw = normalizedText(candidate);
  const output = removeDuplicateSentences(removeAsrArtifacts(candidate));
  const support = `${source}\n${previousContext}\n${followingContext}\n${reference}`;
  const sourceCoverage = tokenCoverage(original, output);
  const sourceTokens = sourceCoverage.sourceTokens;
  const outputTokens = sourceCoverage.outputTokens;
  const supportTokens = meaningfulTokens(support);
  const novel = outputTokens.filter((token) => !SUPPORT_STOPWORDS.has(token) && token !== 'unclear' && !tokenAppears(token, sourceTokens));
  const unsupported = novel.filter((token) => !tokenAppears(token, supportTokens));
  const unsupportedTerms = unsupported.filter((token) => token.length >= 5);
  const novelRatio = outputTokens.length ? novel.length / outputTokens.length : 0;
  const unsupportedRatio = outputTokens.length ? unsupported.length / outputTokens.length : 0;
  const expansionRatio = original.length ? output.length / original.length : 1;
  const deletionRatio = original.length ? output.length / original.length : 1;
  const unclearCount = (output.match(/\[unclear\]/giu) || []).length;
  const coverage = Math.min(1, sourceCoverage.ratio + (unclearCount * 5) / Math.max(1, sourceTokens.length));
  const reasons = [];
  const contextFragments = [previousContext, followingContext]
    .map((context) => normalizedText(context).slice(0, 100))
    .filter((fragment) => fragment.length >= 48);
  const comparableOutput = normalizedText(output);
  if (!output) reasons.push('empty-output');
  const leadingLines = output.split('\n').slice(0, 3).map((line) => line.trim()).join('\n');
  if (COMMENTARY_PATTERN.test(output) || /(?:^|\n)\s*(?:#\s*)?(?:generated artifact|clean this raw lecture transcript)/iu.test(leadingLines) || /^```/u.test(output)) reasons.push('model-commentary');
  if (/^[{[]/u.test(output) && /["'](?:content|text)["']\s*:/u.test(output)) reasons.push('malformed-output');
  if (/<\/?(?:target|previous_context|following_context|lecture_reference)\b[^>]*>/iu.test(output)) reasons.push('malformed-output');
  if (contextFragments.some((fragment) => comparableOutput.includes(normalizedText(fragment)))) reasons.push('context-leakage');
  const sourceCjk = scriptRatio(original);
  const outputCjk = scriptRatio(output);
  if ((sourceCjk < 0.08 && outputCjk > 0.28) || (sourceCjk > 0.28 && outputCjk < 0.08)) reasons.push('unexpected-translation');
  if (expansionRatio > 1.7 || output.length > original.length + Math.max(300, original.length * 0.35)) reasons.push('large-expansion');
  if (sourceTokens.length >= 8 && (deletionRatio < 0.42 || coverage < 0.46)) reasons.push('large-deletion');
  if (sourceTokens.length > 12 && unsupportedRatio > 0.36 && coverage < 0.72) reasons.push('unsupported-additions');
  if (unsupportedTerms.length) reasons.push('unsupported-terms');
  if (duplicatedSentence(candidateRaw) || repeatedNgram(candidateRaw)) reasons.push('duplicated-output');
  const sourceNumbers = numberConcepts(original);
  const outputNumbers = numberConcepts(output);
  const supportedNumbers = numberConcepts(support);
  if (sourceNumbers.some((number) => !outputNumbers.includes(number))) reasons.push('missing-numeric-detail');
  if (outputNumbers.some((number) => !supportedNumbers.includes(number))) reasons.push('unsupported-number');
  const outputFormulas = formulas(output);
  if (formulas(original).some((formula) => !outputFormulas.includes(formula))) reasons.push('missing-formula-detail');
  for (const sentence of sourceSentences(original)) {
    const sentenceCoverage = tokenCoverage(sentence, output);
    const unclearCredit = unclearCount && sentenceCoverage.sourceTokens.length <= 10 ? 0.32 : 0;
    if (sentenceCoverage.sourceTokens.length >= 6 && sentenceCoverage.ratio + unclearCredit < 0.30) {
      reasons.push('missing-source-region');
      break;
    }
  }
  return {
    ok: reasons.length === 0,
    reason: reasons[0] || null,
    reasons,
    metrics: {
      sourceCharacters: original.length,
      outputCharacters: output.length,
      sourceTokens: sourceTokens.length,
      outputTokens: outputTokens.length,
      coverage: Number(coverage.toFixed(3)),
      novelRatio: Number(novelRatio.toFixed(3)),
      unsupportedRatio: Number(unsupportedRatio.toFixed(3)),
      expansionRatio: Number(expansionRatio.toFixed(3)),
      unclearCount,
    },
    output,
  };
}

async function runCleanupStage({ session, llm, model, options = {}, onProgress }) {
  const raw = nonEmpty(cleanupSourceArtifact(session).content, 'A high-quality transcript');
  const paragraphs = cleanupSourceParagraphs(session);
  const windows = cleanupWindows(paragraphs, {
    maxTargetCharacters: Math.max(40, Number(options.cleanupMaxCharacters) || 7000),
    contextCharacters: Math.max(80, Number(options.cleanupContextCharacters) || 2200),
    lectureReferenceCharacters: Math.max(0, Number(options.cleanupLectureReferenceCharacters) || 2400),
  });
  const previousRegions = !options.forceCleanup
    && session.artifacts.cleanedTranscript?.experimentVariant === 'B'
    && Array.isArray(session.artifacts.cleanedTranscript?.regions)
    ? session.artifacts.cleanedTranscript.regions : [];
  const regions = [];
  let reused = 0;
  let generated = 0;
  let fallback = 0;
  for (const window of windows) {
    const cached = previousRegions.find((region) => region.sourceFingerprint === window.sourceFingerprint
      && region.sourceText === window.sourceText
      && (!region.contextFingerprint || region.contextFingerprint === window.contextFingerprint)
      && region.cleanedText);
    if (cached) {
      regions.push({ ...cached, ...window, cleanedText: sentenceParagraphText(cached.cleanedText) });
      reused += 1;
      continue;
    }
    let accepted = null;
    let lastValidation = null;
    for (const strict of [false, true]) {
      const result = await llm.generate({
        model,
        system: VERSION_B_CLEANUP_SYSTEM,
        prompt: cleanupPrompt(window),
        temperature: 0.1,
        retrievedContextCharacters: window.lectureReference?.length || 0,
        ...taskOptions('cleanup', options),
      });
      const candidate = String(result?.content || '').trim();
      const validation = validateCleanupOutput(window.sourceText, candidate, window);
      lastValidation = validation;
      if (validation.ok) {
        accepted = {
          cleanedText: sentenceParagraphText(validation.output),
          status: 'complete',
          provider: result.provider,
          model: result.model || model,
          validation: { ...validation.metrics, reason: null, retried: strict },
        };
        break;
      }
      if (!strict && validation.reason === 'model-commentary') {
        console.warn(`Cleanup validation rejected region ${window.ordinal + 1}; falling back (${validation.reason})`, validation.metrics);
        break;
      }
      if (!strict) console.warn(`Cleanup validation rejected region ${window.ordinal + 1}; retrying (${validation.reason})`, validation.metrics);
    }
    generated += 1;
    if (!accepted) {
      const safeFallback = sentenceParagraphText(removeDuplicateSentences(removeAsrArtifacts(window.sourceText)));
      const fallbackMetrics = validateCleanupOutput(window.sourceText, safeFallback).metrics;
      accepted = {
        cleanedText: safeFallback,
        status: 'fallback',
        provider: null,
        model,
        validation: {
          ...fallbackMetrics,
          reason: lastValidation?.reason || 'invalid-output',
          rejectedReasons: lastValidation?.reasons || [],
          retried: true,
        },
      };
      fallback += 1;
      console.warn(`Cleanup validation fell back to the canonical source for region ${window.ordinal + 1}`, accepted.validation);
    }
    regions.push({
      ...window,
      ...accepted,
    });
    if (onProgress) {
      const partial = assembledCleanupContent(regions);
      await onProgress({
        content: partial,
        regions: regions.slice(),
        chunks: windows.slice(0, regions.length).map((item) => ({
          index: item.ordinal,
          sourceFingerprint: item.sourceFingerprint,
          contextFingerprint: item.contextFingerprint,
          characters: item.sourceText.length,
          reused: Boolean(previousRegions.find((region) => region.sourceFingerprint === item.sourceFingerprint
            && region.sourceText === item.sourceText
            && (!region.contextFingerprint || region.contextFingerprint === item.contextFingerprint)
            && region.cleanedText)),
        })),
        metrics: { regions: windows.length, reused, generated, fallback },
        generationState: 'running',
      });
    }
  }
  const content = assembledCleanupContent(regions);
  return {
    content: content || raw,
    regions,
    chunks: windows.map((window) => ({
      index: window.ordinal,
      sourceFingerprint: window.sourceFingerprint,
      contextFingerprint: window.contextFingerprint,
      characters: window.sourceText.length,
      reused: Boolean(previousRegions.find((region) => region.sourceFingerprint === window.sourceFingerprint
        && region.sourceText === window.sourceText
        && (!region.contextFingerprint || region.contextFingerprint === window.contextFingerprint)
        && region.cleanedText)),
    })),
    metrics: { regions: regions.length, reused, generated, fallback },
    provider: regions.find((region) => region.provider)?.provider || null,
  };
}

/** Run the frozen B correction and return its cleanup result without an artifact envelope. */
export async function runVersionBBaseline({ session, llm, model, options = {}, onProgress }) {
  // Same input isolation as the original B runStage before entering cleanup.
  // Never reuse a C or material-backed artifact as a B control.
  const artifacts = { ...session.artifacts };
  for (const key of ['cleanedTranscript', 'notes', 'outline']) {
    const artifact = artifacts[key];
    if (artifact?.source !== 'manual-edit' && (artifact?.experimentVariant === 'C'
      || artifact?.materialIds?.length
      || (key === 'cleanedTranscript' && artifact?.source === 'cleanup' && artifact.experimentVariant !== 'B'))) {
      artifacts[key] = null;
    }
  }
  const isolatedSession = { ...session, materials: [], artifacts };
  const resolvedModel = String(model || options.model || session.llmModel || process.env.OLLAMA_MODEL || 'qwen3.5:4b');
  return runCleanupStage({ session: isolatedSession, llm, model: resolvedModel, options, onProgress });
}

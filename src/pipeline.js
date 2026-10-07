import { fingerprint, nonEmpty } from './lib.js';
import { correctionMaterialsFingerprint, runConservativeCleanup as runCleanupStage } from './conservative-correction.js';
import { paragraphText } from './paragraphs.js';
import { sentenceParagraphText, splitSentences } from './sentences.js';

const CLEANUP_SYSTEM = `You reconstruct a faithful, readable lecture transcript from imperfect ASR. Cleaned Transcript means what the lecturer actually said, not merely punctuated Raw text and not condensed notes.
Edit only the supplied target region. Use surrounding context and the lecture reference only as evidence for sentence repair, terminology, and internal consistency. Never copy unrelated context into the target.
Preserve every supported explanation, example, detail, formula, name, technical claim, foreign-language phrase, uncertainty, and useful part of the lecturer's conversational teaching style. Never summarize, simplify away detail, translate, or add outside knowledge.
Remove meaningless ASR artifacts, chunk replays, abandoned false starts, and empty repetitions. Repair fragments or recognition errors only when the evidence is strong. When intended speech cannot be reconstructed reliably, write [unclear] for only that portion instead of guessing.
Return only the reconstructed target region. Group related sentences into semantic paragraphs separated by blank lines. Do not make every sentence its own paragraph. Do not add a preamble, labels, quotation marks, commentary, or Markdown fences.`;

export const LLM_TASK_PROFILES = Object.freeze({
  cleanup: Object.freeze({ numCtx: 8192, numPredict: 2048 }),
  translation: Object.freeze({ numCtx: 4096, numPredict: 2048 }),
  'cleaned-translation': Object.freeze({ numCtx: 4096, numPredict: 2048 }),
  'notes-translation': Object.freeze({ numCtx: 4096, numPredict: 2048 }),
  'outline-translation': Object.freeze({ numCtx: 4096, numPredict: 2048 }),
  'key-points': Object.freeze({ numCtx: 8192, numPredict: 2048 }),
  qa: Object.freeze({ numCtx: 8192, numPredict: 3072 }),
  analysis: Object.freeze({ numCtx: 8192, numPredict: 3072 }),
  notes: Object.freeze({ numCtx: 8192, numPredict: 4096 }),
  outline: Object.freeze({ numCtx: 8192, numPredict: 3072 }),
});

function taskOptions(stage, options = {}) {
  const profile = LLM_TASK_PROFILES[stage];
  return {
    requestType: stage,
    numCtx: Math.max(512, Number(options.numCtx) || profile.numCtx),
    numPredict: Math.max(32, Number(options.numPredict) || profile.numPredict),
  };
}

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
  // Version C deliberately starts from the prompt-revised Raw transcript.
  // A completed optional high-quality ASR artifact is retained for comparison,
  // but it is not an input to the material-aware revision pipeline.
  return { key: 'rawTranscript', content: String(session?.artifacts?.rawTranscript?.content || ''), structure: session?.paragraphization };
}

/** Build cleanup paragraphs from the prompt-revised Raw transcript. */
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

function contextualSimilarity(sourceText, candidateText) {
  const source = meaningfulTokens(sourceText).filter((token) => !SUPPORT_STOPWORDS.has(token));
  const candidate = meaningfulTokens(candidateText).filter((token) => !SUPPORT_STOPWORDS.has(token));
  if (!source.length || !candidate.length) return 0;
  let score = 0;
  for (const token of new Set(source)) {
    if (candidate.includes(token)) score += token.length >= 7 ? 4 : 2;
    else if (candidate.some((item) => token.length >= 5 && item.length >= 5 && editDistance(token, item) <= 2)) score += 1;
  }
  const sourceNumbers = numberConcepts(sourceText);
  const candidateNumbers = numberConcepts(candidateText);
  if (sourceNumbers.some((number) => candidateNumbers.includes(number))) score += 4;
  if (formulas(sourceText).length && formulas(candidateText).length) score += 3;
  return score;
}

/** Select bounded, non-adjacent lecture evidence for terminology consistency. */
function lectureReference(expanded, target, maxCharacters, adjacentContext = '') {
  const targetIds = new Set(target.map((item) => item.paragraphId));
  const sourceText = joinSourceItems(target);
  const candidates = [];
  const seen = new Set();
  for (const item of expanded) {
    if (targetIds.has(item.paragraphId) || seen.has(item.paragraphId)) continue;
    seen.add(item.paragraphId);
    const paragraphItems = expanded.filter((candidate) => candidate.paragraphId === item.paragraphId);
    const text = joinSourceItems(paragraphItems);
    if (normalizedText(adjacentContext).includes(normalizedText(text))) continue;
    const score = contextualSimilarity(sourceText, text);
    if (score > 0) candidates.push({ ordinal: item.paragraphOrdinal, score, text });
  }
  candidates.sort((left, right) => right.score - left.score || left.ordinal - right.ordinal);
  const selected = [];
  let length = 0;
  for (const candidate of candidates) {
    const allowance = maxCharacters - length - (selected.length ? 2 : 0);
    if (allowance <= 0) break;
    const text = candidate.text.slice(0, allowance).trim();
    if (!text) continue;
    selected.push(text);
    length += text.length + (selected.length > 1 ? 2 : 0);
  }
  return selected.join('\n\n');
}

/** Create bounded target regions with read-only preceding/following context. */
export function cleanupWindows(paragraphs, { maxTargetCharacters = 7000, contextCharacters = 2200, lectureReferenceCharacters = 2400 } = {}) {
  maxTargetCharacters = Math.max(40, Number(maxTargetCharacters) || 7000);
  contextCharacters = Math.max(80, Number(contextCharacters) || 2200);
  lectureReferenceCharacters = Math.max(0, Number(lectureReferenceCharacters) || 2400);
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
    const previous = joinSourceItems(expanded.slice(0, target[0].ordinal)).slice(-contextCharacters);
    const following = joinSourceItems(expanded.slice(target.at(-1).ordinal + 1)).slice(0, contextCharacters);
    const reference = lectureReference(expanded, target, lectureReferenceCharacters, `${previous}\n${following}`);
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
      // The lecture-wide reference is the durable contextual input. Adjacent
      // context remains in the prompt, but appending unrelated later speech
      // should not invalidate every previously cleaned region.
      contextFingerprint: fingerprint(reference),
    };
  });
}

export function cleanupPrompt(window, { strict = false } = {}) {
  const preservation = strict
    ? 'This is a preservation retry after a rejected draft. Restore every supported source detail, remove unsupported wording, and make only repairs directly supported by the supplied evidence. Use [unclear] for the smallest unrecoverable portion.'
    : 'Reconstruct what the lecturer actually said. Use high confidence for direct repairs, strong contextual consistency for technical recovery, and [unclear] where the evidence is insufficient.';
  return `Clean this raw lecture transcript region into a faithful reconstruction of what the lecturer actually said. ${preservation}

Rules:
- Repair broken sentence boundaries, fragments, punctuation, capitalization, and obvious grammar when the intended speech is supported.
- Remove [BLANK_AUDIO] and equivalent ASR markers when they carry no information.
- Remove meaningless repetitions, chunk-boundary replays, and abandoned false starts and disfluencies; retain useful conversational teaching language.
- Correct recognition errors and recover established technical terms only when PREVIOUS/FOLLOWING CONTEXT or LECTURE REFERENCE gives strong evidence.
- Apply internal consistency only when the supplied lecture evidence makes it unambiguous (for example, 28 × 28 pixels corresponding to 784 inputs).
- Preserve all supported formulas, names, claims, examples, explanations, qualifications, details, foreign-language speech, and lecturer intent.
- Never summarize, turn the passage into notes, simplify away detail, translate, add outside knowledge, or silently delete a difficult passage.
- If intended wording is not reliably recoverable, use [unclear] for only that portion instead of inventing plausible content.
- Group related sentences into coherent semantic paragraphs. Use a blank line for a real topic/idea shift, not after every sentence.
- PREVIOUS_CONTEXT, FOLLOWING_CONTEXT, and LECTURE_REFERENCE are read-only evidence; never reproduce them in the answer.
- Return only the reconstructed TARGET REGION without XML tags. Do not include context, labels, a preamble, commentary, or Markdown fences.

<previous_context read_only="true">
${window.previousContext || '(none)'}
</previous_context>

<following_context read_only="true">
${window.followingContext || '(none)'}
</following_context>

<lecture_reference read_only="true" purpose="terminology_and_consistency_only">
${window.lectureReference || '(none)'}
</lecture_reference>

Rewrite only the text inside <target>. Your response must contain only its cleaned replacement, without the <target> tags.
<target>
${window.sourceText}
</target>`;
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


const STAGE_TO_ARTIFACT = {
  cleanup: 'cleanedTranscript',
  // Legacy stage name retained as an API alias for cleaned translation.
  translation: 'cleanedTranslation',
  'cleaned-translation': 'cleanedTranslation',
  'notes-translation': 'notesTranslation',
  'outline-translation': 'outlineTranslation',
  'key-points': 'keyPoints',
  qa: 'qa',
  analysis: 'structuredAnalysis',
  notes: 'notes',
  outline: 'outline',
};

function transcriptFor(session) {
  const content = session.artifacts.cleanedTranscript?.content || session.artifacts.rawTranscript?.content || '';
  // Preserve the exact wording while carrying paragraph breaks into derived
  // prompts. Paragraphization is a structural projection, not cleanup.
  if (session.artifacts.cleanedTranscript?.content) return content;
  return paragraphText(session.paragraphization, content);
}

function dependencyFor(stage, session) {
  if (stage === 'cleanup') {
    const source = cleanupSourceArtifact(session);
    return { key: source.key, fingerprint: fingerprint(source.content) };
  }
  if (['translation', 'cleaned-translation'].includes(stage)) {
    const content = session.artifacts.cleanedTranscript?.content || '';
    return { key: 'cleanedTranscript', fingerprint: fingerprint(content) };
  }
  if (stage === 'notes-translation') return { key: 'notes', fingerprint: fingerprint(session.artifacts.notes?.content || '') };
  if (stage === 'outline-translation') return { key: 'outline', fingerprint: fingerprint(session.artifacts.outline?.content || '') };
  const key = session.artifacts.cleanedTranscript?.content ? 'cleanedTranscript'
    : 'rawTranscript';
  return { key, fingerprint: fingerprint(session.artifacts[key]?.content || '') };
}

function materialContext(materials) {
  const ready = materials.filter((item) => item.extractedText);
  if (!ready.length) return 'No course materials were attached. Ground the output only in the transcript and mark unclear claims as uncertain.';
  let remaining = 180_000;
  const sections = [];
  for (const [index, item] of ready.entries()) {
    if (remaining <= 0) break;
    const label = `M${index + 1}`;
    const allowance = Math.min(60_000, remaining);
    const excerpt = item.extractedText.slice(0, allowance);
    remaining -= excerpt.length;
    const notice = excerpt.length < item.extractedText.length ? '\n[Material excerpt truncated to fit the local model context.]' : '';
    sections.push(`--- [${label}: ${item.filename}] ---\n${excerpt}${notice}`);
  }
  return sections.join('\n\n');
}

export function semanticTranslationChunks(content, maxCharacters = 6000) {
  const blocks = String(content || '').split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const block of blocks) {
    if (current && current.length + block.length + 2 > maxCharacters) {
      chunks.push(current);
      current = '';
    }
    if (block.length <= maxCharacters) {
      current = current ? `${current}\n\n${block}` : block;
      continue;
    }
    if (current) { chunks.push(current); current = ''; }
    const lines = block.split('\n');
    let part = '';
    for (const line of lines) {
      if (line.length > maxCharacters) {
        if (part) { chunks.push(part); part = ''; }
        let remaining = line;
        while (remaining.length > maxCharacters) {
          const window = remaining.slice(0, maxCharacters + 1);
          const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'));
          const whitespace = window.lastIndexOf(' ');
          const cut = sentence >= Math.floor(maxCharacters * 0.55) ? sentence + 1
            : whitespace >= Math.floor(maxCharacters * 0.55) ? whitespace : maxCharacters;
          chunks.push(remaining.slice(0, cut).trim());
          remaining = remaining.slice(cut).trimStart();
        }
        if (remaining) part = remaining;
        continue;
      }
      if (part && part.length + line.length + 1 > maxCharacters) { chunks.push(part); part = ''; }
      part = part ? `${part}\n${line}` : line;
    }
    if (part) chunks.push(part);
  }
  if (current) chunks.push(current);
  return chunks;
}

function translationSource(stage, session) {
  if (['translation', 'cleaned-translation'].includes(stage)) return { key: 'cleanedTranscript', label: 'cleaned transcript' };
  if (stage === 'notes-translation') return { key: 'notes', label: 'lecture notes' };
  if (stage === 'outline-translation') return { key: 'outline', label: 'concept outline' };
  return null;
}

function buildPrompt(stage, session, options = {}) {
  const cleanupSource = cleanupSourceArtifact(session);
  const rawContent = nonEmpty(cleanupSource.content, 'A transcript');
  const raw = paragraphText(cleanupSource.structure, rawContent);
  const transcript = transcriptFor(session);
  const target = String(options.targetLanguage || session.targetLanguage || 'Chinese').slice(0, 80);
  const materials = materialContext(session.materials);
  const translateDocument = (sourceKey, label) => {
    const source = nonEmpty(session.artifacts[sourceKey]?.content, label);
    return `Translate the following ${label.toLowerCase()} into ${target}. Preserve Markdown headings, bullets, numbering, formulas, technical terms, and structural relationships. Do not summarize, flatten, or add commentary.\n\n${label.toUpperCase()}:\n${source}`;
  };
  switch (stage) {
    case 'cleanup':
      return cleanupPrompt({ sourceText: raw, previousContext: '', followingContext: '' });
    case 'translation':
      return `Translate the lecture transcript into ${target}. Preserve headings, technical terms, examples, formulas, and uncertainty. Do not summarize.\n\nTRANSCRIPT:\n${transcript}`;
    case 'cleaned-translation':
      return translateDocument('cleanedTranscript', 'Cleaned transcript');
    case 'notes-translation':
      return translateDocument('notes', 'Lecture notes');
    case 'outline-translation':
      return translateDocument('outline', 'Concept outline');
    case 'key-points':
      return `Extract the lecture's key points as concise Markdown. Organize related points under descriptive headings. Include definitions, claims, examples, and cautions; do not invent missing detail.\n\nTRANSCRIPT:\n${transcript}`;
    case 'qa':
      return `Create a study Q&A set from this lecture. Use Markdown headings and numbered question/answer pairs. Answers must be supported by the transcript. Include conceptual, comparison, and application questions.\n\nTRANSCRIPT:\n${transcript}`;
    case 'analysis':
      return `Produce a structured lecture analysis in Markdown with: Overview, Learning objectives, Main topics, Important terms, Examples, Open questions, and a short Review checklist. Stay faithful to the transcript.\n\nTRANSCRIPT:\n${transcript}`;
    case 'notes':
      return `Create useful, course-aware structured lecture notes in Markdown.
Requirements:
- Use a clear hierarchy, definitions, explanations, examples, formulas, and takeaways.
- Reconcile transcript terminology with the materials when supported.
- Cite material-grounded statements inline as [M1], [M2], etc. Never cite a material that does not support the statement.
- Mark transcript-only content with [Transcript] when source distinction matters.
- End with “Source map” listing each used source and “Uncertainties” listing conflicts or gaps.

TRANSCRIPT:
${transcript}

COURSE MATERIALS:
${materials}`;
    case 'outline':
      return `Create a hierarchical concept outline in Markdown from the lecture and materials.
Requirements:
- Use # for the course/lecture theme, ## for major concepts, ### for sub-concepts, and bullets for definitions, relationships, prerequisites, and examples.
- Explicitly show relationships with labels such as “depends on”, “contrasts with”, “causes”, or “example of”.
- Add [M1], [M2], etc. to material-grounded items and [Transcript] where useful.
- Do not add unsupported concepts.

TRANSCRIPT:
${transcript}

COURSE MATERIALS:
${materials}`;
    default:
      throw Object.assign(new Error('Unknown pipeline stage'), { status: 400 });
  }
}

export async function runStage({ stage, session, llm, options = {}, onCleanupProgress, onCleanupLog }) {
  const artifactKey = STAGE_TO_ARTIFACT[stage];
  if (!artifactKey) throw Object.assign(new Error('Unknown pipeline stage'), { status: 400 });
  const model = String(options.model || session.llmModel || process.env.OLLAMA_MODEL || 'qwen3.5:4b');
  if (stage === 'cleanup') {
    const dependency = dependencyFor(stage, session);
    const cleaned = await runCleanupStage({
      session,
      llm,
      model,
      options,
      onLog: onCleanupLog,
      onProgress: onCleanupProgress
        ? async (partial) => onCleanupProgress({
          ...partial,
          experimentVariant: 'C',
          source: stage,
          sourceFingerprint: dependency.fingerprint,
          dependsOn: dependency,
          generationFingerprint: fingerprint(`${stage}:${dependency.fingerprint}:${model}`),
          model,
          sourceArtifact: dependency.key,
        })
        : undefined,
    });
    return {
      key: artifactKey,
      artifact: {
        ...cleaned,
        experimentVariant: 'C',
        source: stage,
        sourceFingerprint: dependency.fingerprint,
        dependsOn: dependency,
        generationFingerprint: fingerprint(`${stage}:${dependency.fingerprint}:${model}`),
        model,
        generationState: 'complete',
        generatedAt: new Date().toISOString(),
        sourceArtifact: dependency.key,
      },
    };
  }
  const source = translationSource(stage, session);
  let prompt = buildPrompt(stage, session, options);
  let result;
  let sourceChunks = [];
  if (source) {
    const target = String(options.targetLanguage || session.targetLanguage || 'Chinese').slice(0, 80);
    const chunks = semanticTranslationChunks(nonEmpty(session.artifacts[source.key]?.content, source.label));
    const translated = [];
    const results = [];
    for (const [index, chunk] of chunks.entries()) {
      const context = chunks.slice(Math.max(0, index - 2), index).join('\n\n').slice(-1800);
      prompt = `Translate only the CURRENT ${source.label.toUpperCase()} BLOCK into ${target}. Preserve Markdown headings, bullets, numbering, nesting, formulas, terminology, and document structure. Do not summarize or add commentary.${context ? `\n\nPRECEDING SOURCE CONTEXT (for terminology only; do not translate it again):\n${context}` : ''}\n\nCURRENT BLOCK:\n${chunk}`;
      const chunkResult = await llm.generate({ model, prompt, ...taskOptions(stage, options) });
      const translatedChunk = String(chunkResult?.content || '').trim();
      if (!translatedChunk) {
        throw Object.assign(new Error(`Translation model returned no text for block ${index + 1}`), { status: 502, code: 'INVALID_MODEL_RESPONSE' });
      }
      translated.push(translatedChunk);
      results.push(chunkResult);
      sourceChunks.push({ index, sourceFingerprint: fingerprint(chunk), characters: chunk.length });
    }
    const last = results.at(-1) || {};
    result = {
      ...last,
      content: translated.join('\n\n'),
      metrics: results.reduce((total, item) => ({
        inputTokens: Number(total.inputTokens || 0) + Number(item.metrics?.inputTokens || 0),
        outputTokens: Number(total.outputTokens || 0) + Number(item.metrics?.outputTokens || 0),
      }), {}),
    };
  } else {
    result = await llm.generate({
      model,
      prompt,
      retrievedContextCharacters: ['notes', 'outline'].includes(stage) ? materialContext(session.materials).length : 0,
      ...taskOptions(stage, options),
    });
  }
  if (!String(result?.content || '').trim()) {
    throw Object.assign(new Error('Local model returned no usable output'), { status: 502, code: 'INVALID_MODEL_RESPONSE' });
  }
  const materialIds = ['notes', 'outline'].includes(stage)
    ? session.materials.filter((item) => item.extractedText).map((item) => item.id)
    : [];
  return {
    key: artifactKey,
    artifact: {
      content: result.content,
      source: stage,
      sourceFingerprint: dependencyFor(stage, session).fingerprint,
      dependsOn: dependencyFor(stage, session),
      generationFingerprint: fingerprint(`${stage}:${dependencyFor(stage, session).fingerprint}:${String(options.targetLanguage || session.targetLanguage || '')}:${model}`),
      model,
      provider: result.provider,
      metrics: result.metrics,
      chunks: sourceChunks,
      materialIds,
      ...(['notes', 'outline'].includes(stage) ? { materialContextFingerprint: correctionMaterialsFingerprint(session.materials) } : {}),
      generationState: 'complete',
      generatedAt: new Date().toISOString(),
      targetLanguage: ['translation', 'cleaned-translation', 'notes-translation', 'outline-translation'].includes(stage)
        ? String(options.targetLanguage || session.targetLanguage || 'Chinese') : undefined,
      sourceArtifact: dependencyFor(stage, session).key,
    },
  };
}

export function artifactForStage(stage) {
  return STAGE_TO_ARTIFACT[stage];
}

const TERMINATORS = new Set(['.', '!', '?', '…', '。', '！', '？']);
const CLOSERS = new Set(['"', "'", '’', '”', '»', ')', ']', '}', '）', '］', '｝']);
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'rev', 'gen',
  'fig', 'eq', 'no', 'nos', 'approx', 'dept', 'inc', 'vs', 'etc', 'e.g', 'i.e',
]);
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

function isUpperCase(value) {
  const letter = String(value || '').match(/[\p{L}]/u)?.[0];
  return Boolean(letter && letter === letter.toLocaleUpperCase() && letter !== letter.toLocaleLowerCase());
}

function nextSignificant(value, index) {
  let cursor = index;
  while (cursor < value.length && /\s/u.test(value[cursor])) cursor += 1;
  return { index: cursor, value: value[cursor] || '' };
}

function tokenBefore(value, index) {
  return value.slice(0, index).match(/[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*$/u)?.[0] || '';
}

function isUrlOrEmailInterior(value, index) {
  const left = value.slice(Math.max(0, index - 200), index);
  const next = value[index + 1] || '';
  return LETTER_OR_NUMBER.test(next) && /(?:https?:\/\/|www\.|@)[^\s]*$/iu.test(left);
}

function punctuationRunEnd(value, index) {
  let end = index;
  while (end + 1 < value.length && TERMINATORS.has(value[end + 1])) end += 1;
  return end;
}

function shouldSplit(value, runStart, runEnd) {
  const punctuation = value[runEnd];
  const next = value[runEnd + 1] || '';
  const nextInfo = nextSignificant(value, runEnd + 1);
  const nextValue = nextInfo.value;

  if (punctuation === '!' || punctuation === '?' || punctuation === '。' || punctuation === '！' || punctuation === '？') return true;
  if (punctuation === '…' || runEnd - runStart >= 2) {
    return !nextValue || isUpperCase(nextValue) || /[\p{N}\u3400-\u9fff\uf900-\ufaff]/u.test(nextValue);
  }
  if (value[runEnd - 1] === '.' || value[runEnd + 1] === '.') {
    return !nextValue || isUpperCase(nextValue) || /[\p{N}\u3400-\u9fff\uf900-\ufaff]/u.test(nextValue);
  }
  if (/\d/u.test(value[runEnd - 1] || '') && /\d/u.test(next)) return false;
  if (isUrlOrEmailInterior(value, runEnd)) return false;

  const token = tokenBefore(value, runEnd);
  const lowerToken = token.toLocaleLowerCase();
  if (ABBREVIATIONS.has(lowerToken)) return false;
  if (/^[A-Za-z]$/u.test(token) && nextValue && isUpperCase(nextValue)) return false;
  if (/^[A-Za-z](?:\.[A-Za-z])+$/.test(token)) return false;

  // A missing space after a long word is a common ASR formatting error. Treat
  // it as a boundary, while keeping initials and dotted abbreviations intact.
  if (next && !/\s/u.test(next) && LETTER_OR_NUMBER.test(next) && token.length <= 3) return false;
  return true;
}

function splitParagraph(value) {
  const text = String(value || '').split(/\n+/u).map((line) => line.trim()).filter(Boolean).join(' ');
  if (!text) return [];
  const sentences = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    if (!TERMINATORS.has(text[index])) {
      index += 1;
      continue;
    }
    const runEnd = punctuationRunEnd(text, index);
    if (shouldSplit(text, index, runEnd)) {
      let end = runEnd + 1;
      while (end < text.length && CLOSERS.has(text[end])) end += 1;
      const sentence = text.slice(start, end).trim();
      if (sentence) sentences.push(sentence);
      start = end;
      while (start < text.length && /\s/u.test(text[start])) start += 1;
      index = start;
      continue;
    }
    index = runEnd + 1;
  }
  const tail = text.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences;
}

/**
 * Split transcript text into conservative sentence units while preserving
 * blank-line semantic paragraph breaks. Single newlines are treated as soft
 * wrapping and collapsed before sentence detection.
 */
export function splitSentences(value) {
  return String(value || '')
    .replace(/\r\n?/gu, '\n')
    .trim()
    .split(/\n{2,}/u)
    .flatMap((paragraph) => splitParagraph(paragraph));
}

/**
 * Normalize sentence spacing inside semantic paragraphs. Model-supplied blank
 * lines remain paragraph boundaries; soft line wrapping is collapsed so a
 * sentence never becomes a paragraph merely because it was placed on a line.
 */
export function sentenceParagraphText(value) {
  const paragraphs = String(value || '')
    .replace(/\r\n?/gu, '\n')
    .trim()
    .split(/\n{2,}/u)
    .map((paragraph) => splitParagraph(paragraph).join(' '))
    .filter(Boolean);
  return paragraphs.join('\n\n').trim();
}

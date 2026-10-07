// Correction retrieval deliberately favors abstention over weak topical matches.
// These words can support prose but cannot identify terminology to repair.
const GENERIC_WORDS = new Set(`
  a about above across actually after again against ago all almost already also although always am an and any another
  anything are around as ask asked asking at away back be because become becomes been before being below better between
  big bigger biggest both but by can cannot case cheap class classes come comes coming could day days did do does doing done down each either else
  enough even ever every everything example few find first five follow following for four from further get gets getting
  fast give given gives go goes going good got had has have having he her here hers him his hour hours how however i if in into is it its
  itself just keep kind know last later least less let like little look looked looking lot made make makes many may me
  might minute minutes month months more most much must my near need needs never new next no nobody none nor not nothing now of off often okay on
  once one only onto or other others otherwise our out over own part per perhaps please private probably public put quite rather really
  right same say says second see seen several shall she should since six so some somebody something sometimes still such
  sure take takes task tasks than that the their them themselves then there these they thing things think third this those
  small smaller smallest slow three through time times to today together too two under until up us use used useful uses using usually very want was
  way ways we week weeks well were what whatever when where whether which while who why will with within without would year years
  yes yet you your yourself model models system systems tool tools result results question questions answer answers
  information content context lecture slide slides read write wrote written number numbers item items step steps
`.trim().split(/\s+/u));

function normalizeToken(value) {
  let word = value.toLocaleLowerCase();
  // Light inflection normalization keeps build/buy and their spoken -ing forms
  // aligned without treating unrelated words as fuzzy spelling matches.
  if (word.length > 4 && word.endsWith('s') && !/(?:ss|us|is|es)$/u.test(word)) word = word.slice(0, -1);
  if (word.length > 5 && word.endsWith('ing')) word = word.slice(0, -3);
  return word;
}

function words(value) {
  return [...String(value || '').matchAll(/[\p{L}\p{N}_]+/gu)].map((match) => ({
    original: match[0],
    term: normalizeToken(match[0]),
  }));
}

function isAnchor(word) {
  return word.term.length >= 3 && /^\p{L}+$/u.test(word.term)
    && !GENERIC_WORDS.has(word.term) && !GENERIC_WORDS.has(word.original.toLocaleLowerCase());
}

function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 0; i < left.length; i += 1) {
    const current = [i + 1];
    for (let j = 0; j < right.length; j += 1) {
      current.push(Math.min(current[j] + 1, previous[j + 1] + 1, previous[j] + (left[i] === right[j] ? 0 : 1)));
    }
    previous = current;
  }
  return previous[right.length];
}

function anchoredNearMatch(queryWords, candidateWords) {
  // A spelling approximation is only supporting evidence beside an exact
  // terminology anchor: "Base theorem" may retrieve "Bayes theorem". It can
  // never retrieve a passage by itself (or match generic right/light prose).
  for (let q = 0; q < queryWords.length; q += 1) {
    if (!isAnchor(queryWords[q])) continue;
    for (let c = 0; c < candidateWords.length; c += 1) {
      if (queryWords[q].term !== candidateWords[c].term) continue;
      for (const direction of [-1, 1]) {
        const left = queryWords[q + direction];
        const right = candidateWords[c + direction];
        if (!left || !right || !isAnchor(left) || !isAnchor(right)) continue;
        if (left.term === right.term || Math.min(left.term.length, right.term.length) < 4) continue;
        if (left.term.slice(0, 2) !== right.term.slice(0, 2)) continue;
        const maximumLength = Math.max(left.term.length, right.term.length);
        const distanceLimit = Math.max(2, Math.ceil(maximumLength * 0.5));
        if (Math.abs(left.term.length - right.term.length) <= 2
          && editDistance(left.term, right.term) <= distanceLimit) return true;
      }
    }
  }
  return false;
}

function materialSnippets(value, maxCharacters) {
  const blocks = String(value || '').replace(/\r\n?/gu, '\n')
    .split(/\f|\n\s*\n|(?=^#{1,6}\s)/gmu)
    .map((block) => block.replace(/[\t ]+/gu, ' ').trim()).filter(Boolean);
  const snippets = [];
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  for (const block of blocks) {
    if (block.length <= maxCharacters) {
      snippets.push(block);
      continue;
    }
    let current = '';
    for (const { segment } of segmenter.segment(block)) {
      const sentence = segment.trim();
      if (sentence.length > maxCharacters) {
        if (current) snippets.push(current);
        current = '';
        continue; // Do not provide a misleading fragment of an oversized sentence.
      }
      if (current && current.length + sentence.length + 1 > maxCharacters) {
        snippets.push(current);
        current = '';
      }
      current = current ? `${current} ${sentence}` : sentence;
    }
    if (current) snippets.push(current);
  }
  return snippets;
}

export const CORRECTION_RETRIEVAL_PROFILE = Object.freeze({
  method: 'lexical-anchors',
  vectorized: false,
  vectorStore: null,
  maximumSnippetCharacters: 1800,
  maximumSelectedSnippets: 3,
  maximumSelectedCharacters: 2400,
});

/** Describe the deterministic retrieval units prepared from one material. */
export function summarizeCorrectionMaterial(value, { maxSnippetCharacters = CORRECTION_RETRIEVAL_PROFILE.maximumSnippetCharacters } = {}) {
  const snippets = materialSnippets(value, Math.max(80, Number(maxSnippetCharacters) || CORRECTION_RETRIEVAL_PROFILE.maximumSnippetCharacters));
  const chunks = snippets.map((snippet, index) => {
    const chunkAnchors = new Set(words(snippet).filter(isAnchor).map((word) => word.term));
    return { chunk: index + 1, characters: snippet.length, anchorTermCount: chunkAnchors.size };
  });
  const anchors = new Set(snippets.flatMap((snippet) => words(snippet).filter(isAnchor).map((word) => word.term)));
  return {
    ...CORRECTION_RETRIEVAL_PROFILE,
    characterCount: String(value || '').length,
    chunkCount: snippets.length,
    anchorTermCount: anchors.size,
    largestChunkCharacters: snippets.reduce((maximum, snippet) => Math.max(maximum, snippet.length), 0),
    chunks,
  };
}

function limit(value, fallback) {
  return Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : fallback;
}

/** Retrieve complete terminology evidence for minimal corrections, or abstain. */
export function retrieveCorrectionEvidence(materials, query, { maxCharacters = 2400, maxSnippets = 3 } = {}) {
  const characterLimit = limit(maxCharacters, 2400);
  const snippetLimit = limit(maxSnippets, 3);
  const queryWords = words(query);
  const queryAnchors = new Set(queryWords.filter(isAnchor).map((word) => word.term));
  const diagnostics = {
    method: CORRECTION_RETRIEVAL_PROFILE.method,
    vectorized: false,
    queryAnchorCount: queryAnchors.size,
    candidateChunks: 0,
    rankedChunks: 0,
    selectedChunks: 0,
    selectedCharacters: 0,
    characterLimit,
    snippetLimit,
  };
  const empty = { snippets: [], materialIds: [], text: '', diagnostics };
  if (!characterLimit || !snippetLimit || !queryAnchors.size) return empty;

  const candidates = [];
  const seen = new Set();
  for (const [materialIndex, material] of (materials || []).entries()) {
    const label = `M${materialIndex + 1}`;
    for (const [snippetIndex, text] of materialSnippets(material?.extractedText, Math.min(1800, characterLimit)).entries()) {
      const identity = text.replace(/\s+/gu, ' ').toLocaleLowerCase();
      if (seen.has(identity)) continue;
      seen.add(identity);
      const candidateWords = words(text);
      candidates.push({
        id: `${label}:S${snippetIndex + 1}`, label, materialId: material.id,
        filename: material.filename, snippetIndex, text,
        words: candidateWords, anchors: new Set(candidateWords.filter(isAnchor).map((word) => word.term)),
      });
    }
  }
  diagnostics.candidateChunks = candidates.length;

  const frequencies = new Map();
  for (const candidate of candidates) {
    for (const term of candidate.anchors) frequencies.set(term, (frequencies.get(term) || 0) + 1);
  }
  const ranked = [];
  for (const candidate of candidates) {
    const shared = [...queryAnchors].filter((term) => candidate.anchors.has(term));
    if (!shared.length) continue;
    const nearMatch = anchoredNearMatch(queryWords, candidate.words);
    const namedAcronym = queryWords.some((word) => isAnchor(word) && /^[A-Z]{3,}$/u.test(word.original)
      && candidate.words.some((other) => other.original === word.original));
    if (shared.length < 2 && !nearMatch && !namedAcronym) continue;
    const weight = shared.reduce((sum, term) => sum + 1 + Math.log((candidates.length + 1) / ((frequencies.get(term) || 0) + 1)), 0);
    const density = Math.min(1, (shared.length + Number(nearMatch)) / Math.sqrt(Math.max(1, candidate.anchors.size)));
    const score = (weight + Number(nearMatch) + Number(namedAcronym)) * density;
    const { words: ignoredWords, anchors: ignoredAnchors, ...snippet } = candidate;
    ranked.push({ ...snippet, score: Math.round(score * 1000) / 1000 });
  }
  diagnostics.rankedChunks = ranked.length;
  ranked.sort((left, right) => right.score - left.score || left.label.localeCompare(right.label) || left.snippetIndex - right.snippetIndex);

  const snippets = [];
  const sections = [];
  let characters = 0;
  for (const snippet of ranked) {
    if (snippets.length >= snippetLimit) break;
    const section = `--- [${snippet.id}] ${snippet.filename} ---\n${snippet.text}`;
    const added = section.length + (sections.length ? 2 : 0);
    if (characters + added > characterLimit) continue;
    snippets.push(snippet);
    sections.push(section);
    characters += added;
  }
  diagnostics.selectedChunks = snippets.length;
  diagnostics.selectedCharacters = characters;
  return { snippets, materialIds: [...new Set(snippets.map((snippet) => snippet.materialId))], text: sections.join('\n\n'), diagnostics };
}

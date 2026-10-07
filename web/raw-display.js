const WORDS = /[\p{L}\p{N}]+/gu;

function wordCount(text) {
  return (String(text || '').match(WORDS) || []).length;
}

function makeBlock(items, index, previous) {
  const first = items[0];
  return {
    id: previous?.id || `raw_block_${first?.id || index}`,
    segmentIds: items.map((item) => item.id),
    segments: items,
    finalized: Boolean(previous?.finalized),
  };
}

/** Presentation-only grouping for Raw translation units. */
export function groupRawDisplayBlocks(segments = [], pendingText = '', previousBlocks = [], {
  semanticGroups = [],
  pendingTranslation = null,
} = {}) {
  const values = segments.map((segment, index) => ({
    ...segment,
    id: String(segment.id || `raw_unit_${index}`),
    sourceText: String(segment.sourceText ?? segment.text ?? '').trim(),
  })).filter((segment) => segment.sourceText);
  const priorByFirst = new Map((previousBlocks || []).map((block) => [block.segmentIds?.[0], block]));
  const semanticGroupById = new Map(semanticGroups.flatMap((group, index) => group.map((segmentId) => [String(segmentId), index])));
  const blocks = [];
  let cursor = 0;
  for (const prior of previousBlocks || []) {
    const count = prior.segmentIds?.length || 0;
    if (!count || cursor + count > values.length) break;
    const candidate = values.slice(cursor, cursor + count);
    const sameSource = candidate.length === count
      && candidate.every((item, index) => item.sourceText === prior.segments?.[index]?.sourceText || item.id === prior.segmentIds[index]);
    if (!sameSource) break;
    const isTrailing = cursor + count === values.length;
    if (prior.finalized) {
      blocks.push(makeBlock(candidate, blocks.length, prior));
      cursor += count;
    } else break;
  }
  while (cursor < values.length) {
    const items = [];
    let words = 0;
    while (cursor + items.length < values.length && items.length < 3) {
      const next = values[cursor + items.length];
      const firstGroup = semanticGroupById.get(items[0]?.id);
      const nextGroup = semanticGroupById.get(next.id);
      if (items.length && firstGroup !== undefined && nextGroup !== undefined && firstGroup !== nextGroup) break;
      const nextWords = wordCount(next.sourceText);
      if (items.length && words >= 15 && words + nextWords > 40) break;
      items.push(next);
      words += nextWords;
      if (words >= 40) break;
    }
    const prior = priorByFirst.get(items[0]?.id);
    const isLast = cursor + items.length >= values.length;
    blocks.push(makeBlock(items, blocks.length, prior));
    blocks.at(-1).finalized = Boolean(prior?.finalized || !isLast);
    cursor += items.length;
  }
  if (pendingText) {
    const tail = blocks.at(-1);
    if (tail && !tail.finalized) {
      tail.pendingText = String(pendingText).trim();
      tail.pendingTranslation = pendingTranslation;
    } else {
      blocks.push({
        id: pendingTranslation?.id || `raw_block_pending_${blocks.length}`,
        segmentIds: [],
        segments: [],
        pendingText: String(pendingText).trim(),
        pendingTranslation,
        finalized: false,
      });
    }
  }
  return blocks;
}

export function blockSourceText(block) {
  return (block?.segments || []).map((segment) => segment.sourceText).filter(Boolean).join(' ');
}

export function blockTranslationText(block) {
  return (block?.segments || []).map((segment) => segment.translatedText).filter(Boolean).join(' ');
}

export function blockDisplayTranslationText(block) {
  return (block?.segments || [])
    .map((segment) => segment.translatedText || segment.previousTranslatedText)
    .filter(Boolean)
    .join(' ');
}

/** Build the one ordered sequence consumed by the paired Raw renderer. */
export function buildRawAlignmentUnits(blocks = []) {
  return blocks.map((block, index) => {
    const sourceText = blockSourceText(block);
    const pendingText = String(block?.pendingText || '').trim();
    const translatedText = [blockTranslationText(block), block?.pendingTranslation?.translatedText]
      .filter(Boolean).join(' ');
    const displayTranslatedText = [
      blockDisplayTranslationText(block),
      block?.pendingTranslation?.translatedText || block?.pendingTranslation?.previousTranslatedText,
    ].filter(Boolean).join(' ');
    const allSegments = [
      ...(block?.segments || []),
      ...(pendingText && block?.pendingTranslation ? [block.pendingTranslation] : []),
    ];
    const hasPreviousTranslation = allSegments
      .some((segment) => segment.status === 'updating' || (!segment.translatedText && Boolean(segment.previousTranslatedText)));
    const statuses = [
      ...(block?.segments || []).map((segment) => segment.status),
      ...(pendingText ? [block?.pendingTranslation?.status || 'pending'] : []),
    ];
    const hasRevisionError = hasPreviousTranslation && statuses.includes('error');
    const status = statuses.includes('error') && !translatedText
      ? 'error'
      : statuses.includes('translating') && !translatedText
        ? 'translating'
        : translatedText && statuses.some((value) => value !== 'translated')
          ? 'partial'
          : translatedText ? 'translated' : 'pending';
    return {
      ...block,
      id: String(block?.id || `raw_alignment_${index}`),
      sourceText: [sourceText, pendingText].filter(Boolean).join(' '),
      translatedText,
      displayTranslatedText,
      hasPreviousTranslation,
      hasRevisionError,
      pendingText,
      status,
    };
  });
}

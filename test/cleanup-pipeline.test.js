import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cleanupPrompt,
  cleanupSourceParagraphs,
  cleanupWindows,
  runStage,
  validateCleanupOutput,
} from '../src/pipeline.js';

function sessionWith(raw, paragraphization = null, cleanedTranscript = null) {
  return {
    llmModel: 'cleanup-test:1b',
    targetLanguage: 'Chinese',
    materials: [],
    paragraphization,
    artifacts: {
      rawTranscript: { content: raw },
      cleanedTranscript,
      notes: null,
      outline: null,
    },
  };
}

class ScriptedCleanupLLM {
  constructor(outputs) {
    this.outputs = [...outputs];
    this.calls = [];
  }

  async generate(args) {
    this.calls.push(args);
    return { content: this.outputs.shift() ?? '', provider: 'scripted', model: args.model, metrics: {} };
  }
}

test('cleanup prompt requests grounded sentence, disfluency, ASR, and paragraph repair without translation', () => {
  const prompt = cleanupPrompt({
    sourceText: 'uh the eigen value is stable.',
    previousContext: 'We study matrices.',
    followingContext: 'The formula follows.',
    lectureReference: 'Earlier the lecturer defined eigenvalues.',
  });
  assert.match(prompt, /false starts and disfluencies/i);
  assert.match(prompt, /foreign-language speech/i);
  assert.match(prompt, /never summarize/i);
  assert.match(prompt, /what the lecturer actually said/i);
  assert.match(prompt, /28 × 28 pixels corresponding to 784 inputs/i);
  assert.match(prompt, /\[unclear\]/i);
  assert.match(prompt, /semantic paragraphs/i);
  assert.match(prompt, /TARGET REGION/);
  assert.match(prompt, /previous_context/);
  assert.match(prompt, /following_context/);
  assert.match(prompt, /lecture_reference/);
});

test('validation does not mistake ordinary teaching language for model commentary', () => {
  assert.equal(validateCleanupOutput("Here's an example of a tree.", "Here's an example of a tree.").ok, true);
  assert.equal(validateCleanupOutput('The cleaned transcript follows.', 'Here is the cleaned transcript: The cleaned transcript follows.').ok, false);
});

test('cleanup validation accepts grounded punctuation and contextual ASR repair', () => {
  const source = 'I mean this, this, and this. Are also recognizable as trees, even though...';
  const result = validateCleanupOutput(source, 'I mean, this, this, and this are also recognizable as threes, even though...');
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
});

test('cleanup validation rejects expansion, deletion, commentary, translation, and duplicated output', () => {
  assert.equal(validateCleanupOutput('The lecture defines a useful technical term and gives an example.', 'Here is the cleaned transcript with a long unrelated explanation.').ok, false);
  assert.equal(validateCleanupOutput('The lecture defines a useful technical term and gives an example.', 'The lecture.').reason, 'large-deletion');
  assert.equal(validateCleanupOutput('The lecture defines a useful technical term and gives an example.', '这是一个完全不同的翻译。').reason, 'unexpected-translation');
  assert.equal(validateCleanupOutput('这是一个关于概率的重要讲座。', 'This is an important lecture about probability.').reason, 'unexpected-translation');
  assert.equal(validateCleanupOutput('Bayes theorem. Evidence matters.', 'Bayes theorem. Bayes theorem. Evidence matters.').reason, 'duplicated-output');
  assert.equal(validateCleanupOutput('The lecture defines a useful technical term and gives an example.', '{"content":"The lecture defines a useful technical term and gives an example."}').reason, 'malformed-output');
});

test('cleanup windows are bounded, ordered, overlapping only through read-only context, and source-complete', () => {
  const paragraphs = Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, ordinal: index, text: `Paragraph ${index} contains a sentence about eigenvalues and matrices.` }));
  const windows = cleanupWindows(paragraphs, { maxTargetCharacters: 70, contextCharacters: 80 });
  assert.ok(windows.length > 1);
  assert.equal(windows.every((window) => window.sourceText.length <= 70), true);
  assert.deepEqual(windows.flatMap((window) => window.sourceText.split('\n\n')), paragraphs.map((paragraph) => paragraph.text));
  assert.equal(windows[1].previousContext.length <= 80, true);
  assert.equal(windows[0].followingContext.length <= 80, true);
  assert.equal(windows.every((window) => window.contextFingerprint), true);
  assert.match(cleanupPrompt(windows[1]), /read-only/);
  assert.equal(validateCleanupOutput(windows[1].sourceText, `${windows[1].previousContext} ${windows[1].sourceText}`, windows[1]).reason, 'context-leakage');
});

test('cleanup source paragraphs use canonical Raw text even when old paragraph segments disagree', () => {
  const raw = 'Canonical first sentence. Canonical second sentence.';
  const session = sessionWith(raw, {
    paragraphs: [{ id: 'paragraph_1', segmentIds: ['old_1', 'old_2'] }],
    segments: [{ id: 'old_1', text: 'Provider wording.', start: 0, end: 1 }, { id: 'old_2', text: 'Different wording.', start: 1, end: 2 }],
  });
  assert.deepEqual(cleanupSourceParagraphs(session).map((paragraph) => paragraph.text), [raw]);
});

test('cleanup retries once on invalid model output and falls back to the canonical source', async () => {
  const llm = new ScriptedCleanupLLM([
    'Unrelated additions with unsupported facts.',
    'Still not grounded.',
  ]);
  const raw = 'The lecturer defines conditional probability and gives an example.';
  const result = await runStage({ stage: 'cleanup', session: sessionWith(raw), llm });
  assert.equal(llm.calls.length, 2);
  assert.equal(result.artifact.content, raw);
  assert.equal(result.artifact.regions[0].status, 'fallback');
  assert.equal(result.artifact.metrics.fallback, 1);
});

test('cleanup preserves technical terms, formulas, foreign speech, uncertain wording, and Raw immutability', async () => {
  const raw = 'The eigenvalue lambda equals zero. La vida sigue. It must have been living under a rock. To motivate the relevance...';
  const cleaned = 'The eigenvalue λ equals zero. La vida sigue. It must have been living under a rock. To motivate the relevance...';
  const llm = new ScriptedCleanupLLM([cleaned]);
  const session = sessionWith(raw);
  const result = await runStage({ stage: 'cleanup', session, llm });
  assert.equal(result.artifact.content, cleaned);
  assert.equal(session.artifacts.rawTranscript.content, raw);
  assert.match(result.artifact.content, /La vida sigue/);
  assert.match(result.artifact.content, /living under a rock/);
});

test('cleanup keeps model-supplied semantic paragraph breaks in the cleaned artifact', async () => {
  const raw = 'First idea is introduced. Second idea follows.';
  const llm = new ScriptedCleanupLLM(['First idea is introduced.\n\nSecond idea follows.']);
  const result = await runStage({ stage: 'cleanup', session: sessionWith(raw), llm });
  assert.equal(result.artifact.content, 'First idea is introduced.\n\nSecond idea follows.');
});

test('cleanup groups related sentences inside semantic paragraphs', async () => {
  const raw = 'First idea is introduced. Second idea follows.\nA wrapped continuation belongs to the same paragraph.\n\nA new paragraph starts here!';
  const llm = new ScriptedCleanupLLM(['First idea is introduced. Second idea follows.\nA wrapped continuation belongs to the same paragraph.\n\nA new paragraph starts here!']);
  const result = await runStage({ stage: 'cleanup', session: sessionWith(raw), llm });
  assert.equal(result.artifact.content, 'First idea is introduced. Second idea follows. A wrapped continuation belongs to the same paragraph.\n\nA new paragraph starts here!');
});

test('cleanup removes blank-audio markers and exact chunk-boundary sentence duplicates', async () => {
  const raw = 'Today we define Bayes theorem. Bayes theorem. [BLANK_AUDIO] It combines a prior with evidence.';
  const llm = new ScriptedCleanupLLM(['Today we define Bayes theorem. Bayes theorem. [BLANK_AUDIO] It combines a prior with evidence.']);
  const result = await runStage({ stage: 'cleanup', session: sessionWith(raw), llm });
  assert.equal(result.artifact.content, 'Today we define Bayes theorem. It combines a prior with evidence.');
});

test('cleanup removes an unpunctuated duplicated word while retaining deliberate comma repetition', () => {
  assert.equal(validateCleanupOutput('The probability probability rises.', 'The probability rises.').ok, true);
  assert.equal(validateCleanupOutput('I mean this, this, and this.', 'I mean this, this, and this.').ok, true);
});

test('cleanup reuses unchanged frozen B regions while appended regions generate', async () => {
  const firstParagraph = 'First paragraph is already clear.';
  const secondParagraph = 'Second paragraph needs casing.';
  const firstSession = sessionWith(firstParagraph);
  const initial = await runStage({
    stage: 'cleanup', session: firstSession, llm: new ScriptedCleanupLLM([firstParagraph]),
    options: { cleanupMaxCharacters: 40 },
  });
  const raw = `${firstParagraph} ${secondParagraph}`;
  const paragraphization = {
    paragraphs: [
      { id: 'paragraph_1', segmentIds: ['s1'] },
      { id: 'paragraph_2', segmentIds: ['s2'] },
    ],
    segments: [{ id: 's1', text: firstParagraph }, { id: 's2', text: secondParagraph }],
  };
  const llm = new ScriptedCleanupLLM(['Second paragraph needs Casing.']);
  const result = await runStage({
    stage: 'cleanup', session: sessionWith(raw, paragraphization, initial.artifact), llm,
    options: { cleanupMaxCharacters: 40 },
  });
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].prompt, `Transcript:\n${secondParagraph}`);
  assert.match(result.artifact.content, /First paragraph is already clear/);
  assert.match(result.artifact.content, /Second paragraph needs Casing/);
  assert.equal(result.artifact.metrics.reused, 1);
});

test('targeted course repair preserves spoken dimensions and every other baseline byte', async () => {
  const raw = 'Each image is twenty eight by twenty eight pixels, so the gradiant decent step sends seven hundred and eighty four values into the input neurons.';
  const quote = 'The gradient descent step sends pixel values into the input neurons.';
  const session = sessionWith(raw);
  session.materials = [{ id: 'course', filename: 'course.md', extractedText: quote }];
  const llm = new ScriptedCleanupLLM([raw, JSON.stringify({ edits: [{
    original: 'gradiant decent', replacement: 'gradient descent', kind: 'term', evidenceId: 'M1:S1',
    evidenceQuote: quote, reason: 'The course identifies the step sending these input values as gradient descent.',
  }] })]);
  const result = await runStage({ stage: 'cleanup', session, llm });
  assert.equal(result.artifact.baseline.content, raw);
  assert.equal(result.artifact.content, raw.replace('gradiant decent', 'gradient descent'));
  assert.match(result.artifact.content, /twenty eight by twenty eight pixels/);
  assert.match(result.artifact.content, /seven hundred and eighty four values/);
  assert.equal(result.artifact.metrics.acceptedEdits, 1);
  assert.equal(session.artifacts.rawTranscript.content, raw);
});

test('cleanup uses [unclear] for unrecoverable speech without discarding the supported sentence', async () => {
  const raw = 'The signal goes through the flibbertigibbet thing and changes somehow.';
  const llm = new ScriptedCleanupLLM(['The signal goes through the [unclear] and changes somehow.']);
  const result = await runStage({ stage: 'cleanup', session: sessionWith(raw), llm });
  assert.equal(result.artifact.content, 'The signal goes through the [unclear] and changes somehow.');
  assert.equal(result.artifact.regions[0].status, 'complete');
});

test('cleanup fallback normalizes inaudible ASR markers to [unclear]', async () => {
  const raw = 'The lecture reaches [INAUDIBLE_AUDIO] before the conclusion.';
  const llm = new ScriptedCleanupLLM(['A polished but unsupported summary.']);
  const result = await runStage({ stage: 'cleanup', session: sessionWith(raw), llm });
  assert.equal(result.artifact.content, 'The lecture reaches [unclear] before the conclusion.');
  assert.equal(result.artifact.regions[0].status, 'fallback');
});

test('cleanup validation prevents hallucinated claims and detail-destroying summaries', () => {
  const source = 'The model has two layers and uses ReLU. The lecturer then gives a red-car example and explains why the exception matters.';
  assert.equal(validateCleanupOutput(source, 'The model has two layers, uses ReLU, and achieves 99 percent accuracy.').ok, false);
  assert.equal(validateCleanupOutput(source, 'The lecturer discusses the model and an example.').ok, false);
  assert.equal(validateCleanupOutput(source, 'The model has two layers and uses ReLU. The lecturer then gives a red-car example and explains why the exception matters.').ok, true);
  assert.equal(validateCleanupOutput('The regularization part uses the shabba coefficient before the penalty term.', 'The regularization part uses the lambda coefficient before the penalty term.').reason, 'unsupported-terms');
});

test('long single-paragraph cleanup loses or duplicates no content at target-window boundaries', async () => {
  const sentences = Array.from({ length: 18 }, (_, index) => `Sentence ${index + 1} preserves detail ${index + 101}.`);
  const raw = sentences.join(' ');
  const paragraphization = {
    paragraphs: [{ id: 'paragraph_1', segmentIds: sentences.map((_, index) => `s${index}`) }],
    segments: sentences.map((text, index) => ({ id: `s${index}`, text })),
  };
  const source = cleanupSourceParagraphs(sessionWith(raw, paragraphization));
  const windows = cleanupWindows(source, { maxTargetCharacters: 95 });
  assert.ok(windows.length > 3);
  assert.equal(windows.slice(1).every((window) => window.continuesPreviousParagraph), true);
  const llm = new ScriptedCleanupLLM(windows.map((window) => window.sourceText));
  const result = await runStage({ stage: 'cleanup', session: sessionWith(raw, paragraphization), llm, options: { cleanupMaxCharacters: 95 } });
  assert.equal(result.artifact.content, raw);
  assert.equal(new Set(result.artifact.content.match(/Sentence \d+/gu)).size, sentences.length);
});

test('changed course evidence invalidates old repairs while retaining the frozen B baseline', async () => {
  const raw = 'Base theorem combines prior probability and evidence.';
  const quote = 'Bayes theorem combines prior probability and evidence.';
  const session = sessionWith(raw);
  session.materials = [{ id: 'course', filename: 'course.md', extractedText: quote }];
  const first = await runStage({ stage: 'cleanup', session, llm: new ScriptedCleanupLLM([raw, JSON.stringify({ edits: [{
    original: 'Base', replacement: 'Bayes', kind: 'term', evidenceId: 'M1:S1', evidenceQuote: quote,
    reason: 'The same prior-probability theorem is named Bayes in the material.',
  }] })]) });
  assert.equal(first.artifact.content, raw.replace('Base', 'Bayes'));
  session.artifacts.cleanedTranscript = first.artifact;
  session.materials[0].extractedText = 'A compiler translates source code.';
  const llm = new ScriptedCleanupLLM([]);
  const second = await runStage({ stage: 'cleanup', session, llm });
  assert.equal(llm.calls.length, 0, 'material changes must not regenerate an unchanged B baseline');
  assert.equal(second.artifact.content, raw, 'the removed evidence must not leave its prior repair cached');
  assert.equal(second.artifact.baseline.content, first.artifact.baseline.content);
  assert.notEqual(second.artifact.materialContextFingerprint, first.artifact.materialContextFingerprint);
  assert.deepEqual(second.artifact.materialIds, []);
});

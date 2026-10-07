import assert from 'node:assert/strict';
import test from 'node:test';
import { runStage, semanticTranslationChunks } from '../src/pipeline.js';

function sessionWith(artifacts) {
  return {
    llmModel: 'test:1b',
    targetLanguage: 'Chinese',
    materials: [],
    artifacts: {
      rawTranscript: { content: 'RAW SOURCE MUST NOT BECOME THE CLEANED TRANSLATION' },
      cleanedTranscript: null,
      notes: null,
      outline: null,
      ...artifacts,
    },
  };
}

class EchoTranslationLLM {
  constructor() { this.calls = []; }
  async generate(args) {
    const { prompt, model } = args;
    this.calls.push(args);
    return {
      content: prompt.split('\nCURRENT BLOCK:\n')[1],
      provider: 'test-llm',
      model,
      metrics: { inputTokens: 5, outputTokens: 3 },
    };
  }
}

test('semantic translation chunks preserve order and remain within the configured provider limit', () => {
  const source = `# Heading\n\n${'First paragraph sentence. '.repeat(8)}\n\n- bullet one\n  - nested bullet\n\n${'longword '.repeat(35)}`;
  const chunks = semanticTranslationChunks(source, 100);
  assert.ok(chunks.length > 3);
  assert.equal(chunks.every((chunk) => chunk.length <= 100), true);
  const flattened = chunks.join('\n\n');
  assert.ok(flattened.indexOf('# Heading') < flattened.indexOf('First paragraph'));
  assert.ok(flattened.indexOf('First paragraph') < flattened.indexOf('- bullet one'));
  assert.ok(flattened.indexOf('- bullet one') < flattened.lastIndexOf('longword'));
});

test('Cleaned translation is generated from ordered Cleaned blocks with preceding context, not Raw live output', async () => {
  const llm = new EchoTranslationLLM();
  const cleaned = '# Topic\n\nFirst coherent paragraph.\n\nSecond coherent paragraph.';
  const result = await runStage({
    stage: 'cleaned-translation',
    session: sessionWith({ cleanedTranscript: { content: cleaned } }),
    llm,
  });
  assert.equal(result.key, 'cleanedTranslation');
  assert.equal(result.artifact.content, cleaned);
  assert.equal(result.artifact.sourceArtifact, 'cleanedTranscript');
  assert.equal(result.artifact.dependsOn.key, 'cleanedTranscript');
  assert.equal(result.artifact.targetLanguage, 'Chinese');
  assert.equal(llm.calls.some((call) => call.prompt.includes('RAW SOURCE MUST NOT')), false);
  assert.match(llm.calls[0].prompt, /CURRENT CLEANED TRANSCRIPT BLOCK/);
  assert.equal(llm.calls[0].requestType, 'cleaned-translation');
  assert.equal(llm.calls[0].numCtx, 4096);
  assert.equal(llm.calls[0].numPredict, 2048);
});

test('Notes and Outline translations use their own artifacts and explicitly preserve Markdown structure', async () => {
  for (const [stage, key, sourceKey, source] of [
    ['notes-translation', 'notesTranslation', 'notes', '# Notes\n\n- Definition\n  - Example'],
    ['outline-translation', 'outlineTranslation', 'outline', '# Theme\n\n## Concept\n- depends on\n  - prerequisite'],
  ]) {
    const llm = new EchoTranslationLLM();
    const result = await runStage({ stage, session: sessionWith({ [sourceKey]: { content: source } }), llm });
    assert.equal(result.key, key);
    assert.equal(result.artifact.content, source);
    assert.equal(result.artifact.dependsOn.key, sourceKey);
    assert.match(llm.calls[0].prompt, /Preserve Markdown headings, bullets, numbering, nesting/);
    assert.match(llm.calls[0].prompt, new RegExp(source.split('\n')[0].replace('#', '\\#')));
  }
});

test('document translation rejects an empty block instead of persisting partial output as complete', async () => {
  const session = sessionWith({ cleanedTranscript: { content: `${'First paragraph sentence. '.repeat(260)}\n\nSecond paragraph.` } });
  let calls = 0;
  const llm = {
    async generate() {
      calls += 1;
      return { content: calls === 1 ? '第一段。' : '', provider: 'test', model: 'test', metrics: {} };
    },
  };
  await assert.rejects(() => runStage({ stage: 'cleaned-translation', session, llm }), (error) => error.code === 'INVALID_MODEL_RESPONSE');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { runStage } from '../src/pipeline.js';
import { repairPrompt } from '../src/conservative-correction.js';
import { retrieveCorrectionEvidence, summarizeCorrectionMaterial } from '../src/conservative-retrieval.js';

const MATERIALS = [
  {
    id: 'probability-notes',
    filename: 'probability.md',
    extractedText: '# Bayes theorem\n\nBayes theorem combines a prior with likelihood and evidence.\n\n# Irrelevant\n\nA compiler translates source code.',
  },
];

test('Version C retrieves terminology-supported, labeled material snippets within bounds', () => {
  const evidence = retrieveCorrectionEvidence(MATERIALS, 'Base theorem combines the prior and evidence.', { maxCharacters: 300, maxSnippets: 2 });
  assert.equal(evidence.materialIds.length, 1);
  assert.match(evidence.text, /\[M1:S\d+\] probability\.md/);
  assert.match(evidence.text, /Bayes theorem combines a prior/);
  assert.doesNotMatch(evidence.text, /compiler translates/);
  assert.ok(evidence.text.length <= 300);
  assert.equal(evidence.diagnostics.method, 'lexical-anchors');
  assert.equal(evidence.diagnostics.vectorized, false);
  assert.equal(evidence.diagnostics.candidateChunks, 4);
  assert.ok(evidence.diagnostics.selectedChunks >= 1);
});

test('Version C material preparation reports lexical chunks and explicitly no vectors', () => {
  const summary = summarizeCorrectionMaterial(MATERIALS[0].extractedText);
  assert.equal(summary.method, 'lexical-anchors');
  assert.equal(summary.vectorized, false);
  assert.equal(summary.vectorStore, null);
  assert.equal(summary.chunkCount, 4);
  assert.deepEqual(summary.chunks.map((chunk) => chunk.chunk), [1, 2, 3, 4]);
  assert.ok(summary.chunks.every((chunk) => chunk.characters > 0));
  assert.ok(summary.anchorTermCount > 0);
});

test('Version C repair prompt exposes material as read-only evidence for exact substitutions', () => {
  const baseline = 'Base theorem combines a prior with evidence.';
  const evidence = retrieveCorrectionEvidence(MATERIALS, baseline);
  assert.deepEqual(evidence.materialIds, ['probability-notes']);
  const prompt = repairPrompt(baseline, evidence, [{ candidateId: 'C1', original: 'Base', replacement: 'Bayes', occurrence: 1, evidenceId: 'M1:S1', evidenceQuote: 'Bayes theorem' }]);
  assert.match(prompt, /READ-ONLY COURSE EVIDENCE/);
  assert.match(prompt, /Bayes theorem/);
  assert.match(prompt, /Return JSON only/);
  assert.match(prompt, /Leave readable wording exactly as it is/);
});

test('Version C accepts a material-supported terminology repair and records provenance', async () => {
  const calls = [];
  const logs = [];
  const baseline = 'Base theorem combines a prior with evidence.';
  const quote = 'Bayes theorem combines a prior with likelihood and evidence.';
  const evidence = retrieveCorrectionEvidence(MATERIALS, baseline);
  const evidenceId = evidence.snippets.find((snippet) => snippet.text === quote).id;
  const llm = {
    async generate(options) {
      calls.push(options);
      const content = options.prompt.startsWith('Transcript:\n') ? baseline : JSON.stringify({ candidateIds: ['C1'] });
      return { content, provider: 'test', model: options.model };
    },
  };
  const session = {
    llmModel: 'local-test:4b',
    materials: MATERIALS,
    artifacts: {
      rawTranscript: { content: baseline },
      highQualityTranscript: { content: 'This optional Large-v3 result must not enter revision.', generationState: 'complete' },
      cleanedTranscript: null,
    },
  };
  const result = await runStage({ stage: 'cleanup', session, llm, onCleanupLog: async (entry) => logs.push(entry) });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].prompt, `Transcript:\n${baseline}`);
  assert.doesNotMatch(calls[0].prompt, /Bayes/);
  assert.match(calls[1].prompt, /Bayes theorem combines a prior/);
  assert.equal(result.artifact.baseline.content, baseline);
  assert.equal(result.artifact.content, baseline.replace('Base', 'Bayes'));
  assert.equal(session.artifacts.rawTranscript.content, baseline);
  assert.equal(result.artifact.metrics.acceptedEdits, 1);
  assert.equal(result.artifact.experimentVariant, 'C');
  assert.deepEqual(result.artifact.materialIds, ['probability-notes']);
  assert.equal(result.artifact.dependsOn.key, 'rawTranscript');
  assert.equal(result.artifact.revisionInput, 'rawTranscript');
  assert.equal(result.artifact.vectorized, false);
  assert.ok(logs.some((entry) => entry.code === 'revision-retrieval-window' && entry.details.selectedChunks >= 1));
  assert.equal(logs.at(-1).code, 'revision-complete');
});

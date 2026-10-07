import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const indexPath = new URL('../web/index.html', import.meta.url);
const appPath = new URL('../web/app.js', import.meta.url);
const editorPath = new URL('../web/editable-document.js', import.meta.url);
const stylesPath = new URL('../web/styles.css', import.meta.url);
const hostedAppPath = new URL('../web-dist/web/app.js', import.meta.url);
const hostedI18nPath = new URL('../web-dist/web/i18n.js', import.meta.url);
const hostedIndexPath = new URL('../web-dist/web/index.html', import.meta.url);

test('main navigation contains only Raw, Cleaned, Notes, and Outline document tabs', async () => {
  const html = await fs.readFile(indexPath, 'utf8');
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ['raw', 'cleaned', 'notes', 'outline']);
  assert.doesNotMatch(html, /data-tab="translation"/);
});

test('one shared bilingual surface and one minimal persisted view toggle serve all supported tabs', async () => {
  const [html, app] = await Promise.all([fs.readFile(indexPath, 'utf8'), fs.readFile(appPath, 'utf8')]);
  assert.equal((html.match(/id="bilingual-view"/g) || []).length, 1);
  assert.equal((html.match(/id="bilingual-toggle"/g) || []).length, 1);
  assert.match(app, /rawTranslation/);
  assert.match(app, /cleanedTranslation/);
  assert.match(app, /notesTranslation/);
  assert.match(app, /outlineTranslation/);
  assert.match(app, /lecture-copilot-document-view/);
});

test('Raw exposes only the compact presentation while retaining semantic display grouping', async () => {
  const [html, app] = await Promise.all([fs.readFile(indexPath, 'utf8'), fs.readFile(appPath, 'utf8')]);
  assert.equal((html.match(/data-raw-mode=/g) || []).length, 0);
  assert.doesNotMatch(html, /Compact\s*<\/button>|Aligned\s*<\/button>/);
  assert.doesNotMatch(app, /lecture-copilot-raw-display-mode|rawDisplayMode/);
  assert.match(app, /rawDisplayBlocks/);
  assert.match(app, /groupRawDisplayBlocks/);
  assert.match(html, /id="generate-button"[^>]*data-action="generate-current"/);
  assert.match(app, /artifactRequests/);
  assert.match(app, /ensureCurrentArtifact/);
});

test('document actions stay in the toolbar without the removed AI explanation banner', async () => {
  const [html, css] = await Promise.all([fs.readFile(indexPath, 'utf8'), fs.readFile(stylesPath, 'utf8')]);
  const toolbar = html.slice(html.indexOf('<div class="toolbar-actions">'), html.indexOf('<div id="document-placeholder"'));
  assert.match(toolbar, /id="revise-button"/);
  assert.match(toolbar, /id="generate-button"/);
  assert.match(toolbar, /id="translate-button"/);
  assert.doesNotMatch(html, /ai-action-bar|ai-action-copy|ai-action-hint|data-i18n="ai\.manual"/);
  assert.doesNotMatch(css, /\.ai-action-(?:bar|copy|buttons)/);
});

test('bilingual layout uses balanced columns, paired Raw rows, and narrow-window stacked fallbacks', async () => {
  const [app, editor, css] = await Promise.all([
    fs.readFile(appPath, 'utf8'),
    fs.readFile(editorPath, 'utf8'),
    fs.readFile(stylesPath, 'utf8'),
  ]);
  assert.match(css, /\.bilingual-columns\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/s);
  assert.match(css, /\.bilingual-columns article \+ article\s*\{[^}]*border-left:\s*1px solid var\(--border\)/s);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.bilingual-columns\s*\{\s*display:\s*block;/);
  assert.match(css, /\.raw-bilingual-row\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/s);
  assert.match(css, /\.raw-bilingual-row > \* \+ \*\s*\{[^}]*border-left:\s*1px solid var\(--border\)/s);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.raw-bilingual-row\s*\{\s*display:\s*block;/);
  assert.match(app, /buildRawAlignmentUnits\(blocks\)/);
  assert.match(app, /setContent\(`\$\{labels\}<div class="raw-alignment-rows" data-editor-host><\/div>/);
  assert.match(app, /rawTranscriptFollow\.capture\(rawTranscriptContainer\(\)\)/);
  assert.match(app, /rawTranscriptFollow\.restore\(rawTranscriptContainer\(bilingual \? bilingualView : editorHost\)/);
  assert.doesNotMatch(app, /wasNearBottom/);
  assert.doesNotMatch(app, /class="raw-compact-columns"/);
  assert.match(editor, /section\.classList\.add\('raw-bilingual-row'\)/);
  assert.match(editor, /section\.append\(source\)[\s\S]*section\.append\(decoration\)/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
});

test('Raw bilingual sticky labels cover the scroll gutter without a transparent gap', async () => {
  const css = await fs.readFile(stylesPath, 'utf8');
  assert.match(css, /\.bilingual-view\s*\{[^}]*padding:\s*0\s+0\s+64px/);
  assert.match(css, /\.bilingual-labels\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*background:\s*var\(--surface\);[^}]*box-shadow:\s*0 1px 0 var\(--border\);/s);
  assert.doesNotMatch(css, /background:\s*color-mix\(in srgb, var\(--surface\) 94%, transparent\)/);
});

test('Raw stale translation does not render an inline out-of-date notice', async () => {
  const app = await fs.readFile(appPath, 'utf8');
  const renderer = app.slice(app.indexOf('function renderBilingualView'));
  const rawBranch = renderer.slice(renderer.indexOf("if (state.tab === 'raw')"), renderer.indexOf('const translatedContent'));
  assert.doesNotMatch(rawBranch, /translation-notice|translation\.outOfDate/);
  assert.match(rawBranch, /translation-retry/);
});

test('Raw keeps the previous translation visible with a localized revision suffix', async () => {
  const [app, css] = await Promise.all([fs.readFile(appPath, 'utf8'), fs.readFile(stylesPath, 'utf8')]);
  assert.match(app, /unit\.displayTranslatedText/);
  assert.match(app, /translation\.beingRevised/);
  assert.match(css, /\.translation-revision-state/);
});

test('Raw renders and continues polling for the replaceable provisional translation tail', async () => {
  const app = await fs.readFile(appPath, 'utf8');
  assert.match(app, /pendingTranslation: translation\?\.pendingTranslation \|\| null/);
  assert.match(app, /rawTranslation\?\.pendingTranslation\?\.status === 'translating'/);
});

test('hosted Raw translation refreshes automatically and never asks the user to click Translate', async () => {
  const [app, i18n] = await Promise.all([
    fs.readFile(hostedAppPath, 'utf8'),
    fs.readFile(hostedI18nPath, 'utf8'),
  ]);
  assert.match(app, /function rawTranslationNeedsRefresh/);
  assert.match(app, /rawTranslationNeedsRefresh\(refreshed\).*ensureCurrentTranslation/s);
  assert.match(app, /pendingTranslation: translation\?\.pendingTranslation \|\| null/);
  assert.match(app, /unit\.displayTranslatedText/);
  assert.match(app, /await setLiveTranslation\(true\)/);
  assert.doesNotMatch(i18n, /Click Translate when ready\./);
});

test('Cleaned processing does not disable the dictation resume control', async () => {
  const app = await fs.readFile(appPath, 'utf8');
  assert.match(app, /const isCleanupProcessing = activeStage === 'cleanup'/);
  assert.match(app, /const dictationBlocked = state\.busy[\s\S]*!isCleanupProcessing/);
  assert.match(app, /renderDictationControl\(dictationBlocked\)/);
  assert.match(app, /const isProcessing = dictationBlocked/);
  assert.match(app, /#record-button'\)\.disabled = \(isProcessing && !recording\) \|\| transitioning/);
});

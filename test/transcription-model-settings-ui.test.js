import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const [html, app, i18n] = await Promise.all([
  fs.readFile(new URL('../web/index.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../web/app.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../web/i18n.js', import.meta.url), 'utf8'),
]);

test('Settings exposes the two Version C transcription stages and keeps high-quality compatibility hidden', () => {
  assert.match(html, /id="asr-model-provisional"/);
  assert.match(html, /id="asr-model-revised"/);
  assert.match(html, /id="asr-model-high-quality"/);
  assert.match(html, /Live draft model/);
  assert.match(html, /Raw transcript refinement model/);
  assert.match(html, /Optional comparison model/);
  assert.match(html, /class="hidden" aria-hidden="true"[^>]*><span data-i18n="settings\.highQualityModel"/);
  assert.match(html, /live draft → automatic material RAG/);
  assert.match(html, /Raw Whisper refinement runs only after Improve transcript/);
  assert.match(i18n, /settings\.highQualityModelHint/);
});

test('Settings saves stage selections and disables models that are not ready', () => {
  assert.match(app, /asrModels:\s*selectedAsrModels\(\)/);
  assert.match(app, /renderAsrModelSelectors\(\{ preserveSelection: false \}\)/);
  assert.match(app, /const previous = preserveSelection \? select\.value : ''/);
  assert.match(app, /\.\.\.\(storageChanged \? \{ storagePath: requestedPath \} : \{\}\)/);
  assert.match(app, /details\.state === 'ready' \? '' : 'disabled'/);
  assert.match(app, /model\.state === 'ready' \? '' : 'disabled'/);
  assert.match(app, /state\.settings\.asrModels \|\| state\.health\.asrPipeline/);
  assert.match(app, /settings\.stageBadge\.\$\{stage\}/);
});

test('Settings keeps the app language selector at the bottom of the dialog content', () => {
  const storageIndex = html.indexOf('settings.storageLocation');
  const modelSectionIndex = html.indexOf('id="asr-model-provisional"');
  const whisperListIndex = html.indexOf('id="whisper-model-list"');
  const appLanguageIndex = html.indexOf('id="app-language"');
  const saveButtonIndex = html.indexOf('id="save-settings"');

  assert.ok(storageIndex >= 0);
  assert.ok(modelSectionIndex >= 0);
  assert.ok(whisperListIndex >= 0);
  assert.ok(appLanguageIndex >= 0);
  assert.ok(saveButtonIndex >= 0);

  assert.ok(storageIndex < modelSectionIndex);
  assert.ok(modelSectionIndex < whisperListIndex);
  assert.ok(whisperListIndex < appLanguageIndex);
  assert.ok(appLanguageIndex < saveButtonIndex);
});

test('model installation is independent from selection', () => {
  assert.doesNotMatch(app, /pendingSttModel|selectAfterInstall/);
  assert.match(i18n, /installing does not change your selections/i);
});

test('new extraction and RAG events are mirrored to sequential demo toasts', () => {
  assert.match(app, /const activityToastQueue = \[\]/);
  assert.match(app, /enqueueActivityToasts\(sessionId, \(refreshed\.activityLog \|\| \[\]\)\.filter/);
  assert.match(app, /showNextActivityToast\(\)/);
  assert.match(app, /entry\.code === 'material-chunk-prepared' \? 1400 : 2100/);
  assert.match(i18n, /'activity\.toastMaterial': 'Material extraction'/);
  assert.match(i18n, /'activity\.toastRevision': '版本 C · RAG 修订'/);
});

test('saved materials expose in-place re-extraction for rebuilding RAG context', () => {
  assert.match(html, /id="i-refresh"/);
  assert.match(app, /data-reextract-material/);
  assert.match(app, /materials\/\$\{encodeURIComponent\(materialId\)\}\/extract/);
  assert.match(i18n, /'context\.reextractMaterial': 'Extract again'/);
  assert.match(i18n, /'activity\.material-reextraction-started': '正在重新提取已保存的源文件'/);
});

test('attached materials stay visible in the main session workspace and can be removed there', () => {
  const workspace = html.slice(html.indexOf('id="workspace"'), html.indexOf('class="dictation-dock"'));
  assert.match(workspace, /id="session-materials"[^>]*aria-labelledby="session-materials-heading"/);
  assert.match(workspace, /id="session-material-list"/);
  assert.match(app, /\$\('#session-materials'\)\.classList\.toggle\('hidden',\s*materials\.length === 0\)/);
  assert.match(app, /\$\('#session-material-list'\)\.innerHTML\s*=\s*materials\.map[\s\S]*data-delete-material=/);
  assert.match(i18n, /'context\.attachedToSession': 'Attached to this session'/);
});

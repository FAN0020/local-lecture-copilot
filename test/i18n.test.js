import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { applyTranslations, getLocale, normalizeLocale, setLocale, t, TRANSLATIONS } from '../web/i18n.js';

function staticallyReferencedKeys() {
  const keys = new Set();
  for (const relativePath of ['../web/app.js', '../web/session-deletion.js', '../web/index.html']) {
    const source = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    for (const match of source.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)) keys.add(match[1]);
    for (const match of source.matchAll(/data-i18n="([^"]+)"/g)) keys.add(match[1]);
    for (const match of source.matchAll(/data-i18n-attrs="([^"]+)"/g)) {
      for (const binding of match[1].split(';')) {
        const key = binding.split(':').slice(1).join(':').trim();
        if (key) keys.add(key);
      }
    }
  }
  return [...keys].sort();
}

function fakeDocument() {
  const textElement = { dataset: { i18n: 'nav.settings' }, textContent: '' };
  const attributeElement = {
    dataset: { i18nAttrs: 'aria-label:nav.openNavigation' },
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
  };
  const documentElement = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  return {
    textElement,
    attributeElement,
    documentElement,
    querySelectorAll(selector) {
      if (selector === '[data-i18n]') return [textElement];
      if (selector === '[data-i18n-html]') return [];
      if (selector === '[data-i18n-attrs]') return [attributeElement];
      return [];
    },
  };
}

test('switching locale immediately updates translated text and accessibility labels', () => {
  const root = fakeDocument();
  setLocale('en');
  applyTranslations(root);
  assert.equal(root.textElement.textContent, 'Settings');
  assert.equal(root.attributeElement.attributes['aria-label'], 'Open navigation');
  assert.equal(root.documentElement.attributes.lang, 'en');

  setLocale('zh-CN');
  applyTranslations(root);
  assert.equal(root.textElement.textContent, '设置');
  assert.equal(root.attributeElement.attributes['aria-label'], '打开导航');
  assert.equal(root.documentElement.attributes.lang, 'zh-CN');
  assert.equal(getLocale(), 'zh-CN');
});

test('missing locale entries fall back to English and unknown keys remain diagnosable', () => {
  setLocale('zh-CN');
  assert.equal(t('app.name'), 'Lecture Copilot');
  assert.equal(t('test.missing.key'), 'test.missing.key');
});

test('unsupported locale values normalize to the default Chinese locale', () => {
  assert.equal(normalizeLocale('zh-Hans'), 'zh-CN');
  assert.equal(normalizeLocale('fr-FR'), 'zh-CN');
  setLocale('en');
});

test('translation revision suffix is localized in both interface languages', () => {
  setLocale('en');
  assert.equal(t('translation.beingRevised'), '[being revised…]');
  setLocale('zh-CN');
  assert.equal(t('translation.beingRevised'), '[修订中…]');
});

test('normal UI translation keys have English and Simplified Chinese resources', () => {
  const keys = staticallyReferencedKeys();
  assert.deepEqual(keys.filter((key) => !(key in TRANSLATIONS.en)), []);
  // The product name is intentionally kept in English as a proper name and
  // also exercises the documented locale-to-English fallback path.
  assert.deepEqual(keys.filter((key) => !(key in TRANSLATIONS['zh-CN'])), ['app.name']);
});

test('recording backlog copy distinguishes transcription and refinement queues in both locales', () => {
  setLocale('en');
  assert.equal(t('recording.transcriptionQueued', { count: 2 }), 'Awaiting transcription 2');
  assert.equal(t('recording.refinementQueued', { count: 38 }), 'Awaiting refinement 38');
  setLocale('zh-CN');
  assert.equal(t('recording.transcriptionQueued', { count: 2 }), '待转写 2');
  assert.equal(t('recording.refinementQueued', { count: 38 }), '待优化 38');
});

test('recording status renders the derived transcription and refinement lifecycle counters', () => {
  const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const renderer = app.slice(app.indexOf('function renderDictationControl'), app.indexOf('function renderMaterials'));
  assert.match(renderer, /asrBacklog\.transcription\?\.queued/);
  assert.match(renderer, /asrBacklog\.transcription\?\.active/);
  assert.match(renderer, /asrBacklog\.refinement\?\.queued/);
  assert.match(renderer, /asrBacklog\.refinement\?\.active/);
  assert.doesNotMatch(renderer, /recording\.revising/);
});

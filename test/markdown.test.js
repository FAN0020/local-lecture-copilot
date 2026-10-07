import assert from 'node:assert/strict';
import test from 'node:test';
import { markdown } from '../web/markdown.js';

test('Markdown rendering preserves nested unordered and ordered list hierarchy', () => {
  const rendered = markdown(`# Topic

- Parent
  - Child
    1. First relationship
    2. Second relationship
- Sibling`);

  assert.match(rendered, /<h1>Topic<\/h1>/);
  assert.match(rendered, /<ul><li>Parent<ul><li>Child<ol><li>First relationship<\/li><li>Second relationship<\/li><\/ol><\/li><\/ul><\/li><li>Sibling<\/li><\/ul>/);
});

test('Markdown rendering escapes user content while retaining supported inline structure', () => {
  const rendered = markdown('- **Term** <script>alert(1)</script> [M1]');
  assert.doesNotMatch(rendered, /<script>/);
  assert.match(rendered, /<strong>Term<\/strong> &lt;script&gt;alert\(1\)&lt;\/script&gt; <mark>\[M1\]<\/mark>/);
});

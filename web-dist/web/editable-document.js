import { markdown } from './markdown.js';

const BLOCK_TAGS = new Set(['BLOCKQUOTE', 'DIV', 'H1', 'H2', 'H3', 'LI', 'OL', 'P', 'PRE', 'SECTION', 'UL']);

function normalizeText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
}

function appendWithSeparator(current, next, separator) {
  if (!next) return current;
  if (!current) return next;
  return `${current}${separator}${next}`;
}

function cloneText(element) {
  const textFromNode = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return normalizeText(node.nodeValue);
    if (node.nodeType !== Node.ELEMENT_NODE || node.getAttribute('contenteditable') === 'false') return '';
    if (node.tagName === 'BR') return '\n';
    let value = '';
    for (const child of node.childNodes) {
      const block = child.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(child.tagName);
      if (block && value && !value.endsWith('\n')) value += '\n';
      value += textFromNode(child);
      if (block && value && !value.endsWith('\n')) value += '\n';
    }
    return value;
  };
  return textFromNode(element).replace(/\n+$/g, '');
}

function inlineMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return normalizeText(node.nodeValue);
  if (node.nodeType !== Node.ELEMENT_NODE || node.getAttribute('contenteditable') === 'false') return '';
  const content = [...node.childNodes].map(inlineMarkdown).join('');
  if (node.tagName === 'BR') return '\n';
  if (node.tagName === 'STRONG' || node.tagName === 'B') return `**${content}**`;
  if (node.tagName === 'EM' || node.tagName === 'I') return `*${content}*`;
  if (node.tagName === 'CODE') return `\`${content}\``;
  return content;
}

function listMarkdown(list, depth = 0) {
  const ordered = list.tagName === 'OL';
  const lines = [];
  const items = [...list.children].filter((child) => child.tagName === 'LI');
  items.forEach((item, index) => {
    const nested = [...item.children].filter((child) => child.tagName === 'UL' || child.tagName === 'OL');
    const content = [...item.childNodes]
      .filter((child) => !(child.nodeType === Node.ELEMENT_NODE && (child.tagName === 'UL' || child.tagName === 'OL')))
      .map(inlineMarkdown)
      .join('')
      .trim();
    const marker = ordered ? `${index + 1}.` : '-';
    lines.push(`${'  '.repeat(depth)}${marker} ${content}`.trimEnd());
    nested.forEach((child) => lines.push(listMarkdown(child, depth + 1)));
  });
  return lines.filter(Boolean).join('\n');
}

function blockMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return normalizeText(node.nodeValue).trimEnd();
  if (node.nodeType !== Node.ELEMENT_NODE || node.getAttribute('contenteditable') === 'false') return '';
  if (node.tagName === 'UL' || node.tagName === 'OL') return listMarkdown(node);
  if (/^H[1-3]$/.test(node.tagName)) return `${'#'.repeat(Number(node.tagName[1]))} ${inlineMarkdown(node).trim()}`;
  if (node.tagName === 'BLOCKQUOTE') return inlineMarkdown(node).split('\n').map((line) => `> ${line}`).join('\n');
  if (node.tagName === 'PRE') return `\`\`\`\n${normalizeText(node.textContent).trimEnd()}\n\`\`\``;
  if (BLOCK_TAGS.has(node.tagName)) return inlineMarkdown(node).trimEnd();
  return inlineMarkdown(node).trimEnd();
}

export function markdownFromElement(element) {
  return [...element.childNodes]
    .map((node) => ({ node, value: blockMarkdown(node) }))
    .filter(({ value }) => value !== '')
    .reduce((content, item, index, items) => {
      if (!index) return item.value;
      const previous = items[index - 1].node;
      const sameList = previous.nodeType === Node.ELEMENT_NODE && item.node.nodeType === Node.ELEMENT_NODE
        && ['UL', 'OL'].includes(previous.tagName) && ['UL', 'OL'].includes(item.node.tagName);
      return `${content}${sameList ? '\n' : '\n\n'}${item.value}`;
    }, '')
    .replace(/\n{3,}/g, '\n\n');
}

export function plainTextFromElement(element) {
  let content = '';
  for (const node of element.childNodes) {
    if (node.nodeType === Node.ELEMENT_NODE && node.getAttribute('contenteditable') === 'false') continue;
    let value = '';
    let separator = content ? '\n\n' : '';
    if (node.nodeType === Node.ELEMENT_NODE && node.matches('[data-editor-block]')) {
      value = cloneText(node.querySelector('[data-editor-text]') || node);
      separator = node.dataset.joinBefore ?? separator;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      value = cloneText(node);
    } else {
      value = normalizeText(node.nodeValue).replace(/\n+$/g, '');
    }
    content = appendWithSeparator(content, value, separator);
  }
  return content;
}

/** Preserve local edits while accepting the append-only updates produced by live dictation. */
export function mergeExternalDocument(baseValue, localValue, remoteValue) {
  const base = normalizeText(baseValue);
  const local = normalizeText(localValue);
  const remote = normalizeText(remoteValue);
  if (remote === base || remote === local) return local;
  if (local === base) return remote;
  if (remote.startsWith(base)) {
    const appended = remote.slice(base.length);
    return appended && !local.endsWith(appended) ? `${local}${appended}` : local;
  }
  return local;
}

function textNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.parentElement?.closest('[contenteditable="false"]')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

function selectionOffsets(root) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
  const offsetFor = (target, targetOffset) => {
    let offset = 0;
    for (const node of textNodes(root)) {
      if (node === target) return offset + targetOffset;
      offset += node.nodeValue.length;
    }
    return offset;
  };
  return {
    anchor: offsetFor(selection.anchorNode, selection.anchorOffset),
    focus: offsetFor(selection.focusNode, selection.focusOffset),
  };
}

function restoreSelection(root, offsets) {
  if (!offsets) return;
  const nodes = textNodes(root);
  const point = (requested) => {
    let remaining = requested;
    for (const node of nodes) {
      if (remaining <= node.nodeValue.length) return [node, Math.max(0, remaining)];
      remaining -= node.nodeValue.length;
    }
    const last = nodes.at(-1);
    return last ? [last, last.nodeValue.length] : [root, 0];
  };
  const [anchorNode, anchorOffset] = point(offsets.anchor);
  const [focusNode, focusOffset] = point(offsets.focus);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
}

function appendLineBreaks(element, text) {
  const lines = normalizeText(text).split('\n');
  lines.forEach((line, index) => {
    if (index) element.append(document.createElement('br'));
    element.append(document.createTextNode(line));
  });
}

export class EditableDocument {
  constructor(element, { onChange } = {}) {
    this.element = element;
    this.onChange = onChange;
    this.identity = '';
    this.baseValue = '';
    this.format = 'plain';
    this.renderOptions = {};
    this.renderKey = '';
    this.dirty = false;
    this.composing = false;
    this.pendingSelection = null;
    this.pendingFocus = false;
    element.addEventListener('compositionstart', () => { this.composing = true; });
    element.addEventListener('compositionend', () => { this.composing = false; this.handleInput(); });
    element.addEventListener('input', () => { if (!this.composing) this.handleInput(); });
    element.addEventListener('paste', (event) => {
      const text = event.clipboardData?.getData('text/plain');
      if (text === undefined) return;
      event.preventDefault();
      document.execCommand('insertText', false, text);
    });
  }

  captureSelection() {
    this.pendingSelection = selectionOffsets(this.element);
    this.pendingFocus = document.activeElement === this.element || this.element.contains(document.activeElement);
  }

  value() {
    return this.format === 'markdown' ? markdownFromElement(this.element) : plainTextFromElement(this.element);
  }

  handleInput() {
    const value = this.value();
    this.dirty = value !== this.baseValue;
    this.onChange?.(value, { baseValue: this.baseValue, identity: this.identity, dirty: this.dirty });
  }

  renderPlain(value, { blocks = [], decorateBlock, pairedBlocks = false, sourceLabel = '' } = {}) {
    this.element.replaceChildren();
    const source = blocks.length ? blocks : normalizeText(value).split(/\n{2,}/).map((text, index) => ({
      text,
      joinBefore: index ? '\n\n' : '',
    }));
    source.forEach((block, index) => {
      const section = document.createElement('section');
      section.className = 'editable-paragraph';
      section.dataset.editorBlock = block.id || String(index);
      section.dataset.joinBefore = block.joinBefore ?? (index ? '\n\n' : '');
      if (pairedBlocks) {
        section.classList.add('raw-bilingual-row');
        section.dataset.alignmentId = block.id || String(index);
      }
      const paragraph = document.createElement('p');
      paragraph.dataset.editorText = '';
      appendLineBreaks(paragraph, block.text);
      if (pairedBlocks) {
        const source = document.createElement('div');
        source.className = 'raw-source-cell';
        source.dataset.label = sourceLabel;
        source.append(paragraph);
        section.append(source);
      } else section.append(paragraph);
      const decoration = decorateBlock?.(block, index);
      if (decoration) {
        decoration.setAttribute('contenteditable', 'false');
        section.append(decoration);
      }
      this.element.append(section);
    });
  }

  renderValue(value, options = this.renderOptions) {
    this.renderOptions = options;
    if (this.format === 'markdown') this.element.innerHTML = markdown(value);
    else this.renderPlain(value, options);
  }

  mount(host, { identity, value, format = 'plain', readOnly = false, renderKey = '', ...options }) {
    const selection = this.pendingSelection || selectionOffsets(this.element);
    const focused = this.pendingFocus || this.element.contains(document.activeElement) || document.activeElement === this.element;
    this.pendingSelection = null;
    this.pendingFocus = false;
    if (this.element.parentElement !== host) host.append(this.element);
    this.element.classList.toggle('paired-block-document', Boolean(options.pairedBlocks));
    this.element.classList.toggle('read-only', readOnly);
    this.element.contentEditable = readOnly ? 'false' : 'true';
    this.element.setAttribute('aria-readonly', String(readOnly));

    const remote = normalizeText(value);
    const identityChanged = identity !== this.identity || format !== this.format;
    const presentationChanged = renderKey !== this.renderKey;
    this.format = format;
    if (identityChanged) {
      this.identity = identity;
      this.baseValue = remote;
      this.dirty = false;
      this.renderValue(remote, options);
    } else {
      const local = this.value();
      const merged = mergeExternalDocument(this.baseValue, local, remote);
      if (merged !== local || presentationChanged) this.renderValue(merged, options);
      else this.renderOptions = options;
      this.baseValue = remote;
      this.dirty = merged !== remote;
    }
    this.renderKey = renderKey;
    if (focused) {
      this.element.focus({ preventScroll: true });
      restoreSelection(this.element, selection);
    }
    return this;
  }

  acceptSaved(value) {
    const saved = normalizeText(value);
    const local = this.value();
    const merged = mergeExternalDocument(this.baseValue, local, saved);
    if (merged !== local) {
      const selection = selectionOffsets(this.element);
      this.renderValue(merged);
      restoreSelection(this.element, selection);
    }
    this.baseValue = saved;
    this.dirty = merged !== saved;
    return merged;
  }
}

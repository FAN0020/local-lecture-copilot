export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character]);
}

function inlineMarkdown(line) {
  return escapeHtml(line)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[(M\d+|Transcript)\]/g, '<mark>[$1]</mark>');
}

function indentation(value) {
  return value.replace(/\t/g, '  ').length;
}

/**
 * Render the small Markdown subset produced by the local pipelines. List
 * containers remain open across indented children so Notes and Outline keep
 * their hierarchy instead of being flattened into one visual level.
 */
export function markdown(content, emptyText = 'No content yet.') {
  const lines = String(content || '').split('\n');
  const lists = [];
  let html = '';

  const closeTopList = () => {
    const top = lists.pop();
    if (!top) return;
    if (top.itemOpen) html += '</li>';
    html += `</${top.type}>`;
  };
  const closeLists = () => {
    while (lists.length) closeTopList();
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      closeLists();
      continue;
    }

    const listItem = line.match(/^(\s*)([-*]|\d+[.)])\s+(.+)/);
    if (listItem) {
      const indent = indentation(listItem[1]);
      const type = /^\d/.test(listItem[2]) ? 'ol' : 'ul';

      while (lists.length && indent < lists.at(-1).indent) closeTopList();

      let top = lists.at(-1);
      if (top && indent === top.indent && type !== top.type) {
        closeTopList();
        top = lists.at(-1);
      }

      top = lists.at(-1);
      if (top && indent === top.indent && type === top.type) {
        if (top.itemOpen) html += '</li>';
        html += `<li>${inlineMarkdown(listItem[3])}`;
        top.itemOpen = true;
        continue;
      }

      html += `<${type}><li>${inlineMarkdown(listItem[3])}`;
      lists.push({ type, indent, itemOpen: true });
      continue;
    }

    closeLists();
    const heading = line.match(/^(#{1,3})\s+(.+)/);
    if (heading) {
      const level = heading[1].length;
      html += `<h${level}>${inlineMarkdown(heading[2])}</h${level}>`;
      continue;
    }
    if (line.startsWith('> ')) {
      html += `<blockquote>${inlineMarkdown(line.slice(2))}</blockquote>`;
      continue;
    }
    html += `<p>${inlineMarkdown(line)}</p>`;
  }

  closeLists();
  return html || `<p>${escapeHtml(emptyText)}</p>`;
}

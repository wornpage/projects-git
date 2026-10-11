export const DIFF_PAGE_LINES = 200;

function quotedPath(path) {
  return '"' + [...new TextEncoder().encode(path)].map(byte => byte === 34 ? '\\"' : byte === 92 ? '\\\\'
    : byte < 32 || byte >= 127 ? '\\' + byte.toString(8).padStart(3, '0') : String.fromCharCode(byte)).join('') + '"';
}

// Map only declared changed paths. Preserve unrecognized sections explicitly;
// never invent a filename for an old or malformed retained patch.
export function recordedDiff(diff, changedFiles) {
  const headers = new Map(), markers = new Map();
  for (const path of changedFiles) {
    headers.set(`diff --git a/${path} b/${path}`, path);
    headers.set(`diff --git ${quotedPath('a/' + path)} ${quotedPath('b/' + path)}`, path);
    for (const [marker, side] of [['---', 'a/'], ['+++', 'b/']]) {
      markers.set(marker + ' ' + side + path, path);
      markers.set(marker + ' ' + quotedPath(side + path), path);
    }
  }
  const lines = diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const sections = [];
  let section = null, inHunk = false;
  for (const text of lines) {
    if (!section || text.startsWith('diff --git ')) {
      section = {path: headers.get(text) ?? null, rows: [], added: 0, removed: 0};
      sections.push(section); inHunk = false;
    }
    let kind = 'meta';
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(text)) { inHunk = true; kind = 'hunk'; }
    else if (inHunk) {
      if (text.startsWith('+')) { kind = 'addition'; section.added++; }
      else if (text.startsWith('-')) { kind = 'deletion'; section.removed++; }
      else kind = 'context';
    } else if (text.startsWith('--- ') || text.startsWith('+++ ')) {
      const path = markers.get(text.split('\t')[0]);
      if (path) section.path = path;
    }
    section.rows.push({text, kind});
  }
  return {sections, unmapped: sections.filter(section => !section.path).length,
    missingPaths: changedFiles.filter(path => !sections.some(section => section.path === path)),
    added: sections.reduce((sum, section) => sum + section.added, 0),
    removed: sections.reduce((sum, section) => sum + section.removed, 0)};
}

export function diffWindow(section, offset = 0) {
  const start = Math.max(0, Math.min(Math.trunc(offset), Math.max(0, section.rows.length - 1)));
  return {start, end: Math.min(start + DIFF_PAGE_LINES, section.rows.length), total: section.rows.length,
    rows: section.rows.slice(start, start + DIFF_PAGE_LINES)};
}

export type MarkdownTextSelection = {
  start: number;
  end: number;
};

type PrefixEdit = {
  start: number;
  end: number;
  replacement: string;
};

function mapPositionThroughEdits(position: number, edits: PrefixEdit[]) {
  let delta = 0;

  for (const edit of edits) {
    if (position < edit.start) break;
    if (position <= edit.end) return edit.start + delta + edit.replacement.length;
    delta += edit.replacement.length - (edit.end - edit.start);
  }

  return position + delta;
}

/**
 * Toggles an ATX heading on every line touched by the current selection.
 * Existing headings of another level are replaced instead of nested.
 */
export function toggleMarkdownHeading(
  body: string,
  selection: MarkdownTextSelection,
  level: 1 | 2,
) {
  const start = Math.max(0, Math.min(selection.start, body.length));
  const end = Math.max(start, Math.min(selection.end, body.length));
  const lineStart = body.lastIndexOf("\n", start - 1) + 1;
  const effectiveEnd = end > start && body[end - 1] === "\n" ? end - 1 : end;
  const nextLineBreak = body.indexOf("\n", effectiveEnd);
  const lineEnd = nextLineBreak === -1 ? body.length : nextLineBreak;
  const desiredMarker = "#".repeat(level);
  const lines = body.slice(lineStart, lineEnd).split("\n");
  let absoluteLineStart = lineStart;

  const linePrefixes = lines.map((line) => {
    const indentation = line.match(/^[ \t]*/)?.[0] ?? "";
    const heading = line.slice(indentation.length).match(/^(#{1,6})[ \t]+/);
    const prefixStart = absoluteLineStart + indentation.length;
    const prefixEnd = prefixStart + (heading?.[0].length ?? 0);
    absoluteLineStart += line.length + 1;
    return { marker: heading?.[1] ?? "", prefixStart, prefixEnd };
  });

  const removeHeading = linePrefixes.every(({ marker }) => marker === desiredMarker);
  const replacement = removeHeading ? "" : `${desiredMarker} `;
  const edits = linePrefixes.map(({ prefixStart, prefixEnd }) => ({
    start: prefixStart,
    end: prefixEnd,
    replacement,
  }));

  let nextBody = body;
  for (const edit of [...edits].reverse()) {
    nextBody = `${nextBody.slice(0, edit.start)}${edit.replacement}${nextBody.slice(edit.end)}`;
  }

  return {
    body: nextBody,
    selection: {
      start: mapPositionThroughEdits(start, edits),
      end: mapPositionThroughEdits(end, edits),
    },
  };
}

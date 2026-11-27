/** Source text as lines of coloured pieces. Pure logic: the browser side turns a highlighted
 * document into tokens, and this decides where the line breaks fall, so a wrap toggle, a line
 * count and the gutter never depend on how the colourer split its spans. */

/** A run of source text and the highlight.js scope colouring it, if any. */
export interface CodeToken {
  readonly text: string;
  readonly scope?: string;
}

/** Splits tokens at line breaks into one list per line, each piece keeping its scope: a span the
 * colourer opened before a break and closed after it continues on the next line under the same
 * colour. A file ending in a line break has no empty line after it. */
export function codeLines(tokens: readonly CodeToken[]): CodeToken[][] {
  const lines: CodeToken[][] = [[]];
  for (const { text, scope } of tokens) {
    const parts = text.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines.at(-1)!.push(scope === undefined ? { text: part } : { text: part, scope });
    });
  }
  if (lines.length > 1 && lines.at(-1)!.length === 0) lines.pop();
  return lines;
}

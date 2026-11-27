/** Source text as tokens the panel draws line by line: coloured where a language is registered
 * for the file's suffix, plain otherwise. Browser only — the colourer's document is read through
 * a template element — so nothing here is unit-tested; where the line breaks fall is (lines.ts).
 * The tokens are drawn as React text, never as the colourer's markup, so what reaches the page is
 * the file's own characters and the colourer's class names and nothing else. */
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';
import bash from 'highlight.js/lib/languages/bash';
import python from 'highlight.js/lib/languages/python';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import type { CodeToken } from './lines.js';
import { PLAIN_TEXT } from './kinds.js';

// One grammar per language of kinds.ts; a suffix that names none is shown as plain text.
for (const [name, language] of [
  ['javascript', javascript], ['typescript', typescript], ['json', json], ['css', css], ['xml', xml],
  ['markdown', markdown], ['bash', bash], ['python', python], ['go', go], ['rust', rust], ['java', java],
  ['cpp', cpp], ['csharp', csharp], ['sql', sql], ['yaml', yaml],
] as const) hljs.registerLanguage(name, language);

/** The colourer's document, as the text it shows and the scope colouring each run of it. */
function flatten(node: Node, scope: string | undefined, out: CodeToken[]): CodeToken[] {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? '';
    if (text) out.push(scope === undefined ? { text } : { text, scope });
    return out;
  }
  for (const child of node.childNodes) {
    // A nested span is coloured by its own scope; anything else passes the enclosing one down.
    flatten(child, child.nodeType === Node.ELEMENT_NODE && (child as HTMLElement).className ? (child as HTMLElement).className : scope, out);
  }
  return out;
}

/** Source text as tokens, coloured as `language` when one is registered for it. */
export function sourceTokens(text: string, language: string): CodeToken[] {
  if (language === PLAIN_TEXT) return [{ text }];
  const template = document.createElement('template');
  template.innerHTML = hljs.highlight(text, { language, ignoreIllegals: true }).value;
  return flatten(template.content, undefined, []);
}

/** How the preview panel can show a Workspace file, decided by its suffix. Pure logic — no DOM,
 * no React — so the choice is unit-tested in Node like the browser panel's address rules. */
import { isPreviewable, matchSuffix } from '@aork/contracts/preview';

export type PreviewWay = 'markdown' | 'code' | 'image' | 'pdf' | 'html';

/** One way of showing a file: the way itself, what the "open with" control calls it, and — for
 * the ways that show bytes rather than text — the type those bytes are handed to the browser as. */
export interface PreviewForm {
  readonly way: PreviewWay;
  readonly label: string;
  /** Shown from the file's bytes, in an image or a frame; never read as text. */
  readonly binary: boolean;
  readonly mime?: string;
}

const MARKDOWN: readonly string[] = ['md', 'markdown', 'mdown'];
const DOCUMENT: readonly string[] = ['html', 'htm', 'xhtml'];
/** Image suffixes with the type each is shown under: the server sends every file as a download,
 * so the panel names the type itself. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
};

/** The highlight.js languages the panel registers, each with the suffixes coloured as it. A file
 * of any other suffix is shown as plain text. */
const LANGUAGES: ReadonlyArray<readonly [language: string, suffixes: readonly string[]]> = [
  ['javascript', ['js', 'mjs', 'cjs', 'jsx']],
  ['typescript', ['ts', 'tsx']],
  ['json', ['json', 'jsonc', 'webmanifest']],
  ['css', ['css', 'scss', 'less']],
  ['xml', ['xml', 'xsl', 'plist', 'wsdl', 'svg']],
  ['markdown', ['md', 'markdown', 'mdown']],
  ['bash', ['sh', 'bash', 'zsh', 'ksh']],
  ['python', ['py', 'pyi']],
  ['go', ['go']],
  ['rust', ['rs']],
  ['java', ['java']],
  ['cpp', ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh']],
  ['csharp', ['cs']],
  ['sql', ['sql']],
  ['yaml', ['yml', 'yaml']],
];
/** What the source of a file is coloured as when its suffix names no language. */
export const PLAIN_TEXT = 'plaintext';

/** The text of a file, as text: called 源码 where a language colours it and 文本 otherwise. */
const textForm = (path: string): PreviewForm => ({ way: 'code', label: previewLanguage(path) === PLAIN_TEXT ? '文本' : '源码', binary: false });

/** Every way a file can be shown, the first being the default. A file whose suffix is known to
 * hold nothing the panel can render has none and is never read. */
export function previewForms(path: string): readonly PreviewForm[] {
  if (!isPreviewable(path)) return [];
  const suffix = matchSuffix(path, [...MARKDOWN, ...DOCUMENT, 'pdf', ...Object.keys(IMAGE_TYPES)]) ?? '';
  if (MARKDOWN.includes(suffix)) return [{ way: 'markdown', label: 'Markdown', binary: false }, textForm(path)];
  if (suffix === 'pdf') return [{ way: 'pdf', label: 'PDF', binary: true, mime: 'application/pdf' }];
  // SVG is an image to look at and a document to read, so it is offered both ways.
  if (suffix in IMAGE_TYPES) {
    const image: PreviewForm = { way: 'image', label: '图片', binary: true, mime: IMAGE_TYPES[suffix]! };
    return suffix === 'svg' ? [image, textForm(path)] : [image];
  }
  if (DOCUMENT.includes(suffix)) return [{ way: 'html', label: '网页', binary: false }, textForm(path)];
  return [textForm(path)];
}

/** The highlight.js language a file's source is coloured as: `PLAIN_TEXT` where none is registered. */
export function previewLanguage(path: string): string {
  for (const [language, suffixes] of LANGUAGES) if (matchSuffix(path, suffixes)) return language;
  // HTML is XML to the colourer; SVG already is.
  return matchSuffix(path, DOCUMENT) ? 'xml' : PLAIN_TEXT;
}

/** The last segment of a Workspace path: what the chip and the toolbar name the file by. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Where a relative link inside a Workspace document points, as a Workspace path: relative to the
 * linking file, or to the Workspace root from a leading slash. A link that leaves the Workspace,
 * that names the root itself or that is not a readable path has no target. Addresses with a
 * scheme and fragment links are not passed here: they keep the browser's own behaviour. */
export function resolveWorkspaceLink(from: string, href: string): string | undefined {
  let target: string;
  try { target = decodeURIComponent(href.split(/[?#]/, 1)[0]!); }
  catch { return undefined; }
  if (target.includes('\\') || target.includes('\0')) return undefined;
  const parts = target.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    // Above the root is outside the Workspace, which a link in a document may not reach.
    if (part === '..') { if (!parts.length) return undefined; parts.pop(); continue; }
    parts.push(part);
  }
  return parts.length ? parts.join('/') : undefined;
}

/** Reading a Workspace file's bytes as the text a preview shows. Pure logic, shared by every
 * text way of showing a file, so each decides the same thing about the same bytes. */
import { FILE_LIMITS } from '@aork/contracts/preview';

export type PreviewText =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: 'too-large' | 'not-text' };

export const PREVIEW_TEXT_LIMIT = FILE_LIMITS.textBytes;

/** Decodes file bytes as UTF-8 text, or says why none can be shown. The same two rules the
 * Workspace file service reads text by: a text preview is at most `FILE_LIMITS.textBytes`, and it
 * is UTF-8 without NUL — anything else is a binary file that only a download can hand over. */
export function decodePreviewText(bytes: Uint8Array): PreviewText {
  if (bytes.byteLength > FILE_LIMITS.textBytes) return { ok: false, reason: 'too-large' };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return { ok: false, reason: 'not-text' }; }
  return text.includes('\0') ? { ok: false, reason: 'not-text' } : { ok: true, text };
}

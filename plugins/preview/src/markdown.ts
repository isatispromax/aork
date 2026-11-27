/** Markdown as HTML the workbench page can hold. Browser only: the sanitiser needs a DOM.
 * The page is served without a Content Security Policy, so the one rule here is that nothing
 * reaches the page unsanitised: where the sanitiser cannot run, nothing is rendered and the
 * caller shows the source instead. */
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: false });

/** What the sanitiser is asked to leave out on top of its own rules: a Markdown document is read,
 * not operated. */
const FORBIDDEN = {
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['srcset'],
};

let linksHooked = false;
/** Every link keeps working after sanitising, in a tab of its own and without a handle on this one. */
function hookLinks(): void {
  if (linksHooked) return;
  linksHooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

/** Markdown as sanitised HTML, or `undefined` where the sanitiser is not available. */
export function renderMarkdown(text: string): string | undefined {
  if (!DOMPurify.isSupported) return undefined;
  hookLinks();
  const html = marked.parse(text, { async: false });
  return DOMPurify.sanitize(html, FORBIDDEN);
}

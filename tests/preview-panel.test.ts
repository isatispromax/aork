import { describe, expect, it } from 'vitest';
import { FILE_LIMITS, isPreviewable, matchSuffix, UNPREVIEWABLE_SUFFIXES } from '@aork/contracts/preview';
import { FILE_LIMITS as WORKSPACE_FILE_LIMITS } from '@aork/contracts/workspace';
import { baseName, previewForms, previewLanguage, resolveWorkspaceLink } from '../plugins/preview/src/kinds.js';
import { codeLines } from '../plugins/preview/src/lines.js';
import { decodePreviewText } from '../plugins/preview/src/text.js';

/** The ways a file can be shown, as "way:label" in order. */
const ways = (path: string): string[] => previewForms(path).map(form => `${form.way}:${form.label}`);

describe('preview suffix matching', () => {
    it('takes the file limits from the same place the file service does', () => {
        expect(FILE_LIMITS).toBe(WORKSPACE_FILE_LIMITS);
    });

    it('matches the longest listed suffix, ignoring case, and never a dotfile that is only the suffix', () => {
        expect(matchSuffix('docs/notes.tar.gz', ['gz', 'tar.gz'])).toBe('tar.gz');
        expect(matchSuffix('docs/notes.tar.gz', ['tar.gz', 'gz'])).toBe('tar.gz');
        expect(matchSuffix('README.MD', ['md'])).toBe('md');
        expect(matchSuffix('a/b/c/main.test.ts', ['ts', 'test.ts'])).toBe('test.ts');
        expect(matchSuffix('.png', ['png'])).toBeUndefined();
        expect(matchSuffix('image.png', ['md', 'svg'])).toBeUndefined();
    });

    it('tells files no preview can render from everything else, compound suffixes included', () => {
        for (const suffix of UNPREVIEWABLE_SUFFIXES) expect(isPreviewable(`dir/file.${suffix}`), suffix).toBe(false);
        expect(isPreviewable('release/app-1.2.3.tar.gz')).toBe(false);
        expect(isPreviewable('报告.DOCX')).toBe(false);
        for (const path of ['README.md', 'src/main.ts', 'image.png', 'paper.pdf', 'page.html', 'data.csv', 'Dockerfile', '.gitignore', 'notes', 'schema.sqlite3.bak', 'font.ttfx']) {
            expect(isPreviewable(path), path).toBe(true);
        }
    });
});

describe('preview ways of showing a file', () => {
    it('shows each kind of file its own way, offering the source beside what can be rendered', () => {
        expect(ways('README.md')).toEqual(['markdown:Markdown', 'code:源码']);
        expect(ways('docs/index.html')).toEqual(['html:网页', 'code:源码']);
        expect(ways('assets/logo.SVG')).toEqual(['image:图片', 'code:源码']);
        expect(ways('photo.jpg')).toEqual(['image:图片']);
        expect(ways('paper.pdf')).toEqual(['pdf:PDF']);
    });

    it('shows text as source where a language colours it and as plain text otherwise', () => {
        expect(ways('src/main.ts')).toEqual(['code:源码']);
        expect(ways('notes.txt')).toEqual(['code:文本']);
        expect(ways('Dockerfile')).toEqual(['code:文本']);
        expect(previewLanguage('src/main.tsx')).toBe('typescript');
        expect(previewLanguage('styles.SCSS')).toBe('css');
        expect(previewLanguage('ui/button.jsx')).toBe('javascript');
        expect(previewLanguage('deploy.yaml')).toBe('yaml');
        expect(previewLanguage('query.sql')).toBe('sql');
        expect(previewLanguage('notes.txt')).toBe('plaintext');
        expect(previewLanguage('no-such.suffix')).toBe('plaintext');
    });

    it('gives a file nothing can render no way at all, so it is never read', () => {
        expect(ways('backup.zip')).toEqual([]);
        expect(ways('video.mp4')).toEqual([]);
        expect(ways('sheet.xlsx')).toEqual([]);
        expect(ways('lib/foo.node')).toEqual([]);
    });

    it('names a file by its last segment', () => {
        expect(baseName('a/b/notes.md')).toBe('notes.md');
        expect(baseName('notes.md')).toBe('notes.md');
    });
});

describe('links inside a document', () => {
    it('resolve relative to the linking file, and from the Workspace root behind a leading slash', () => {
        expect(resolveWorkspaceLink('docs/guide.md', 'detail.md')).toBe('docs/detail.md');
        expect(resolveWorkspaceLink('docs/guide.md', './detail.md#usage')).toBe('docs/detail.md');
        expect(resolveWorkspaceLink('docs/guide.md', '../README.md?from=guide')).toBe('README.md');
        expect(resolveWorkspaceLink('docs/guide.md', '/src/main.ts')).toBe('src/main.ts');
        expect(resolveWorkspaceLink('guide.md', 'a/b/../c.md')).toBe('a/c.md');
        // A relative link is relative to the linking file's own directory.
        expect(resolveWorkspaceLink('docs/guide.md', '%E8%AF%B4%E6%98%8E.md')).toBe('docs/说明.md');
    });

    it('have no Workspace target where they leave it, name the root or cannot be read as a path', () => {
        expect(resolveWorkspaceLink('docs/guide.md', '../../etc/passwd')).toBeUndefined();
        expect(resolveWorkspaceLink('docs/guide.md', '/..')).toBeUndefined();
        expect(resolveWorkspaceLink('docs/guide.md', '/')).toBeUndefined();
        expect(resolveWorkspaceLink('docs/guide.md', '%E0%A4%A')).toBeUndefined();
        expect(resolveWorkspaceLink('docs/guide.md', 'a\\b.md')).toBeUndefined();
    });
});

describe('reading a file as text', () => {
    const encoder = new TextEncoder();

    it('reads UTF-8 text and keeps a byte-order mark as the file service does', () => {
        expect(decodePreviewText(encoder.encode('# 标题\n正文'))).toEqual({ ok: true, text: '# 标题\n正文' });
        expect(decodePreviewText(new Uint8Array([0xef, 0xbb, 0xbf, 0x23, 0x20]))).toEqual({ ok: true, text: '\ufeff# ' });
        expect(decodePreviewText(new Uint8Array())).toEqual({ ok: true, text: '' });
    });

    it('refuses what the text limit and the definition of text refuse', () => {
        // Exactly the limit is text; one byte more is not read as text at all.
        const atLimit = encoder.encode('a'.repeat(FILE_LIMITS.textBytes));
        expect(decodePreviewText(atLimit)).toEqual({ ok: true, text: 'a'.repeat(FILE_LIMITS.textBytes) });
        expect(decodePreviewText(new Uint8Array(FILE_LIMITS.textBytes + 1))).toEqual({ ok: false, reason: 'too-large' });
        expect(decodePreviewText(new Uint8Array([0xff, 0xfe, 0x00, 0x23]))).toEqual({ ok: false, reason: 'not-text' });
        expect(decodePreviewText(encoder.encode('a\0b'))).toEqual({ ok: false, reason: 'not-text' });
    });
});

describe('source as lines', () => {
    it('breaks lines where the text does, and each piece keeps the colour of the span it came from', () => {
        const tokens = [
            { text: 'const ', scope: 'hljs-keyword' },
            { text: 'a = `one' },
            { text: '\ntwo', scope: 'hljs-string' },
            { text: '`;', scope: 'hljs-string' },
            { text: '\n// done', scope: 'hljs-comment' },
        ];
        expect(codeLines(tokens)).toEqual([
            // The break sits at the start of the string's second piece, so that piece opens the next line.
            [{ text: 'const ', scope: 'hljs-keyword' }, { text: 'a = `one' }],
            [{ text: 'two', scope: 'hljs-string' }, { text: '`;', scope: 'hljs-string' }],
            [{ text: '// done', scope: 'hljs-comment' }],
        ]);
        expect(codeLines([{ text: 'plain' }])).toEqual([[{ text: 'plain' }]]);
        expect(codeLines([])).toEqual([[]]);
    });

    it('leaves no empty line after a final line break, but keeps the ones inside the text', () => {
        expect(codeLines([{ text: 'a\n\nb\n' }])).toEqual([[{ text: 'a' }], [], [{ text: 'b' }]]);
        expect(codeLines([{ text: 'a\n\n' }])).toEqual([[{ text: 'a' }], []]);
        expect(codeLines([{ text: '\n' }])).toEqual([[]]);
    });
});

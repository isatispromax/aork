/** What can be previewed, as pure logic a browser bundle can take without the Workspace schemas:
 * the file service's limits, and the suffix rules the Files view and the preview panel share. */
export { FILE_LIMITS } from './fileLimits.js';

/** Longest suffix of a Workspace path that is listed in `suffixes`, matched without the dot and
 * ignoring case: `notes.tar.gz` matches `tar.gz` over `gz`. A dotfile whose whole name is the
 * suffix (`.png`) does not match. */
export function matchSuffix(path: string, suffixes: readonly string[]): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  let best: string | undefined;
  for (const suffix of suffixes) {
    const dotted = `.${suffix.toLowerCase()}`;
    if (name.length > dotted.length && name.endsWith(dotted) && (best === undefined || suffix.length > best.length)) best = suffix;
  }
  return best;
}
/** File suffixes that no preview can render: video, audio, archives and disk images, fonts,
 * Office documents and spreadsheets, executables and libraries, databases. The Files view offers
 * no preview for them, and the preview panel names them without reading a byte. */
export const UNPREVIEWABLE_SUFFIXES: readonly string[] = [
  // Video and audio
  'mp4', 'm4v', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'flv', 'mpg', 'mpeg', 'm2ts',
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'oga', 'm4a', 'opus', 'wma', 'aiff', 'aif',
  // Archives, packages and disk images
  'zip', 'tar', 'gz', 'tgz', 'taz', 'bz2', 'tbz', 'xz', 'txz', 'zst', '7z', 'rar', 'lz', 'lzma', 'cpio', 'jar', 'war', 'ear', 'whl', 'apk', 'deb', 'rpm', 'iso', 'dmg',
  // Fonts
  'ttf', 'otf', 'ttc', 'woff', 'woff2', 'eot',
  // Office documents and spreadsheets
  'doc', 'docx', 'dot', 'dotx', 'xls', 'xlsx', 'xlsm', 'xlsb', 'ppt', 'pptx', 'pps', 'ppsx', 'odt', 'ods', 'odp', 'rtf', 'pages', 'numbers', 'key',
  // Executables, libraries and databases
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'o', 'a', 'lib', 'node', 'wasm', 'sqlite', 'sqlite3', 'db', 'mdb',
  // Images a browser does not draw
  'tif', 'tiff', 'psd', 'ai', 'eps',
];
/** Whether a Workspace file is offered for preview at all, judged by its suffix alone. */
export function isPreviewable(path: string): boolean { return matchSuffix(path, UNPREVIEWABLE_SUFFIXES) === undefined; }

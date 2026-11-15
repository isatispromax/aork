import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { relative, isAbsolute, posix, join } from 'node:path';
import semver from 'semver';
import { init, parse } from 'es-module-lexer';
import { AorkError, SDK_VERSION, pluginManifestSchema } from '@aork/sdk';
import { SHARED_CLIENT_IMPORTS } from '@aork/sdk/shared';

function fail(code: string, message: string): never { throw new AorkError(code, message); }
export const canonicalPackagePath = (value: string) => /^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/.test(value) && value.split('/').every(part => part !== '.' && part !== '..' && part !== '');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Versioned regular-file archive. Decode every member before writing any package file. */
export function readPluginArchive(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.length > 32 * 1024 * 1024) fail('PLUGIN_ARCHIVE_INVALID', 'Archive exceeds 32 MiB');
  let input: unknown;
  try { input = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { fail('PLUGIN_ARCHIVE_INVALID', 'Archive must be versioned JSON'); }
  if (!input || typeof input !== 'object' || Object.keys(input).sort().join(',') !== 'archiveVersion,members' || !('archiveVersion' in input) || input.archiveVersion !== 1 || !('members' in input) || !Array.isArray(input.members) || !input.members.length || input.members.length > 256) fail('PLUGIN_ARCHIVE_INVALID', 'Unsupported archive envelope');
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const member of input.members) {
    if (!member || typeof member !== 'object' || Object.keys(member).sort().join(',') !== 'data,path,sha256,type' || member.type !== 'file' || typeof member.path !== 'string' || !canonicalPackagePath(member.path) || typeof member.data !== 'string' || typeof member.sha256 !== 'string') fail('PLUGIN_ARCHIVE_INVALID', 'Every member must be a canonical regular file');
    if (files.has(member.path) || [...files.keys()].some(path => path.startsWith(`${member.path}/`) || member.path.startsWith(`${path}/`))) fail('PLUGIN_ARCHIVE_INVALID', 'Duplicate or conflicting archive member');
    const content = Buffer.from(member.data, 'base64');
    total += content.length;
    if (content.toString('base64') !== member.data || digest(content) !== member.sha256 || total > 24 * 1024 * 1024) fail('PLUGIN_ARCHIVE_INVALID', 'Invalid archive member integrity or size');
    files.set(member.path, content);
  }
  return files;
}

/** Filesystem catalogs are checked too: no package/root links or unlisted payloads. */
export async function readPackageFiles(directory: string, catalogRoot: string) {
  const root = await realpath(catalogRoot);
  const actual = await realpath(directory);
  const inside = relative(root, actual);
  if ((await lstat(directory)).isSymbolicLink() || inside.startsWith('..') || isAbsolute(inside)) fail('PLUGIN_PATH_INVALID', 'Package escapes its catalog');
  const files = new Map<string, Uint8Array>();
  async function collect(path: string, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (!canonicalPackagePath(name) || entry.isSymbolicLink()) fail('PLUGIN_PATH_INVALID', `Invalid package member ${name}`);
      if (entry.isDirectory()) await collect(join(path, entry.name), `${name}/`);
      else if (entry.isFile()) files.set(name, await readFile(join(path, entry.name)));
      else fail('PLUGIN_PATH_INVALID', `Package member ${name} is not a regular file`);
    }
  }
  await collect(directory);
  return files;
}

export async function inspectCatalog(directory: string) {
  const entries: Array<{ id: string; version: string }> = [];
  try {
    if ((await lstat(directory)).isSymbolicLink()) fail('PLUGIN_PATH_INVALID', 'Plugin catalog must not be a link');
  } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return entries; throw error; }
  for (const plugin of await readdir(directory, { withFileTypes: true })) {
    if (!plugin.isDirectory() || !/^[a-z][a-z0-9.-]*$/.test(plugin.name)) fail('PLUGIN_PATH_INVALID', 'Invalid plugin catalog directory');
    for (const version of await readdir(join(directory, plugin.name), { withFileTypes: true })) {
      if (!version.isDirectory() || !semver.valid(version.name)) fail('PLUGIN_PATH_INVALID', 'Invalid plugin version directory');
      const manifest = await validatePackageFiles(await readPackageFiles(join(directory, plugin.name, version.name), directory));
      if (manifest.id !== plugin.name || manifest.version !== version.name) fail('PLUGIN_IDENTITY_MISMATCH', 'Package manifest differs from its catalog identity');
      entries.push({ id: manifest.id, version: manifest.version });
    }
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id) || semver.compare(a.version, b.version));
}

/** Import constraints describe packaging, not a sandbox for trusted same-origin plugin code. */
export async function validatePackageFiles(files: Map<string, Uint8Array>) {
  const bytes = files.get('aork.plugin.json');
  if (!bytes) fail('PLUGIN_MANIFEST_MISSING', 'Package has no aork.plugin.json');
  const manifest = pluginManifestSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
  if (!semver.valid(manifest.version)) fail('PLUGIN_VERSION_INVALID', 'Plugin version must be an exact semantic version');
  if (!semver.validRange(manifest.sdkRange) || !semver.satisfies(SDK_VERSION, manifest.sdkRange)) fail('SDK_INCOMPATIBLE', `${manifest.id} requires SDK ${manifest.sdkRange}; Host has ${SDK_VERSION}`);
  if (manifest.capabilities.length) fail('CAPABILITY_UNAVAILABLE', 'This initial installer supports no native capabilities or migrations');
  const declared = new Set([manifest.server, manifest.client, manifest.maintenance, ...manifest.assets].filter((path): path is string => Boolean(path)));
  for (const path of declared) if (!files.has(path)) fail('PLUGIN_ENTRY_MISSING', `Missing declared package file ${path}`);
  for (const path of files.keys()) {
    const magic = Buffer.from(files.get(path)!.subarray(0, 4)).toString('hex');
    if (/\.(node|dll|dylib|so|wasm|exe|sh|bat)$/i.test(path) || /(^|\/)node_modules\//.test(path) || ['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', '0061736d'].includes(magic) || magic.startsWith('4d5a')) fail('PLUGIN_NATIVE_UNSUPPORTED', `Unsupported native or dependency payload ${path}`);
    if (path !== 'aork.plugin.json' && !declared.has(path)) fail('PLUGIN_FILE_UNDECLARED', `Undeclared package file ${path}`);
  }
  for (const entry of [manifest.server, manifest.client, manifest.maintenance].filter((value): value is string => Boolean(value))) if (!/\.(m?js)$/.test(entry)) fail('PLUGIN_ENTRY_INVALID', 'Executable entries must be prebuilt ESM .js or .mjs');
  const publicFiles = new Set([manifest.client, ...manifest.assets].filter((value): value is string => Boolean(value)));
  for (const entry of [manifest.server, manifest.maintenance]) if (entry && publicFiles.has(entry)) fail('PLUGIN_ENTRY_INVALID', 'Server and maintenance entries must remain private');
  for (const path of manifest.assets.filter(path => path.endsWith('.css'))) {
    // CSS escapes are decoded before finding imports/URLs, so escaped "url" cannot bypass containment.
    const css = Buffer.from(files.get(path)!).toString('utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\\([a-fA-F0-9]{1,6})\s?|\\([^\r\n\f])/g, (_match, hex: string | undefined, character: string | undefined) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : character!);
    const references = [...css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)|@import\s*(?:"([^"]*)"|'([^']*)')/gi)];
    for (const match of references) {
      const reference = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '').trim();
      if (reference.startsWith('#')) continue;
      const target = posix.normalize(posix.join(posix.dirname(path), reference.split(/[?#]/)[0]!));
      if (!reference || /^(?:\/|[a-z][a-z0-9+.-]*:)/i.test(reference) || !canonicalPackagePath(target) || !publicFiles.has(target)) fail('PLUGIN_ASSET_INVALID', `${path} references a resource outside its explicit assets`);
    }
  }
  await init;
  for (const path of declared) {
    if (!/\.(m?js)$/.test(path)) continue;
    const source = Buffer.from(files.get(path)!).toString('utf8');
    const client = publicFiles.has(path);
    if (client && /__CLIENT_INTERNALS_DO_NOT_USE|__SECRET_INTERNALS_DO_NOT_USE|react\.transitional\.element|react\.element|react-dom\/cjs|react\/cjs/.test(source)) fail('PLUGIN_REACT_DUPLICATE', 'Client bundles a React runtime; use the Host import map');
    // esbuild's fully bundled CommonJS helper is named `function __require()`;
    // the declaration is harmless, but calls to unresolved require remain forbidden.
    const dependencyCalls = source.replace(/\bfunction\s+(?:require|__require)\s*\(/g, 'function(');
    if (/(?:\brequire|\b__require)\s*\(/.test(dependencyCalls)) fail('PLUGIN_IMPORT_UNSUPPORTED', `${path} has an unresolved CommonJS dependency`);
    let imports;
    try { [imports] = parse(source, path); } catch { fail('PLUGIN_ENTRY_INVALID', `Cannot parse ESM entry ${path}`); }
    for (const imported of imports) {
      if (imported.d === -2) continue;
      if (!imported.n) fail('PLUGIN_IMPORT_UNSUPPORTED', `${path} has a computed import`);
      const specifier = imported.n;
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const target = posix.normalize(posix.join(posix.dirname(path), specifier));
        if (!canonicalPackagePath(target) || !declared.has(target) || (client && !publicFiles.has(target)) || !/\.(m?js)$/.test(target)) fail('PLUGIN_IMPORT_UNSUPPORTED', `${path} imports undeclared or private ${specifier}`);
      } else if (client ? !SHARED_CLIENT_IMPORTS.includes(specifier as typeof SHARED_CLIENT_IMPORTS[number]) : !specifier.startsWith('node:') || !isBuiltin(specifier)) fail('PLUGIN_IMPORT_UNSUPPORTED', `${path} imports unsupported ${specifier}`);
    }
  }
  return manifest;
}

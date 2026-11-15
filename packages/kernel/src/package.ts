import { parse as parseJavaScript } from 'acorn';
import { compileConfig } from './config.js';
import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { relative, isAbsolute, posix, join } from 'node:path';
import semver from 'semver';
import { init, parse } from 'es-module-lexer';
import { AorkError, SDK_VERSION, pluginManifestSchema } from '@aork/sdk';
import { HOST_CAPABILITIES } from '@aork/sdk/server';
import { UI_CONTRACTS, UI_EXTENSION_TARGETS } from '@aork/sdk/client';
import { SHARED_CLIENT_IMPORTS } from '@aork/sdk/shared';

function fail(code: string, message: string): never { throw new AorkError(code, message); }
export const canonicalPackagePath = (value: string) => /^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/.test(value) && value.split('/').every(part => part !== '.' && part !== '..' && part !== '');
const requireChecked=new Set<string>();
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
  for (const capability of manifest.capabilities) if (!HOST_CAPABILITIES.includes(capability)) fail('CAPABILITY_UNAVAILABLE', `${manifest.id}@${manifest.version}: unsupported Host capability ${capability}. Remove it or use a compatible Host.`);
  for (const dependency of manifest.dependencies) if (!semver.validRange(dependency.range)) fail('PLUGIN_DEPENDENCY_RANGE_INVALID', `${manifest.id}@${manifest.version}: invalid version range for dependency ${dependency.id}. Correct dependencies.range.`);
  compileConfig(manifest);
  if (manifest.ui.runtime && (!semver.validRange(manifest.ui.runtime.react) || !semver.satisfies('19.2.4', manifest.ui.runtime.react) || !semver.validRange(manifest.ui.runtime.sdk) || !semver.satisfies(SDK_VERSION, manifest.ui.runtime.sdk))) fail('UI_RUNTIME_INCOMPATIBLE', `${manifest.id}@${manifest.version}: shared React 19.2.4 / SDK ${SDK_VERSION} does not satisfy ui.runtime. Rebuild against the Host shared runtime.`);
  const uiIds = new Set<string>();
  for (const provider of manifest.ui.providers) {
    if (uiIds.has(provider.id)) fail('UI_PROVIDER_DUPLICATE', `${manifest.id}@${manifest.version}: duplicate UI provider ${provider.id}. Use unique stable IDs.`);
    uiIds.add(provider.id);
    if (!UI_CONTRACTS.includes(provider.contract as typeof UI_CONTRACTS[number])) fail('UI_CONTRACT_INCOMPATIBLE', `${manifest.id}@${manifest.version}: unsupported UI contract ${provider.contract}. Rebuild for a supported contract major.`);
    if (!manifest.client) fail('UI_ENTRY_MISSING', `${manifest.id}@${manifest.version}: provider ${provider.id} has no client entry. Declare a prebuilt client.`);
  }
  const extensionIds = new Set<string>();
  for (const extension of manifest.ui.extensions) {
    if (extensionIds.has(extension.id) || uiIds.has(extension.id)) fail('UI_EXTENSION_DUPLICATE', `${manifest.id}@${manifest.version}: duplicate extension ${extension.id}. Use unique stable IDs.`);
    extensionIds.add(extension.id);
    if (!UI_EXTENSION_TARGETS.includes(extension.target as typeof UI_EXTENSION_TARGETS[number])) fail('UI_EXTENSION_TARGET_UNAVAILABLE', `${manifest.id}@${manifest.version}: unsupported extension target ${extension.target}. Use a supported target major.`);
    if (!manifest.client) fail('UI_ENTRY_MISSING', `${manifest.id}@${manifest.version}: extension ${extension.id} has no client entry. Declare a prebuilt client.`);
  }
  for (const contribution of [...manifest.ui.providers, ...manifest.ui.extensions]) for (const capability of contribution.capabilities) if (!manifest.capabilities.includes(capability)) fail('UI_CAPABILITY_UNDECLARED', `${manifest.id}@${manifest.version}: UI ${contribution.id} requires undeclared capability ${capability}. Declare it and obtain an explicit profile grant.`);
  for (const service of Object.keys(manifest.serviceModes)) if (!manifest.provides.includes(service)) fail('SERVICE_UNDECLARED', `${manifest.id}@${manifest.version}: serviceModes names undeclared ${service}. Declare the provided contract.`);
  for (const [field, values] of [['provides', manifest.provides], ['requires', manifest.requires], ['optionalRequires', manifest.optionalRequires], ['capabilities', manifest.capabilities], ['dependencies', manifest.dependencies.map(item => item.id)]] as const) if (new Set(values).size !== values.length) fail('MANIFEST_DUPLICATE', `${manifest.id}@${manifest.version}: duplicate ${field} declaration. Remove the repeated ID.`);
  const declared = new Set([manifest.server, manifest.client, manifest.maintenance, ...manifest.assets,...manifest.executables].filter((path): path is string => Boolean(path)));
  for (const path of declared) if (!files.has(path)) fail('PLUGIN_ENTRY_MISSING', `Missing declared package file ${path}`);
  for (const path of files.keys()) {
    const magic = Buffer.from(files.get(path)!.subarray(0, 4)).toString('hex');
    if (/\.(node|dll|dylib|so|wasm|exe|sh|bat)$/i.test(path) || /(^|\/)node_modules\//.test(path) || ['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', '0061736d'].includes(magic) || magic.startsWith('4d5a')) fail('PLUGIN_NATIVE_UNSUPPORTED', `Unsupported native or dependency payload ${path}`);
    if (path !== 'aork.plugin.json' && !declared.has(path)) fail('PLUGIN_FILE_UNDECLARED', `Undeclared package file ${path}`);
  }
  for (const entry of [manifest.server, manifest.client, manifest.maintenance,...manifest.executables].filter((value): value is string => Boolean(value))) if (!/\.(m?js)$/.test(entry)) fail('PLUGIN_ENTRY_INVALID', 'Executable entries must be prebuilt ESM .js or .mjs');
  if(new Set(manifest.executables).size!==manifest.executables.length||manifest.executables.some(entry=>entry===manifest.server||entry===manifest.maintenance||entry===manifest.client||manifest.assets.includes(entry)))fail('PLUGIN_ENTRY_INVALID','Private executable entries must be distinct from all other entries and public assets');
  const publicFiles = new Set([manifest.client, ...manifest.assets].filter((value): value is string => Boolean(value)));
  for (const entry of [manifest.server, manifest.maintenance,...manifest.executables]) if (entry && publicFiles.has(entry)) fail('PLUGIN_ENTRY_INVALID', 'Server and maintenance entries must remain private');
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
    // Every JS entry is syntax-checked. Identifier escapes, optional calls and comments
    // cannot bypass this admission gate. Cache only a bounded no-unresolved-call summary;
    // role-sensitive import validation below still runs for every entry/cache hit.
    const hash=digest(Buffer.from(source));
    if(!requireChecked.has(hash)){
      let syntax:import('acorn').Node;
      try{syntax=parseJavaScript(source,{ecmaVersion:'latest',sourceType:'module'});}catch{fail('PLUGIN_ENTRY_INVALID',`Cannot parse ESM entry ${path}`);}
      const nodes:unknown[]=[syntax];
      while(nodes.length){
        const value=nodes.pop();
        if(!value||typeof value!=='object')continue;
        if(Array.isArray(value)){nodes.push(...value);continue;}
        const node=value as Record<string,unknown>;
        const callee=node.callee as Record<string,unknown>|undefined;
        if(node.type==='CallExpression'&&callee?.type==='Identifier'&&['require','__require'].includes(String(callee.name)))fail('PLUGIN_IMPORT_UNSUPPORTED',`${path} has an unresolved CommonJS dependency`);
        for(const child of Object.values(node))if(child&&typeof child==='object')nodes.push(child);
      }
      if(requireChecked.size>=128)requireChecked.delete(requireChecked.values().next().value!);
      requireChecked.add(hash);
    }
    let imports;
    try { [imports] = parse(source, path); } catch { fail('PLUGIN_ENTRY_INVALID', `Cannot parse ESM entry ${path}`); }
    for (const imported of imports) {
      if (imported.d === -2) continue;
      if (!imported.n) fail('PLUGIN_IMPORT_UNSUPPORTED', `${path} has a computed import`);
      const specifier = imported.n;
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const target = posix.normalize(posix.join(posix.dirname(path), specifier));
        if (!canonicalPackagePath(target) || !declared.has(target) || (client && !publicFiles.has(target)) || !/\.(m?js)$/.test(target)) fail('PLUGIN_IMPORT_UNSUPPORTED', `${path} imports undeclared or private ${specifier}`);
      } else if (client ? !SHARED_CLIENT_IMPORTS.includes(specifier as typeof SHARED_CLIENT_IMPORTS[number]) : !specifier.startsWith('node:') || !isBuiltin(specifier) || specifier === 'node:sqlite') fail('PLUGIN_IMPORT_UNSUPPORTED', `${path} imports unsupported ${specifier}`);
    }
  }
  return manifest;
}

/** Read static package ownership for local recovery without validating a currently broken composition or importing entries. */
export async function inspectPackageManifest(selection: { id: string; version: string }, pluginsDir: string, installedDir?: string) {
  if (!/^[a-z][a-z0-9.-]*$/.test(selection.id) || !semver.valid(selection.version)) fail('PLUGIN_VERSION_INVALID', 'Recovery requires a valid package identity and exact semantic version');
  let files: Map<string, Uint8Array>;
  try { files = await readPackageFiles(join(pluginsDir, selection.id, selection.version), pluginsDir); }
  catch (error) { if (!installedDir || !(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; files = await readPackageFiles(join(installedDir, selection.id, selection.version), installedDir); }
  const manifest = await validatePackageFiles(files);
  if (manifest.id !== selection.id || manifest.version !== selection.version) fail('PLUGIN_IDENTITY_MISMATCH', `${selection.id}@${selection.version}: manifest differs from the selected package. Repair the catalog package.`);
  return manifest;
}

import { z } from 'zod';

export const SDK_VERSION = '0.1.0';
export const API_VERSION = 1;
const stableId = z.string().regex(/^[a-z][a-z0-9.-]*$/);
const serviceId = z.string().regex(/^[a-z][a-z0-9.-]*@[1-9][0-9]*$/);
const entry = z.string().min(1).regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/, 'must be a canonical relative package path').refine(value => value.split('/').every(part => part !== '.' && part !== '..' && part !== ''), 'must be a canonical relative package path');
export const pluginManifestSchema = z.object({
  manifestVersion: z.literal(1), id: stableId, version: z.string(), sdkRange: z.string(),
  server: entry.optional(), client: entry.optional(), maintenance: entry.optional(), assets: z.array(entry).default([]), executables:z.array(entry).max(8).default([]),
  dependencies: z.array(z.object({ id: stableId, range: z.string().max(128), optional: z.boolean().default(false) }).strict()).default([]),
  optionalRequires: z.array(serviceId).default([]),
  serviceModes: z.record(serviceId, z.enum(['singleton', 'multi-provider'])).default({}),
  requires: z.array(serviceId).default([]), provides: z.array(serviceId).default([]),
  capabilities: z.array(stableId).default([]),
  configSchema: z.union([z.boolean(), z.record(z.string(), z.unknown())]).optional(),
  ui: z.object({
    runtime: z.object({ react: z.string().max(128), sdk: z.string().max(128) }).strict().optional(),
    providers: z.array(z.object({ id: stableId, contract: serviceId, requires: z.array(serviceId).default([]), capabilities: z.array(stableId).default([]) }).strict()).default([]),
    extensions: z.array(z.object({ id: stableId, target: serviceId, order: z.number().int().default(0), requires: z.array(serviceId).default([]), capabilities: z.array(stableId).default([]) }).strict()).default([]),
  }).strict(),
}).strict();
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export const distributionProfileSchema = z.object({
  schemaVersion: z.literal(1), id: stableId, services: z.record(serviceId, stableId).optional(),
  plugins: z.array(z.object({ id: stableId, version: z.string(), enabled: z.boolean(), config: z.record(z.string(), z.json()).optional(), grants: z.array(stableId).optional() }).strict()),
  ui: z.object({ fallbacks: z.record(serviceId, z.string().regex(/^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/)).optional(), providers: z.record(serviceId, z.string().regex(/^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/)), extensions: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/), order: z.number().int(), hidden: z.boolean() }).strict()).default([]) }).strict(),
}).strict();
export type DistributionProfile = z.infer<typeof distributionProfileSchema>;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface Diagnostic { code: string; message: string; pluginId?: string; version?: string; contract?: string; location?: string; remedy?: string }
export interface AccessState { state: 'unauthenticated' | 'authenticated' | 'unavailable'; identity?: string; csrfToken?: string }
export interface Bootstrap {
  apiVersion: 1; sdkVersion: string; hostEpoch: string; pluginGraphHash: string;
  profile: DistributionProfile; access: AccessState; diagnostics: Diagnostic[];
  plugins: Array<{ id: string; version: string; client?: string; styles: string[]; manifest: PluginManifest }>;
  ui: DistributionProfile['ui']; maintenance: { command: string };
}
export class AorkError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); this.name = 'AorkError'; }
}
/** Prebuilt plugins may carry another SDK module identity. Only explicit public errors cross transport. */
export function isAorkError(error: unknown): error is AorkError {
  return error instanceof Error && error.name === 'AorkError' && 'code' in error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code) && 'status' in error && typeof error.status === 'number' && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599;
}

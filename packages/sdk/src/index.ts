import { z } from 'zod';

export const SDK_VERSION = '0.1.0';
export const API_VERSION = 1;
const stableId = z.string().regex(/^[a-z][a-z0-9.-]*$/);
const serviceId = z.string().regex(/^[a-z][a-z0-9.-]*@[1-9][0-9]*$/);
const entry = z.string().min(1).regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/, 'must be a canonical relative package path').refine(value => value.split('/').every(part => part !== '.' && part !== '..' && part !== ''), 'must be a canonical relative package path');
export const pluginManifestSchema = z.object({
  manifestVersion: z.literal(1), id: stableId, version: z.string(), sdkRange: z.string(),
  server: entry.optional(), client: entry.optional(), assets: z.array(entry).default([]),
  requires: z.array(serviceId).default([]), provides: z.array(serviceId).default([]),
  capabilities: z.array(stableId).default([]),
  ui: z.object({ providers: z.array(z.object({ id: stableId, contract: serviceId }).strict()).default([]) }).strict(),
}).strict();
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export const distributionProfileSchema = z.object({
  schemaVersion: z.literal(1), id: stableId,
  plugins: z.array(z.object({ id: stableId, version: z.string(), enabled: z.boolean() }).strict()),
  ui: z.object({ providers: z.record(serviceId, z.string().regex(/^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/)), extensions: z.array(z.object({ id: z.string(), order: z.number().int(), hidden: z.boolean() }).strict()).default([]) }).strict(),
}).strict();
export type DistributionProfile = z.infer<typeof distributionProfileSchema>;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface Diagnostic { code: string; message: string; pluginId?: string; location?: string }
export interface AccessState { state: 'setup_required' | 'unauthenticated' | 'authenticated' | 'unavailable'; identity?: string }
export interface Bootstrap {
  apiVersion: 1; sdkVersion: string; hostEpoch: string; pluginGraphHash: string;
  profile: DistributionProfile; access: AccessState; diagnostics: Diagnostic[];
  plugins: Array<{ id: string; version: string; client?: string; styles: string[]; manifest: PluginManifest }>;
  ui: DistributionProfile['ui']; maintenance: { command: string };
}
export class AorkError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); this.name = 'AorkError'; }
}

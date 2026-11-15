import { z } from 'zod';
import semver from 'semver';
import type { SyncTransaction } from '@aork/sdk/server';
export const AGENT_PROVIDER_REGISTRY = 'aork.agent.providers@1';
export const AGENT_PROFILES_SERVICE = 'aork.agent.profiles@1';
export const CREDENTIAL_BROKER = 'aork.agent.credentials@1';
const id = z.uuid();
const providerId = z.string().regex(/^[a-z][a-z0-9.-]*$/).max(100);
const name = z.string().trim().min(1).max(120);
const semanticVersion = z.string().max(100).refine(value => semver.valid(value) !== null, 'Must be a valid semantic version');
const parameters = z.record(z.string().max(100), z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]));
export const authenticationSchema = z.enum(['none', 'api-key', 'native-oauth']);
export const detectionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), version: semanticVersion }).strict(),
  z.object({ status: z.literal('unavailable'), reason: z.enum(['binary-missing', 'unsupported-version', 'provider-failed']) }).strict(),
]);
export const providerMetadataSchema = z.object({ id: providerId, label: name, version: semanticVersion, authentication: z.array(authenticationSchema).min(1), parameters: z.array(z.object({ name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/).max(100), label: name, type: z.literal('string') }).strict()).max(30) }).strict();
export const profileInputSchema = z.object({ name, providerId, parameters: parameters.default({}), versionRequirement: z.string().trim().min(1).max(100), authentication: authenticationSchema, credentialRef: id.nullable().default(null) }).strict();
export const profileSchema = profileInputSchema.extend({ id, revision: z.number().int().positive(), stateDirectory: z.string().min(1) }).strict();
export const editProfileSchema = profileInputSchema.extend({ id, expectedRevision: z.number().int().positive() }).strict();
export const storeCredentialSchema = z.object({ providerId, label: name, secret: z.string().min(1).max(16000) }).strict();
export const credentialSchema = z.object({ id, providerId, label: name, kind: z.literal('api-key') }).strict();
export const credentialStatusSchema = z.enum(['ready', 'missing-key', 'missing-reference', 'unreadable', 'not-required', 'native-directory-only']);
export const overviewSchema = z.object({
  providers: z.array(providerMetadataSchema.extend({ detection: detectionSchema })),
  profiles: z.array(z.object({ profile: profileSchema, availability: z.enum(['available', 'unavailable']), reason: z.enum(['provider-missing', 'binary-missing', 'unsupported-version', 'provider-failed', 'credential-unavailable', 'state-directory-unavailable', 'native-authentication-required']).nullable(), credentialStatus: credentialStatusSchema })),
  credentials: z.array(credentialSchema.extend({ status: credentialStatusSchema })),
  credentialStorage: z.object({ status: z.enum(['ready', 'missing-key']), message: z.string() }).strict(),
}).strict();
export type AgentParameters = z.infer<typeof parameters>;
export type AgentProfile = z.infer<typeof profileSchema>;
export type AgentProfileInput = z.infer<typeof profileInputSchema>;
export type ProviderDetection = z.infer<typeof detectionSchema>;
export type ProviderMetadata = z.infer<typeof providerMetadataSchema>;
export type Credential = z.infer<typeof credentialSchema>;
export type AgentsOverview = z.infer<typeof overviewSchema>;
export type AgentProfileSnapshot = Readonly<Omit<AgentProfile, 'parameters'> & { parameters: Readonly<AgentParameters>; providerDefinitionVersion: string }>;
export interface AgentLaunchDescription { readonly executable: string; readonly arguments: readonly string[]; readonly protocol: 'acp-stdio' }
/** Server-only definition. Providers own fixed launch descriptions in their implementations;
 * browser values are restricted to this declared parameter parser and cannot supply commands. */
export interface AgentProvider extends ProviderMetadata {
  readonly launch: AgentLaunchDescription;
  parseParameters(value: AgentParameters): AgentParameters;
  /** Providers must cancel external detection work when the signal is aborted. */
  detect(options?: { signal: AbortSignal }): ProviderDetection | Promise<ProviderDetection>;
}
/** One service owns dynamic Provider entries. Registration returns an explicit lifecycle disposer. */
export interface AgentProviderRegistry {
  register(provider: AgentProvider): () => void;
  get(id: string): AgentProvider | undefined;
  list(): readonly AgentProvider[];
}
/** A deep, frozen value snapshot; later Profile edits cannot change an existing Run's copy.
 * The lifecycle owner must persist the value with its Run before starting external work. */
export interface AgentProfilesService {
  snapshot(id: string, transaction?: SyncTransaction): AgentProfileSnapshot;
}
/** Trusted server consumers only. Never serialize the resolved value into browser projections. */
export interface CredentialBroker {
  resolveApiKey(reference: string, providerId: string, transaction?: SyncTransaction): string;
}

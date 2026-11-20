import { z } from 'zod';
import semver from 'semver';
import type { SyncTransaction } from '@aork/sdk/server';
export const AGENT_PROVIDER_REGISTRY = 'aork.agent.providers@1';
export const AGENT_PROFILES_SERVICE = 'aork.agent.profiles@1';
export const CREDENTIAL_BROKER = 'aork.agent.credentials@1';
export const LAUNCH_ENVIRONMENT = 'aork.agent.launch-environment@1';
/** Provider-controllable launch environment names. Runtime base names (PATH,
 * LANG, LC_ALL, TMPDIR) are reserved and can never come from a Provider. */
export const PROVIDER_LAUNCH_ENVIRONMENT_NAMES = ['HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_AGENT_ACP_PROTOCOL', 'ANTHROPIC_API_KEY', 'NO_BROWSER', 'CODEX_HOME', 'OPENAI_API_KEY'] as const;
const id = z.uuid();
const providerId = z.string().regex(/^[a-z][a-z0-9.-]*$/).max(100);
const name = z.string().trim().min(1).max(120);
const semanticVersion = z.string().max(100).refine(value => semver.valid(value) !== null, 'Must be a valid semantic version');
const parameters = z.record(z.string().max(100), z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]));
const environmentName = z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(64);
export const authenticationSchema = z.enum(['none', 'api-key', 'native-oauth']);
/** Secret-free assembly plan for a Provider's launch environment. Fixed names and
 * value sources only; secret material is resolved by the credential owner at
 * consumption time and never appears in this plan or its projections. */
export const providerLaunchEnvironmentPlanSchema = z.object({
  fixed: z.record(environmentName, z.string().max(2000).refine(value => !value.includes('\0'), 'Must not contain NUL')).default({}),
  stateDirectoryNames: z.array(environmentName).max(8).default([]),
  homeChildDirectory: z.string().regex(/^[a-z][a-z0-9._-]*$/).max(64).optional(),
  credentialName: environmentName.optional(),
}).strict();
export const detectionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), version: semanticVersion }).strict(),
  z.object({ status: z.literal('unavailable'), reason: z.enum(['binary-missing', 'unsupported-version', 'provider-failed']) }).strict(),
]);
export const providerMetadataSchema = z.object({ id: providerId, label: name, version: semanticVersion, authentication: z.array(authenticationSchema).min(1), parameters: z.array(z.object({ name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/).max(100), label: name, type: z.literal('string') }).strict()).max(30) }).strict();
export const profileInputSchema = z.object({ name, providerId, parameters: parameters.default({}), versionRequirement: z.string().trim().min(1).max(100), authentication: authenticationSchema, credentialRef: id.nullable().default(null) }).strict();
export const profileSchema = profileInputSchema.extend({ id, revision: z.number().int().positive(), stateDirectory: z.string().min(1) }).strict();
export const profileSnapshotSchema = profileSchema.extend({ providerDefinitionVersion: semanticVersion }).strict();
export const editProfileSchema = profileInputSchema.extend({ id, expectedRevision: z.number().int().positive() }).strict();
export const storeCredentialSchema = z.object({ providerId, label: name, secret: z.string().min(1).max(16000) }).strict();
export const credentialSchema = z.object({ id, providerId, label: name, kind: z.literal('api-key') }).strict();
export const credentialStatusSchema = z.enum(['ready', 'missing-key', 'missing-reference', 'unreadable', 'not-required', 'native-directory-only', 'native-login-metadata']);
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
export type ProviderLaunchEnvironmentPlan = z.infer<typeof providerLaunchEnvironmentPlanSchema>;
export type Credential = z.infer<typeof credentialSchema>;
export type AgentsOverview = z.infer<typeof overviewSchema>;
export type AgentProfileSnapshot = Readonly<Omit<AgentProfile, 'parameters'> & { parameters: Readonly<AgentParameters>; providerDefinitionVersion: string }>;
export interface AgentLaunchDescription { readonly executable: string; readonly arguments: readonly string[]; readonly protocol: 'acp-stdio' }
/** Server-only definition. Providers own fixed launch descriptions in their implementations;
 * browser values are restricted to this declared parameter parser and cannot supply commands. */
export interface AgentProvider extends ProviderMetadata {
  readonly launch: AgentLaunchDescription;
  /** Secret-free launch environment assembly per authentication method. Profiles with an
   * authentication method lacking a declared plan stay unlaunchable; 'none' uses only the
   * Runtime base environment. Never observed by browsers. */
  readonly launchEnvironment?: Readonly<Partial<Record<'api-key' | 'native-oauth', ProviderLaunchEnvironmentPlan>>>;
  parseParameters(value: AgentParameters): AgentParameters;
  /** Provider-owned read-only native state inspection; absent means recovery unsupported. */
  inspectNativeSession?(input:{nativeSessionId:string;stateDirectory:string;detectedVersion:string;signal:AbortSignal}):{available:boolean}|Promise<{available:boolean}>;
  /** Read-only, metadata-only observation of local login state inside the Profile's
   * protected directory. 'observed' means local login metadata exists there; it is
   * never remote authorization proof. */
  observeNativeLogin?(input:{stateDirectory:string}):'observed'|'absent'|'unknown'|Promise<'observed'|'absent'|'unknown'>;
  /** Providers must cancel external detection work when the signal is aborted. */
  detect(options?: { signal: AbortSignal }): ProviderDetection | Promise<ProviderDetection>;
}
/** One service owns dynamic Provider entries. Registration returns an explicit lifecycle disposer. */
export interface AgentProviderRegistry {
  register(provider: AgentProvider): () => void;
  get(id: string): AgentProvider | undefined;
  owner(id: string): Readonly<{pluginId:string;version:string}>;
  list(): readonly AgentProvider[];
}
/** A deep, frozen value snapshot; later Profile edits cannot change an existing Run's copy.
 * The lifecycle owner must persist the value with its Run before starting external work. */
export interface AgentProfilesService {
  snapshot(id: string, transaction?: SyncTransaction): AgentProfileSnapshot;
  prepareLaunch(selection: Omit<AgentProfileSnapshot, 'stateDirectory'>): Promise<AgentLaunchSnapshot>;
  validateLaunch(snapshot: AgentLaunchSnapshot, transaction: SyncTransaction): void;
}
/** Trusted server consumers only. Never serialize the resolved value into browser projections. */
export interface CredentialBroker {
  resolveApiKey(reference: string, providerId: string, transaction?: SyncTransaction): string;
}

/** Server-owned, revalidated value captured before process effects. Contains references, never secret material. */
export interface AgentLaunchSnapshot { readonly profile: AgentProfileSnapshot; readonly providerOwner: Readonly<{pluginId:string;version:string}>; readonly launch: AgentLaunchDescription; readonly detectedVersion: string; readonly providerDefinitionVersion: string; /** Names of the Provider-prepared environment for this launch; values stay in-memory. */ readonly environmentNames?: readonly string[] }
/** Opaque one-use spawn authorization for one accepted Run generation. Carries names
 * only; the credential owner resolves secret values synchronously at consumption. */
export interface LaunchEnvironmentGrant { readonly environmentNames: readonly string[] }
/** Scoped to the selected Runtime owner. bind captures the exact prepared snapshot at
 * acceptance; consume hands the assembled environment to a synchronous spawn callback
 * exactly once and discards it. No method accepts a free credential reference. */
export interface LaunchEnvironmentService {
  bind(snapshot: AgentLaunchSnapshot, run: Readonly<{runId:string;generation:number;hostEpoch:string}>): LaunchEnvironmentGrant;
  consume(grant: LaunchEnvironmentGrant, apply: (environment: Readonly<Record<string,string>>) => void): void;
}

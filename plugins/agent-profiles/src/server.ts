import { randomUUID } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import semver from 'semver';
import { AorkError } from '@aork/sdk';
import type { ServerPluginContext, SyncTransaction } from '@aork/sdk/server';
import { AGENT_PROVIDER_REGISTRY, AGENT_PROFILES_SERVICE, CREDENTIAL_BROKER, credentialSchema, detectionSchema, editProfileSchema, overviewSchema, profileInputSchema, profileSchema, providerMetadataSchema, storeCredentialSchema } from '@aork/contracts/agent';
import type { AgentProfile, AgentProfileInput, AgentProvider, AgentProviderRegistry, AgentProfilesService, CredentialBroker, AgentsOverview } from '@aork/contracts/agent';
import { agentRepository } from './persistence/repository.js';
import { credentialCipher, loadMasterKey } from './credentials.js';
export { persistence } from './persistence/repository.js';
function frozen<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); } return value; }
export async function activate(context: ServerPluginContext) {
  const repository = agentRepository(context.repository);
  const key = await loadMasterKey(context.config.masterKeyFile); const cipher = credentialCipher(key);
  context.effect(() => () => { key?.fill(0); });
  const providers = new Map<string, AgentProvider>();
  const providerOwners = new Map<string, import('@aork/sdk/server').OwnerDescriptor>();
  const register = (provider: AgentProvider, owner:import('@aork/sdk/server').OwnerDescriptor) => {
      context.verifyOwner(owner);
      const metadata = providerMetadataSchema.parse({ id: provider.id, label: provider.label, version: provider.version, parameters: provider.parameters, authentication: provider.authentication });
      if (!semver.valid(metadata.version) || typeof provider.parseParameters !== 'function' || typeof provider.detect !== 'function') throw new AorkError('PROVIDER_INVALID', 'Provider definition is invalid');
      if (provider.launch?.protocol !== 'acp-stdio' || typeof provider.launch.executable !== 'string' || !provider.launch.executable || !Array.isArray(provider.launch.arguments) || provider.launch.arguments.some(value => typeof value !== 'string')) throw new AorkError('PROVIDER_INVALID', 'Provider must declare a fixed server-owned ACP launch description');
      if (providers.has(metadata.id)) throw new AorkError('PROVIDER_CONFLICT', 'Provider ID is already registered', 409);
      const registered = frozen({ ...metadata, launch: structuredClone(provider.launch), parseParameters: provider.parseParameters.bind(provider), detect: provider.detect.bind(provider) }); providers.set(metadata.id, registered); providerOwners.set(metadata.id, owner);
      return () => { if (providers.get(metadata.id) === registered) { providers.delete(metadata.id); providerOwners.delete(metadata.id); } };
    };
  const registry:Omit<AgentProviderRegistry,'register'>={
    owner(id) {const owner=providerOwners.get(id);if(!owner)throw new AorkError('PROVIDER_UNAVAILABLE','Agent Provider is unavailable',409);context.verifyOwner(owner);return Object.freeze({pluginId:owner.pluginId,version:owner.version});},
    get: id => providers.get(id), list: () => [...providers.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
  const broker: CredentialBroker = {
    resolveApiKey(reference, providerId, transaction) {
      const row = repository.credential(reference, transaction);
      if (!row || row.credential.providerId !== providerId) throw new AorkError('CREDENTIAL_REFERENCE_INVALID', 'Credential reference is missing or belongs to a different Provider', 409);
      return cipher.decrypt(row.encrypted, reference, providerId);
    },
  };
  const launchBindings=new WeakMap<object,{provider:AgentProvider;owner:import('@aork/sdk/server').OwnerDescriptor}>();
  const service: AgentProfilesService = {
    async prepareLaunch(selection) {
      const profile=service.snapshot(selection.id); const provider=registry.get(profile.providerId)!;
      if(profile.revision!==selection.revision||profile.providerDefinitionVersion!==selection.providerDefinitionVersion)throw new AorkError('PROFILE_REVISION_CHANGED','Saved Session configuration changed. Create a Session with the current Profile explicitly.',409);
      if(profile.authentication!=='none')throw new AorkError('PROVIDER_LAUNCH_AUTH_UNSUPPORTED','This Provider needs its explicit credential injection or native authentication integration before it can run',409);
      if(!(await validDirectory(profile.stateDirectory)))throw new AorkError('AGENT_STATE_DIRECTORY_INVALID','Native state directory is unavailable',409);
      const controller=new AbortController(); let timer:ReturnType<typeof setTimeout>|undefined;
      try {const detection=detectionSchema.parse(await Promise.race([Promise.resolve().then(()=>provider.detect({signal:controller.signal})),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new AorkError('PROVIDER_UNAVAILABLE','Provider detection did not finish',409));},2000);})]));
        if(detection.status!=='available'||!semver.satisfies(detection.version,profile.versionRequirement))throw new AorkError('PROVIDER_UNAVAILABLE','Provider binary is unavailable or outside the saved version range',409);
        if(!(await validDirectory(profile.stateDirectory)))throw new AorkError('AGENT_STATE_DIRECTORY_INVALID','Native state directory changed during launch validation',409);
        const snapshot=frozen({profile,providerOwner:registry.owner(profile.providerId),launch:structuredClone(provider.launch),detectedVersion:detection.version,providerDefinitionVersion:provider.version});launchBindings.set(snapshot,{provider,owner:providerOwners.get(profile.providerId)!});return snapshot;
      } catch(error) {if(error instanceof AorkError)throw error;throw new AorkError('PROVIDER_UNAVAILABLE','Provider launch validation failed',409);} finally {if(timer)clearTimeout(timer);controller.abort();}
    },
    validateLaunch(snapshot,tx) {const binding=launchBindings.get(snapshot);if(!binding)throw new AorkError('LAUNCH_SNAPSHOT_INVALID','Use an actual prepared launch snapshot',409);context.verifyOwner(binding.owner);const current=service.snapshot(snapshot.profile.id,tx);if(current.revision!==snapshot.profile.revision||current.providerDefinitionVersion!==snapshot.providerDefinitionVersion||providerOwners.get(current.providerId)!==binding.owner||registry.get(current.providerId)!==binding.provider)throw new AorkError('PROFILE_REVISION_CHANGED','The launch configuration changed before acceptance',409);},
    snapshot(id, transaction) {
    const profile = repository.profile(id, transaction); if (!profile) throw new AorkError('PROFILE_UNAVAILABLE', 'Agent Profile is unavailable', 404);
    const provider = registry.get(profile.providerId); if (!provider) throw new AorkError('PROVIDER_UNAVAILABLE', 'Agent Provider is not registered', 409);
    return frozen({ ...structuredClone(profile), providerDefinitionVersion: provider.version });
  } };
  context.provideScoped<AgentProviderRegistry>(AGENT_PROVIDER_REGISTRY,owner=>Object.freeze({...registry,register:(provider:AgentProvider)=>register(provider,owner)})); context.provide(CREDENTIAL_BROKER, broker); context.provide(AGENT_PROFILES_SERVICE, service);
  async function validDirectory(directory: string) {
    try { const facts = await stat(directory); return await realpath(directory) === directory && facts.isDirectory() && (facts.mode & 0o077) === 0 && (!process.getuid || facts.uid === process.getuid()); } catch { return false; }
  }
  async function prepareProfile(input: AgentProfileInput, existing?: AgentProfile): Promise<AgentProfile> {
    const provider = registry.get(input.providerId); if (!provider) throw new AorkError('PROVIDER_UNAVAILABLE', 'Choose a registered Agent Provider', 409);
    if (!semver.validRange(input.versionRequirement)) throw new AorkError('PROVIDER_VERSION_INVALID', 'Version requirement must be a valid semantic version range');
    if (!provider.authentication.includes(input.authentication)) throw new AorkError('PROVIDER_AUTH_UNSUPPORTED', 'Provider does not support this authentication method');
    let parameters: AgentProfile['parameters'];
    try { parameters = profileInputSchema.parse({ ...input, parameters: provider.parseParameters(structuredClone(input.parameters)) }).parameters; } catch { throw new AorkError('PROVIDER_PARAMETERS_INVALID', 'Parameters do not match the selected Provider'); }
    if (input.authentication === 'api-key') {
      if (!input.credentialRef) throw new AorkError('CREDENTIAL_REFERENCE_INVALID', 'Choose a valid credential reference', 409);
      broker.resolveApiKey(input.credentialRef, input.providerId);
    } else if (input.credentialRef !== null) throw new AorkError('CREDENTIAL_REFERENCE_INVALID', 'This authentication method does not use a manual credential reference');
    const id = existing?.id ?? randomUUID();
    // A profile's directory is server-generated, never accepted as browser launch configuration.
    const providerDirectory = join(context.directories.pluginState, input.providerId);
    const stateDirectory = join(providerDirectory, id);
    try {
      const stateRoot = dirname(context.directories.pluginState);
      await mkdir(stateRoot, { recursive: true, mode: 0o700 });
      if (!(await validDirectory(stateRoot))) throw new Error('State storage root unavailable');
      await mkdir(context.directories.pluginState, { recursive: true, mode: 0o700 });
      if (!(await validDirectory(context.directories.pluginState))) throw new Error('State root unavailable');
      await mkdir(providerDirectory, { recursive: true, mode: 0o700 });
      if (!(await validDirectory(providerDirectory))) throw new Error('Provider state root unavailable');
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      if (!(await validDirectory(stateDirectory))) throw new Error('State directory unavailable');
    } catch { throw new AorkError('AGENT_STATE_DIRECTORY_INVALID', 'Agent state needs an owner-only, unredirected server directory', 503); }
    return profileSchema.parse({ ...input, parameters, id, revision: (existing?.revision ?? 0) + 1, stateDirectory });
  }
  function credentialStatus(profile: Pick<AgentProfile, 'authentication' | 'credentialRef' | 'providerId'>): AgentsOverview['profiles'][number]['credentialStatus'] {
    if (profile.authentication === 'none') return 'not-required';
    if (profile.authentication === 'native-oauth') return 'native-directory-only';
    const row = profile.credentialRef ? repository.credential(profile.credentialRef) : undefined;
    if (!row || row.credential.providerId !== profile.providerId) return 'missing-reference';
    if (!cipher.available) return 'missing-key';
    try { broker.resolveApiKey(row.credential.id, profile.providerId); return 'ready'; } catch { return 'unreadable'; }
  }
  context.query('agents.overview', { access: 'authenticated', async execute() {
    const detected = await Promise.all(registry.list().map(async provider => {
      let detection: ReturnType<typeof detectionSchema.parse>;
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const value = await Promise.race([
          Promise.resolve().then(() => provider.detect({ signal: controller.signal })),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Provider detection timed out')); }, 2000); }),
        ]);
        detection = detectionSchema.parse(value);
      } catch { detection = { status: 'unavailable', reason: 'provider-failed' }; }
      finally { if (timer) clearTimeout(timer); controller.abort(); }
      return { ...providerMetadataSchema.parse({ id: provider.id, label: provider.label, version: provider.version, authentication: provider.authentication, parameters: provider.parameters }), detection };
    }));
    const profiles = await Promise.all(repository.profiles().map(async profile => {
      const provider = detected.find(candidate => candidate.id === profile.providerId); const credential = credentialStatus(profile);
      let reason: AgentsOverview['profiles'][number]['reason'] = !provider ? 'provider-missing' : provider.detection.status === 'unavailable' ? provider.detection.reason : !semver.satisfies(provider.detection.version, profile.versionRequirement) ? 'unsupported-version' : !['ready', 'not-required', 'native-directory-only'].includes(credential) ? 'credential-unavailable' : null;
      if (!reason && profile.authentication === 'native-oauth') reason = 'native-authentication-required';
      if (!reason && !(await validDirectory(profile.stateDirectory))) reason = 'state-directory-unavailable';
      return { profile, availability: reason ? 'unavailable' : 'available', reason, credentialStatus: credential };
    }));
    return overviewSchema.parse({ providers: detected, profiles, credentials: repository.credentials().map(credential => ({ ...credential, status: credentialStatus({ authentication: 'api-key', providerId: credential.providerId, credentialRef: credential.id }) })), credentialStorage: { status: cipher.available ? 'ready' : 'missing-key', message: cipher.available ? 'Manual credentials use encrypted storage; readiness means local decryption only, not verified remote authentication. Native OAuth files use owner-only directory protection.' : 'Manual credentials require a separately configured, owner-only 32-byte master key file. Native OAuth files use directory protection only.' } });
  } });
  context.durableCommand('agents.storeCredential', {
    version: 1, payload: storeCredentialSchema, result: credentialSchema, events: { 'agents.credentialStored': { version: 1, payload: credentialSchema } },
    prepare(payload) {
      const provider = registry.get(payload.providerId); if (!provider?.authentication.includes('api-key')) throw new AorkError('PROVIDER_AUTH_UNSUPPORTED', 'Choose a Provider supporting manual API credentials');
      const credential = { id: randomUUID(), providerId: payload.providerId, label: payload.label, kind: 'api-key' as const };
      return { credential, encrypted: cipher.encrypt(payload.secret, credential.id, credential.providerId) };
    },
    execute(_payload, prepared, transaction) {
      repository.insertCredential(transaction, prepared.credential, prepared.encrypted);
      return { result: prepared.credential, events: [{ type: 'agents.credentialStored', version: 1, entityId: prepared.credential.id, payload: prepared.credential }] };
    },
  });
  context.durableCommand('agents.createProfile', {
    version: 1, payload: profileInputSchema, result: profileSchema, events: { 'agents.profileCreated': { version: 1, payload: profileSchema } },
    prepare: payload => prepareProfile(payload),
    execute(_payload, profile, transaction) { repository.insertProfile(transaction, profile); return { result: profile, events: [{ type: 'agents.profileCreated', version: 1, entityId: profile.id, payload: profile }] }; },
  });
  context.durableCommand('agents.editProfile', {
    version: 1, payload: editProfileSchema, result: profileSchema, events: { 'agents.profileEdited': { version: 1, payload: profileSchema } },
    prepare(payload) {
      const existing = repository.profile(payload.id); if (!existing) throw new AorkError('PROFILE_UNAVAILABLE', 'Agent Profile is unavailable', 404);
      if (existing.revision !== payload.expectedRevision) throw new AorkError('PROFILE_REVISION_CONFLICT', 'Agent Profile changed; reload before editing', 409);
      return prepareProfile(profileInputSchema.parse({ name: payload.name, providerId: payload.providerId, parameters: payload.parameters, versionRequirement: payload.versionRequirement, authentication: payload.authentication, credentialRef: payload.credentialRef }), existing);
    },
    execute(payload, profile, transaction: SyncTransaction) {
      if (repository.profile(payload.id, transaction)?.revision !== payload.expectedRevision) throw new AorkError('PROFILE_REVISION_CONFLICT', 'Agent Profile changed; reload before editing', 409);
      repository.updateProfile(transaction, profile); return { result: profile, events: [{ type: 'agents.profileEdited', version: 1, entityId: profile.id, payload: profile }] };
    },
  });
}

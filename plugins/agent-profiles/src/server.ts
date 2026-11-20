import { randomUUID } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import semver from 'semver';
import { AorkError } from '@aork/sdk';
import type { ServerPluginContext, SyncTransaction } from '@aork/sdk/server';
import { AGENT_PROVIDER_REGISTRY, AGENT_PROFILES_SERVICE, CREDENTIAL_BROKER, LAUNCH_ENVIRONMENT, PROVIDER_LAUNCH_ENVIRONMENT_NAMES, credentialSchema, detectionSchema, editProfileSchema, overviewSchema, profileInputSchema, profileSchema, providerLaunchEnvironmentPlanSchema, providerMetadataSchema, storeCredentialSchema } from '@aork/contracts/agent';
import type { AgentLaunchSnapshot, AgentProfile, AgentProfileInput, AgentProvider, AgentProviderRegistry, AgentProfilesService, CredentialBroker, AgentsOverview, LaunchEnvironmentGrant, LaunchEnvironmentService, ProviderLaunchEnvironmentPlan } from '@aork/contracts/agent';
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
  function validatedPlan(provider: Pick<AgentProvider,'id'|'launchEnvironment'>, method: 'api-key' | 'native-oauth'): ProviderLaunchEnvironmentPlan | undefined {
    const plan = provider.launchEnvironment?.[method];
    if (!plan) return undefined;
    let parsed: ProviderLaunchEnvironmentPlan;
    try { parsed = providerLaunchEnvironmentPlanSchema.parse(structuredClone(plan)); } catch { throw new AorkError('PROVIDER_INVALID', 'Provider launch environment plan is invalid'); }
    const allowed = new Set<string>(PROVIDER_LAUNCH_ENVIRONMENT_NAMES);
    for (const name of [...Object.keys(parsed.fixed), ...parsed.stateDirectoryNames, ...(parsed.credentialName ? [parsed.credentialName] : [])]) if (!allowed.has(name)) throw new AorkError('PROVIDER_INVALID', `Provider launch environment name ${name} is outside the fixed allowlist`);
    if (method === 'api-key' && !parsed.credentialName) throw new AorkError('PROVIDER_INVALID', 'API-key launch environments must declare their credential injection name');
    if (method === 'native-oauth' && parsed.credentialName) throw new AorkError('PROVIDER_INVALID', 'Native OAuth launch environments must not inject a manual credential');
    return frozen(parsed);
  }
  const register = (provider: AgentProvider, owner:import('@aork/sdk/server').OwnerDescriptor) => {
      context.verifyOwner(owner);
      const metadata = providerMetadataSchema.parse({ id: provider.id, label: provider.label, version: provider.version, parameters: provider.parameters, authentication: provider.authentication });
      if (!semver.valid(metadata.version) || typeof provider.parseParameters !== 'function' || typeof provider.detect !== 'function' || (provider.inspectNativeSession!==undefined&&typeof provider.inspectNativeSession!=='function') || (provider.observeNativeLogin!==undefined&&typeof provider.observeNativeLogin!=='function')) throw new AorkError('PROVIDER_INVALID', 'Provider definition is invalid');
      if (provider.launch?.protocol !== 'acp-stdio' || typeof provider.launch.executable !== 'string' || !provider.launch.executable || !Array.isArray(provider.launch.arguments) || provider.launch.arguments.some(value => typeof value !== 'string')) throw new AorkError('PROVIDER_INVALID', 'Provider must declare a fixed server-owned ACP launch description');
      if (provider.launchEnvironment !== undefined && (!provider.launchEnvironment || typeof provider.launchEnvironment !== 'object' || Array.isArray(provider.launchEnvironment))) throw new AorkError('PROVIDER_INVALID', 'Provider launch environment plans are invalid');
      const plans: Partial<Record<'api-key' | 'native-oauth', ProviderLaunchEnvironmentPlan>> = {};
      if (provider.launchEnvironment) for (const method of ['api-key', 'native-oauth'] as const) { const plan = validatedPlan(provider, method); if (plan) plans[method] = plan; }
      if (providers.has(metadata.id)) throw new AorkError('PROVIDER_CONFLICT', 'Provider ID is already registered', 409);
      const registered = frozen({ ...metadata, launch: structuredClone(provider.launch), ...(Object.keys(plans).length ? { launchEnvironment: plans } : {}), parseParameters: provider.parseParameters.bind(provider), detect: provider.detect.bind(provider), ...(provider.inspectNativeSession?{inspectNativeSession:provider.inspectNativeSession.bind(provider)}:{}), ...(provider.observeNativeLogin?{observeNativeLogin:provider.observeNativeLogin.bind(provider)}:{}) }); providers.set(metadata.id, registered); providerOwners.set(metadata.id, owner);
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
  const launchBindings=new WeakMap<object,{provider:AgentProvider;owner:import('@aork/sdk/server').OwnerDescriptor;plan?:ProviderLaunchEnvironmentPlan;profile:AgentProfile}>();
  const service: AgentProfilesService = {
    async prepareLaunch(selection) {
      const profile=service.snapshot(selection.id); const provider=registry.get(profile.providerId)!;
      if(profile.revision!==selection.revision||profile.providerDefinitionVersion!==selection.providerDefinitionVersion)throw new AorkError('PROFILE_REVISION_CHANGED','Saved Session configuration changed. Create a Session with the current Profile explicitly.',409);
      // Providers without a declared plan for the Profile's authentication method
      // stay unlaunchable; 'none' uses only the Runtime base environment.
      const plan=profile.authentication==='none'?undefined:provider.launchEnvironment?.[profile.authentication];
      if(profile.authentication!=='none'&&!plan)throw new AorkError('PROVIDER_LAUNCH_AUTH_UNSUPPORTED','This Provider needs its explicit credential injection or native authentication integration before it can run',409);
      if(profile.authentication==='api-key'){try{broker.resolveApiKey(profile.credentialRef!,profile.providerId);}catch(error){if(error instanceof AorkError)throw error;throw new AorkError('CREDENTIAL_UNREADABLE','The Profile credential cannot be resolved for launch',503);}}
      if(!(await validDirectory(profile.stateDirectory)))throw new AorkError('AGENT_STATE_DIRECTORY_INVALID','Native state directory is unavailable',409);
      if(plan?.homeChildDirectory){const homeDirectory=join(profile.stateDirectory,plan.homeChildDirectory);try{await mkdir(homeDirectory,{recursive:true,mode:0o700});if(!(await validDirectory(homeDirectory)))throw new Error('Home directory unavailable');}catch{throw new AorkError('AGENT_STATE_DIRECTORY_INVALID','Agent state needs an owner-only, unredirected server directory',503);}}
      const controller=new AbortController(); let timer:ReturnType<typeof setTimeout>|undefined;
      try {const detection=detectionSchema.parse(await Promise.race([Promise.resolve().then(()=>provider.detect({signal:controller.signal})),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new AorkError('PROVIDER_UNAVAILABLE','Provider detection did not finish',409));},2000);})]));
        if(detection.status!=='available'||!semver.satisfies(detection.version,profile.versionRequirement))throw new AorkError('PROVIDER_UNAVAILABLE','Provider binary is unavailable or outside the saved version range',409);
        if(!(await validDirectory(profile.stateDirectory)))throw new AorkError('AGENT_STATE_DIRECTORY_INVALID','Native state directory changed during launch validation',409);
        const environmentNames=plan?[...new Set([...Object.keys(plan.fixed),...plan.stateDirectoryNames,...(plan.homeChildDirectory?['HOME']:[]),...(plan.credentialName?[plan.credentialName]:[])])].sort():undefined;
        const snapshot=frozen({profile,providerOwner:registry.owner(profile.providerId),launch:structuredClone(provider.launch),detectedVersion:detection.version,providerDefinitionVersion:provider.version,...(environmentNames?{environmentNames}:{})});launchBindings.set(snapshot,{provider,owner:providerOwners.get(profile.providerId)!,...(plan?{plan}:{}),profile});return snapshot;
      } catch(error) {if(error instanceof AorkError)throw error;throw new AorkError('PROVIDER_UNAVAILABLE','Provider launch validation failed',409);} finally {if(timer)clearTimeout(timer);controller.abort();}
    },
    validateLaunch(snapshot,tx) {const binding=launchBindings.get(snapshot);if(!binding)throw new AorkError('LAUNCH_SNAPSHOT_INVALID','Use an actual prepared launch snapshot',409);context.verifyOwner(binding.owner);const current=service.snapshot(snapshot.profile.id,tx);if(current.revision!==snapshot.profile.revision||current.providerDefinitionVersion!==snapshot.providerDefinitionVersion||providerOwners.get(current.providerId)!==binding.owner||registry.get(current.providerId)!==binding.provider)throw new AorkError('PROFILE_REVISION_CHANGED','The launch configuration changed before acceptance',409);},
    snapshot(id, transaction) {
    const profile = repository.profile(id, transaction); if (!profile) throw new AorkError('PROFILE_UNAVAILABLE', 'Agent Profile is unavailable', 404);
    const provider = registry.get(profile.providerId); if (!provider) throw new AorkError('PROVIDER_UNAVAILABLE', 'Agent Provider is not registered', 409);
    return frozen({ ...structuredClone(profile), providerDefinitionVersion: provider.version });
  } };
  context.provideScoped<AgentProviderRegistry>(AGENT_PROVIDER_REGISTRY,owner=>Object.freeze({...registry,register:(provider:AgentProvider)=>register(provider,owner)})); context.provide(CREDENTIAL_BROKER, broker); context.provide(AGENT_PROFILES_SERVICE, service);
  // One-use in-memory spawn authorizations, bound to the exact prepared snapshot
  // and the accepted Run identity. Grants, assembled values and decrypted secrets
  // never enter persisted launches, receipts, facts, events or diagnostics.
  context.provideScoped<LaunchEnvironmentService>(LAUNCH_ENVIRONMENT, consumer => {
    const grants = new Map<object, { run: Readonly<{runId:string;generation:number;hostEpoch:string}>; binding: {provider:AgentProvider;owner:import('@aork/sdk/server').OwnerDescriptor;plan?:ProviderLaunchEnvironmentPlan;profile:AgentProfile} }>();
    function authority() {
      context.verifyOwner(consumer);
      const selected = context.owner.serviceOwners['aork.runtime.acp@1'];
      if (consumer.hostEpoch !== context.owner.hostEpoch || consumer.pluginGraphHash !== context.owner.pluginGraphHash || selected?.pluginId !== consumer.pluginId || selected.version !== consumer.version) throw new AorkError('LAUNCH_ENVIRONMENT_OWNER_INVALID', 'Only the current selected Runtime may hold launch environment grants', 409);
    }
    return Object.freeze({
      bind(snapshot: AgentLaunchSnapshot, run: Readonly<{runId:string;generation:number;hostEpoch:string}>) {
        authority();
        const binding = launchBindings.get(snapshot);
        if (!binding || !providers.get(binding.profile.providerId) || providers.get(binding.profile.providerId) !== binding.provider) throw new AorkError('LAUNCH_SNAPSHOT_INVALID', 'Use an actual prepared launch snapshot', 409);
        if (run.hostEpoch !== context.owner.hostEpoch) throw new AorkError('LAUNCH_GRANT_STALE', 'The launch environment grant no longer matches this Host', 409);
        const names = binding.plan ? [...new Set([...Object.keys(binding.plan.fixed), ...binding.plan.stateDirectoryNames, ...(binding.plan.homeChildDirectory ? ['HOME'] : []), ...(binding.plan.credentialName ? [binding.plan.credentialName] : [])])].sort() : [];
        const grant = Object.freeze({ environmentNames: Object.freeze([...names]) });
        grants.set(grant, { run, binding });
        return grant;
      },
      consume(grant: LaunchEnvironmentGrant, apply: (environment: Readonly<Record<string,string>>) => void) {
        authority();
        const entry = grants.get(grant);
        grants.delete(grant);
        if (!entry) throw new AorkError('LAUNCH_ENVIRONMENT_GRANT_INVALID', 'The launch environment grant is unknown, already used or expired', 409);
        const { plan, profile } = entry.binding;
        const environment: Record<string,string> = {};
        if (plan) {
          for (const [name, value] of Object.entries(plan.fixed)) environment[name] = value;
          for (const name of plan.stateDirectoryNames) environment[name] = profile.stateDirectory;
          if (plan.homeChildDirectory) environment.HOME = join(profile.stateDirectory, plan.homeChildDirectory);
          if (plan.credentialName) {
            if (profile.authentication !== 'api-key' || !profile.credentialRef) throw new AorkError('LAUNCH_ENVIRONMENT_GRANT_INVALID', 'The grant no longer matches an API-key Profile', 409);
            environment[plan.credentialName] = broker.resolveApiKey(profile.credentialRef, profile.providerId);
          }
        }
        try { apply(Object.freeze({ ...environment })); } finally { for (const name of Object.keys(environment)) delete environment[name]; }
      },
    });
  });
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
  function credentialStatus(profile: Pick<AgentProfile, 'authentication' | 'credentialRef' | 'providerId'>, nativeLogin: 'observed' | 'absent' | 'unknown' = 'unknown'): AgentsOverview['profiles'][number]['credentialStatus'] {
    if (profile.authentication === 'none') return 'not-required';
    if (profile.authentication === 'native-oauth') return nativeLogin === 'observed' ? 'native-login-metadata' : 'native-directory-only';
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
      const provider = detected.find(candidate => candidate.id === profile.providerId);
      // Mere directory existence is never login proof; only Provider-owned,
      // metadata-only observation can mark local login metadata as observed.
      let nativeLogin: 'observed' | 'absent' | 'unknown' = 'unknown';
      const registered = registry.get(profile.providerId);
      if (registered?.observeNativeLogin && profile.authentication === 'native-oauth') {
        const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
        try { nativeLogin = await Promise.race([Promise.resolve().then(() => registered.observeNativeLogin!({ stateDirectory: profile.stateDirectory })), new Promise<'unknown'>(resolve => { timer = setTimeout(() => { controller.abort(); resolve('unknown'); }, 2000); })]); }
        catch { nativeLogin = 'unknown'; }
        finally { if (timer) clearTimeout(timer); controller.abort(); }
      }
      const credential = credentialStatus(profile, nativeLogin);
      let reason: AgentsOverview['profiles'][number]['reason'] = !provider ? 'provider-missing' : provider.detection.status === 'unavailable' ? provider.detection.reason : !semver.satisfies(provider.detection.version, profile.versionRequirement) ? 'unsupported-version' : !['ready', 'not-required', 'native-directory-only', 'native-login-metadata'].includes(credential) ? 'credential-unavailable' : null;
      if (!reason && profile.authentication === 'native-oauth' && nativeLogin !== 'observed') reason = 'native-authentication-required';
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

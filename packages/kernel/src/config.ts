import { Ajv } from 'ajv';
import { AorkError } from '@aork/sdk';
import type { PluginManifest } from '@aork/sdk';

/** Configuration preflight is synchronous; never invoke an async validator and abandon its Promise. */
export function compileConfig(manifest: PluginManifest) {
  if (manifest.configSchema === undefined) return undefined;
  try {
    const validate = new Ajv({ strict: true, allErrors: true }).compile(manifest.configSchema);
    if ('$async' in validate && Boolean(validate.$async)) throw new Error('Asynchronous configuration validation is unsupported');
    return validate;
  } catch {
    throw new AorkError('CONFIG_SCHEMA_INVALID', `${manifest.id}@${manifest.version}: invalid or asynchronous draft-07 configuration schema. Correct configSchema to use synchronous validation before installing.`);
  }
}

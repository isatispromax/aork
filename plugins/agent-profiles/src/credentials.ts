import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { AorkError } from '@aork/sdk';
/** The independent key is never persisted in scoped state, domain rows, receipts or events. */
export async function loadMasterKey(file: unknown): Promise<Buffer | undefined> {
  if (typeof file !== 'string' || !isAbsolute(file)) return undefined;
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const facts = await handle.stat();
      if (!facts.isFile() || facts.size !== 32 || (facts.mode & 0o077) !== 0 || (process.getuid && facts.uid !== process.getuid())) return undefined;
      const key = await handle.readFile();
      return key.length === 32 ? key : undefined;
    } finally { await handle.close(); }
  } catch { return undefined; }
}
const unavailable = () => new AorkError('CREDENTIAL_KEY_UNAVAILABLE', 'Manual credential storage needs a separately configured, owner-only 32-byte master key file', 503);
export function credentialCipher(key: Buffer | undefined) {
  return {
    available: Boolean(key),
    encrypt(secret: string, reference: string, providerId: string): string {
      if (!key) throw unavailable();
      const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(JSON.stringify({ version: 1, reference, providerId })));
      const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      return JSON.stringify({ version: 1, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
    },
    decrypt(encrypted: string, reference: string, providerId: string): string {
      if (!key) throw unavailable();
      try {
        const value = JSON.parse(encrypted) as { version: number; nonce: string; tag: string; ciphertext: string };
        if (value.version !== 1) throw new Error('Unsupported envelope');
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.nonce, 'base64'));
        decipher.setAAD(Buffer.from(JSON.stringify({ version: 1, reference, providerId })));
        decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8');
      } catch { throw new AorkError('CREDENTIAL_UNREADABLE', 'The credential cannot be decrypted with the configured master key', 503); }
    },
  };
}

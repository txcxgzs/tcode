import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";

export type CredentialDescriptor = { id: string; configured: boolean; source: 'runtime'; writable: true };

const VALID_KEY = /^[\x21-\x7E]+$/;
const ENVELOPE_VERSION = "v1";

export function validateApiKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('API key cannot be empty');
  if (value !== value.trim()) throw new Error('API key cannot start or end with whitespace');
  if (!VALID_KEY.test(value)) throw new Error('API key must contain printable non-space ASCII characters only');
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) throw new Error('Paste the key value only, without NAME=');
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) throw new Error('Paste the key without surrounding quotes');
  return value;
}

export class CredentialVault {
  private values = new Map<string, string>();

  constructor(private persist?: {
    load(): { key: string; envelope: string } | undefined;
    save(key: string, envelope: string): void;
    clear(): void;
  }) {
    if (persist) this.loadPersisted();
  }

  describe(id: string): CredentialDescriptor { return { id, configured: this.values.has(id), source: 'runtime', writable: true }; }
  list(): CredentialDescriptor[] { return [...this.values.keys()].map((id) => this.describe(id)); }
  set(id: string, value: unknown) {
    this.values.set(id, validateApiKey(value));
    this.persistAll();
    return this.describe(id);
  }
  get(id: string) { return this.values.get(id); }
  clear(id: string) {
    this.values.delete(id);
    this.persistAll();
    return this.describe(id);
  }

  private loadPersisted() {
    const envelope = this.persist!.load();
    if (!envelope?.envelope || !this.persistKeyFits(envelope.envelope) || !/^[0-9a-f-]{36}$/i.test(envelope.key ?? "")) return;
    try {
      const [version, salt, iv, authTag, payload] = envelope.envelope.split(":");
      if (version !== ENVELOPE_VERSION) return;
      const encryptionKey = scryptSync(Buffer.from(envelope.key.replace(/-/g, ""), "hex"), "tcode-credential-vault", 32);
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(iv, "base64url"), { authTagLength: 16 });
      decipher.setAuthTag(Buffer.from(authTag, "base64url"));
      decipher.setAAD(Buffer.from(salt, "base64url"));
      const decrypted = Buffer.concat([decipher.update(Buffer.from(payload, "base64url")), decipher.final()]).toString("utf8");
      for (const [id, value] of Object.entries(JSON.parse(decrypted))) this.values.set(id, validateApiKey(value));
    } catch {}
  }

  private persistKeyFits(envelope: string) {
    return envelope.split(":").length === 5;
  }

  private persistAll() {
    if (!this.persist) return;
    if (!this.values.size) {
      this.persist.clear();
      return;
    }
    const key = randomUUID();
    const salt = randomBytes(16);
    const derived = scryptSync(Buffer.from(key.replace(/-/g, ""), "hex"), "tcode-credential-vault", 32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", derived, iv);
    cipher.setAAD(salt);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(Object.fromEntries(this.values)), "utf8"), cipher.final()]);
    this.persist.save(key, [
      ENVELOPE_VERSION,
      salt.toString("base64url"),
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      encrypted.toString("base64url"),
    ].join(":"));
  }
}

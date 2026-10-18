// Web Crypto delegates AES-GCM, HKDF and HMAC to the platform cryptographic provider.
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const failure = () => new Error("私人记录校验失败，请检查恢复码或客户端版本。");
export type PrivateEnvelope = { version: 4; algorithm: "AES-256-GCM"; keyId: string; nonce: string; ciphertext: string };
export const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(bytes as ArrayBuffer), b => b.toString(16).padStart(2, "0")).join("");
function bytes(value: string) {
  if (!/^(?:[a-f0-9]{2})+$/.test(value)) throw failure();
  return new Uint8Array(value.match(/../g)!.map(v => parseInt(v, 16)));
}
export function createRecoveryCode() { return `PW4-${hex(crypto.getRandomValues(new Uint8Array(32)))}`; }
export class PrivateCrypto {
  private constructor(readonly keyId: string, private aes: CryptoKey, private hmac: CryptoKey) {}
  static async fromRecoveryCode(code: string) {
    try {
      if (!/^PW4-[a-f0-9]{64}$/.test(code.trim())) throw failure();
      const master = bytes(code.trim().slice(4));
      const source = await crypto.subtle.importKey("raw", master, "HKDF", false, ["deriveKey"]);
      const derive = (info: string, algorithm: AesKeyGenParams | HmacImportParams, uses: KeyUsage[]) => crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: encoder.encode("personal-workbench/private/v4"), info: encoder.encode(info) }, source, algorithm, false, uses);
      const aes = await derive("encryption", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]);
      const hmac = await derive("identifiers", { name: "HMAC", hash: "SHA-256" }, ["sign"]);
      master.fill(0);
      const keyId = hex(await crypto.subtle.sign("HMAC", hmac, encoder.encode("key-fingerprint")));
      return new PrivateCrypto(keyId, aes, hmac);
    } catch { throw failure(); }
  }
  async remoteId(kind: string, key: string[]) {
    return hex(await crypto.subtle.sign("HMAC", this.hmac, encoder.encode(JSON.stringify([kind, key]))));
  }
  private aad(id: string) { return encoder.encode(JSON.stringify([4, "AES-256-GCM", this.keyId, id])); }
  async encrypt(id: string, data: unknown): Promise<PrivateEnvelope> {
    try {
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: this.aad(id), tagLength: 128 }, this.aes, encoder.encode(JSON.stringify(data)));
      return { version: 4, algorithm: "AES-256-GCM", keyId: this.keyId, nonce: hex(nonce), ciphertext: hex(ciphertext) };
    } catch { throw failure(); }
  }
  async decrypt(id: string, envelope: PrivateEnvelope): Promise<unknown> {
    try {
      if (envelope.version !== 4 || envelope.algorithm !== "AES-256-GCM" || envelope.keyId !== this.keyId || !/^[a-f0-9]{24}$/.test(envelope.nonce) || envelope.ciphertext.length > 262144) throw failure();
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(envelope.nonce), additionalData: this.aad(id), tagLength: 128 }, this.aes, bytes(envelope.ciphertext));
      return JSON.parse(decoder.decode(plaintext));
    } catch { throw failure(); }
  }
}

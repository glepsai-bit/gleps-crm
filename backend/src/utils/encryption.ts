/**
 * AES-256-GCM encryption utility for sensitive fields at rest
 * ============================================================
 *
 * Formato do ciphertext: `v1:<iv-hex>:<authTag-hex>:<cipher-hex>`
 *  - prefixo `v1:` permite versionamento futuro (key rotation, algoritmos novos)
 *  - IV de 12 bytes (recomendado para GCM) gerado randomicamente em cada chamada
 *  - authTag de 16 bytes garante integridade (detecta tampering)
 *
 * Chave: lida de `ENCRYPTION_KEY` no env, esperado em formato hex (64 chars = 32 bytes)
 * ou base64 (44 chars). Em produção, validação dura via env schema.
 *
 * `decrypt()` é tolerante a payloads plaintext (sem prefixo `v1:`) para suportar
 * backfill incremental: leituras de registros ainda não criptografados retornam
 * o valor cru — útil enquanto o script de backfill ainda não rodou.
 */
import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits — recomendado para GCM
const AUTH_TAG_LENGTH = 16;
const VERSION_PREFIX = 'v1:';

let cachedKey: Buffer | null = null;

/**
 * Resolve a chave AES-256 a partir do env. Aceita hex (64 chars) ou base64.
 * Cacheada após primeira chamada. Em testes pode ser resetada via __resetKeyCache.
 */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = (process.env.ENCRYPTION_KEY || '').trim();
  if (!raw) {
    throw new Error(
      'ENCRYPTION_KEY ausente no env. Configure uma chave de 32 bytes (hex 64 chars ou base64).'
    );
  }

  // Tenta hex primeiro (formato preferido)
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    cachedKey = Buffer.from(raw, 'hex');
    return cachedKey;
  }

  // Fallback: base64
  try {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 32) {
      cachedKey = buf;
      return cachedKey;
    }
  } catch {
    // ignore
  }

  throw new Error(
    'ENCRYPTION_KEY com formato inválido. Esperado: hex 64 chars (preferido) ou base64 de 32 bytes.'
  );
}

/**
 * Criptografa um plaintext UTF-8 e retorna no formato `v1:iv:tag:cipher` (todos hex).
 */
export function encrypt(plaintext: string): string {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encrypt() espera string');
  }
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${VERSION_PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Descriptografa um payload no formato `v1:iv:tag:cipher`. Se o valor não
 * tiver o prefixo `v1:`, retorna como-está (suporta compat plaintext durante backfill).
 *
 * Lança erro se o ciphertext estiver corrompido ou se a chave for a errada
 * (authTag inválido).
 */
export function decrypt(value: string | null | undefined): string {
  if (value == null) return '';
  if (typeof value !== 'string') {
    throw new TypeError('decrypt() espera string');
  }
  if (!value.startsWith(VERSION_PREFIX)) {
    // Compat: ainda não migrado → retorna plaintext
    return value;
  }

  const parts = value.split(':');
  // 'v1:iv:tag:cipher' → 4 partes
  if (parts.length !== 4) {
    throw new Error('Formato de ciphertext inválido (esperado v1:iv:tag:cipher)');
  }
  const [, ivHex, tagHex, cipherHex] = parts;

  if (!/^[0-9a-f]+$/i.test(ivHex) || !/^[0-9a-f]+$/i.test(tagHex) || !/^[0-9a-f]*$/i.test(cipherHex)) {
    throw new Error('Componentes hex inválidos no ciphertext');
  }

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(cipherHex, 'hex');

  if (iv.length !== IV_LENGTH) throw new Error('IV com tamanho inválido');
  if (authTag.length !== AUTH_TAG_LENGTH) throw new Error('AuthTag com tamanho inválido');

  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Indica se um valor já está em formato encrypted (`v1:...`).
 */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(VERSION_PREFIX);
}

/**
 * Helper de tests/scripts: reseta cache da chave (para testar troca de ENCRYPTION_KEY).
 * NÃO usar em código de produção.
 */
export function __resetKeyCache(): void {
  cachedKey = null;
}

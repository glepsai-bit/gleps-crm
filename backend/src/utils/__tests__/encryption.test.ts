/**
 * Tests for utils/encryption (AES-256-GCM)
 * ========================================
 *
 * Cobertura:
 *  - Round-trip: encrypt(x) → decrypt(x) === x
 *  - Formato `v1:iv:tag:cipher` (4 partes, hex)
 *  - IV único por chamada (não-determinístico)
 *  - Chave errada → decrypt lança (authTag inválido)
 *  - Compat plaintext: decrypt de valor sem prefixo `v1:` retorna como-está
 *  - isEncrypted heuristica
 *  - null/undefined handling
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encrypt, decrypt, isEncrypted, __resetKeyCache } from '../encryption';

const TEST_KEY_A = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_KEY_B = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

describe('utils/encryption', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = TEST_KEY_A;
    __resetKeyCache();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
    __resetKeyCache();
  });

  describe('encrypt/decrypt round-trip', () => {
    it('descriptografa o mesmo valor que foi criptografado (ASCII)', () => {
      const plain = 'ya29.a0AfH6SMBxYzExampleAccessToken';
      const ct = encrypt(plain);
      expect(decrypt(ct)).toBe(plain);
    });

    it('preserva UTF-8 (acentos/emojis)', () => {
      const plain = 'refresh-token-com-acentos-ç-ã-é-🔐';
      const ct = encrypt(plain);
      expect(decrypt(ct)).toBe(plain);
    });

    it('lida com string vazia', () => {
      const ct = encrypt('');
      expect(decrypt(ct)).toBe('');
    });

    it('lida com payload grande', () => {
      const plain = 'x'.repeat(10_000);
      const ct = encrypt(plain);
      expect(decrypt(ct)).toBe(plain);
    });
  });

  describe('formato v1:iv:tag:cipher', () => {
    it('gera payload com prefixo v1: e 4 partes separadas por :', () => {
      const ct = encrypt('hello');
      expect(ct.startsWith('v1:')).toBe(true);
      const parts = ct.split(':');
      expect(parts).toHaveLength(4);
      expect(parts[0]).toBe('v1');
      // IV de 12 bytes → 24 hex chars
      expect(parts[1]).toMatch(/^[0-9a-f]{24}$/);
      // AuthTag de 16 bytes → 32 hex chars
      expect(parts[2]).toMatch(/^[0-9a-f]{32}$/);
      // Cipher hex (qualquer tamanho par, >= 0)
      expect(parts[3]).toMatch(/^[0-9a-f]*$/);
    });

    it('IV é único entre chamadas (não-determinístico)', () => {
      const ctA = encrypt('mesmo-plaintext');
      const ctB = encrypt('mesmo-plaintext');
      expect(ctA).not.toBe(ctB);
      const ivA = ctA.split(':')[1];
      const ivB = ctB.split(':')[1];
      expect(ivA).not.toBe(ivB);
      // ambos descriptografam pro mesmo plaintext
      expect(decrypt(ctA)).toBe('mesmo-plaintext');
      expect(decrypt(ctB)).toBe('mesmo-plaintext');
    });
  });

  describe('chave errada / tampering', () => {
    it('decrypt com chave diferente lança (authTag inválido)', () => {
      const ct = encrypt('segredo-importante');

      // Troca a chave e reseta cache
      process.env.ENCRYPTION_KEY = TEST_KEY_B;
      __resetKeyCache();

      expect(() => decrypt(ct)).toThrow();
    });

    it('decrypt com cipher adulterado lança', () => {
      const ct = encrypt('payload');
      const parts = ct.split(':');
      // Inverte ultimo char do cipher
      const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${parts[3].replace(/.$/, (c) =>
        c === '0' ? '1' : '0'
      )}`;
      expect(() => decrypt(tampered)).toThrow();
    });

    it('decrypt com formato malformado lança', () => {
      expect(() => decrypt('v1:somente-uma-parte')).toThrow(/Formato/);
      expect(() => decrypt('v1:zz:zz:zz')).toThrow(/hex/i);
    });
  });

  describe('compat plaintext (backfill incremental)', () => {
    it('decrypt de valor sem prefixo v1: retorna como-está', () => {
      const plain = 'ya29.legacy-plaintext-access-token';
      expect(decrypt(plain)).toBe(plain);
    });

    it('decrypt(null) retorna string vazia', () => {
      expect(decrypt(null)).toBe('');
      expect(decrypt(undefined)).toBe('');
    });
  });

  describe('isEncrypted', () => {
    it('true para payloads v1:...', () => {
      expect(isEncrypted(encrypt('x'))).toBe(true);
    });

    it('false para plaintext, null ou undefined', () => {
      expect(isEncrypted('plain-text')).toBe(false);
      expect(isEncrypted('')).toBe(false);
      expect(isEncrypted(null)).toBe(false);
      expect(isEncrypted(undefined)).toBe(false);
    });
  });

  describe('chave inválida no env', () => {
    it('encrypt falha se ENCRYPTION_KEY ausente', () => {
      delete process.env.ENCRYPTION_KEY;
      __resetKeyCache();
      expect(() => encrypt('x')).toThrow(/ENCRYPTION_KEY/);
    });

    it('encrypt falha se ENCRYPTION_KEY tem formato inválido', () => {
      process.env.ENCRYPTION_KEY = 'chave-curta-invalida';
      __resetKeyCache();
      expect(() => encrypt('x')).toThrow(/inválido|invalid/i);
    });
  });
});

/**
 * Unit tests for api-key.service.ts
 * Run with: npm test (requires vitest in devDependencies)
 *
 * Uses vi.mock factory pattern compatible with vitest hoisting.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';

// ── Prisma Mock ──────────────────────────────────────────────────────────────
// NOTE: vi.mock factory is hoisted to top of file by vitest, so we cannot
// reference outer variables. We use vi.hoisted() to create the mock object.

const prismaMock = vi.hoisted(() => ({
  apiKey: {
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock('../../config/database', () => ({
  prisma: prismaMock,
}));

import { apiKeyService } from '../api-key.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ApiKeyService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── generate ─────────────────────────────────────────────────────────────

  describe('generate', () => {
    it('returns plaintext key in glk_ format (glk_ + 40 hex chars)', async () => {
      const fakeRecord = {
        id: 'uuid-1',
        name: 'Test Key',
        keyPrefix: 'glk_abcde12345',
        hashedKey: 'somehash',
        scopes: [],
        createdById: null,
        createdAt: new Date('2026-06-23T00:00:00Z'),
      };
      prismaMock.apiKey.create.mockResolvedValue(fakeRecord);

      const result = await apiKeyService.generate('acc-1', 'Test Key', undefined, []);

      // Format: glk_ + 40 hex chars = 44 chars total
      expect(result.plaintextKey).toMatch(/^glk_[0-9a-f]{40}$/);
      expect(result.name).toBe('Test Key');
      expect(result.id).toBe('uuid-1');
    });

    it('prefix is first 12 chars of plaintextKey', async () => {
      prismaMock.apiKey.create.mockImplementation(({ data }: any) => {
        return Promise.resolve({
          id: 'uuid-2',
          name: 'Key',
          keyPrefix: data.keyPrefix,
          hashedKey: data.hashedKey,
          scopes: data.scopes,
          createdById: data.createdById,
          createdAt: new Date(),
        });
      });

      const result = await apiKeyService.generate('acc-1', 'Key');
      expect(result.prefix).toBe(result.plaintextKey.substring(0, 12));

      const callArg = prismaMock.apiKey.create.mock.calls[0][0];
      expect(callArg.data.keyPrefix).toBe(result.plaintextKey.substring(0, 12));
    });

    it('stores SHA-256 hash, not plaintext', async () => {
      prismaMock.apiKey.create.mockImplementation(({ data }: any) => {
        return Promise.resolve({
          id: 'uuid-3',
          name: 'Key',
          keyPrefix: data.keyPrefix,
          hashedKey: data.hashedKey,
          scopes: [],
          createdById: null,
          createdAt: new Date(),
        });
      });

      const result = await apiKeyService.generate('acc-1', 'Key');
      const callArg = prismaMock.apiKey.create.mock.calls[0][0];
      const storedHash = callArg.data.hashedKey;

      const expectedHash = sha256(result.plaintextKey);
      expect(storedHash).toBe(expectedHash);
      // Ensure the plaintext is NOT stored
      expect(storedHash).not.toBe(result.plaintextKey);
    });

    it('passes accountId, name, scopes, createdById to prisma.create', async () => {
      prismaMock.apiKey.create.mockResolvedValue({
        id: 'uuid-4',
        name: 'Named Key',
        keyPrefix: 'glk_xxxxxx0000',
        hashedKey: 'hash',
        scopes: ['read'],
        createdById: 'user-1',
        createdAt: new Date(),
      });

      await apiKeyService.generate('acc-42', 'Named Key', 'user-1', ['read']);

      expect(prismaMock.apiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            accountId: 'acc-42',
            name: 'Named Key',
            scopes: ['read'],
            createdById: 'user-1',
          }),
        })
      );
    });
  });

  // ── list ──────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns mapped array without hashedKey', async () => {
      prismaMock.apiKey.findMany.mockResolvedValue([
        {
          id: 'k1',
          name: 'Integration Key',
          keyPrefix: 'glk_abc12345de',
          scopes: ['send'],
          lastUsedAt: null,
          revokedAt: null,
          createdAt: new Date('2026-01-01'),
        },
      ]);

      const result = await apiKeyService.list('acc-1');

      expect(result).toHaveLength(1);
      const key = result[0];
      expect(key.id).toBe('k1');
      expect(key.name).toBe('Integration Key');
      expect(key.prefix).toBe('glk_abc12345de');
      expect(key.scopes).toEqual(['send']);
      // hashedKey must NOT be present in the returned shape
      expect((key as any).hashedKey).toBeUndefined();
    });

    it('filters by accountId in prisma query', async () => {
      prismaMock.apiKey.findMany.mockResolvedValue([]);

      await apiKeyService.list('account-xyz');

      expect(prismaMock.apiKey.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { accountId: 'account-xyz' },
        })
      );
    });
  });

  // ── validate ──────────────────────────────────────────────────────────────

  describe('validate', () => {
    it('returns ValidatedApiKey for valid non-revoked key', async () => {
      const plaintextKey = 'glk_' + 'a'.repeat(40);
      const hash = sha256(plaintextKey);

      prismaMock.apiKey.findFirst.mockResolvedValue({
        id: 'k1',
        accountId: 'acc-1',
        scopes: ['read'],
      });
      prismaMock.apiKey.update.mockResolvedValue({});

      const result = await apiKeyService.validate(plaintextKey);

      expect(result).not.toBeNull();
      expect(result!.id).toBe('k1');
      expect(result!.accountId).toBe('acc-1');
      expect(result!.scopes).toEqual(['read']);

      // Must query by hashed key with revokedAt: null
      expect(prismaMock.apiKey.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            hashedKey: hash,
            revokedAt: null,
          },
        })
      );
    });

    it('returns null for a revoked key (revokedAt set → findFirst returns null)', async () => {
      // The where clause includes revokedAt: null, so a revoked key is not found
      prismaMock.apiKey.findFirst.mockResolvedValue(null);

      const result = await apiKeyService.validate('glk_' + 'b'.repeat(40));

      expect(result).toBeNull();
    });

    it('returns null for a non-existent key', async () => {
      prismaMock.apiKey.findFirst.mockResolvedValue(null);

      const result = await apiKeyService.validate('glk_nonexistent' + '0'.repeat(25));

      expect(result).toBeNull();
    });

    it('returns null for empty string input (no DB call)', async () => {
      const result = await apiKeyService.validate('');
      expect(result).toBeNull();
      expect(prismaMock.apiKey.findFirst).not.toHaveBeenCalled();
    });

    it('fires lastUsedAt update after successful validation (fire-and-forget)', async () => {
      const plaintextKey = 'glk_' + 'c'.repeat(40);

      prismaMock.apiKey.findFirst.mockResolvedValue({
        id: 'k-fire',
        accountId: 'acc-1',
        scopes: [],
      });
      prismaMock.apiKey.update.mockResolvedValue({});

      await apiKeyService.validate(plaintextKey);

      // Fire-and-forget: wait a tick for the microtask to settle
      await new Promise((r) => setTimeout(r, 20));

      expect(prismaMock.apiKey.update).toHaveBeenCalledWith({
        where: { id: 'k-fire' },
        data: { lastUsedAt: expect.any(Date) },
      });
    });
  });

  // ── revoke ────────────────────────────────────────────────────────────────

  describe('revoke', () => {
    it('sets revokedAt on the matching id+accountId pair', async () => {
      prismaMock.apiKey.updateMany.mockResolvedValue({ count: 1 });

      await apiKeyService.revoke('key-id-1', 'acc-1');

      expect(prismaMock.apiKey.updateMany).toHaveBeenCalledWith({
        where: { id: 'key-id-1', accountId: 'acc-1' },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('does not throw if id belongs to different accountId (updateMany count: 0)', async () => {
      // updateMany with wrong accountId returns count: 0 — no error thrown
      prismaMock.apiKey.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        apiKeyService.revoke('key-id-1', 'wrong-account')
      ).resolves.not.toThrow();
    });
  });
});

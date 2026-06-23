import * as crypto from 'crypto';
import { prisma } from '../config/database';

export interface GeneratedApiKey {
  id: string;
  name: string;
  plaintextKey: string;
  prefix: string;
  createdAt: Date;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface ValidatedApiKey {
  id: string;
  accountId: string;
  scopes: string[];
}

class ApiKeyService {
  /**
   * Generate a new API key for an account.
   * Returns the plaintext key ONLY ONCE — it is hashed before persistence.
   *
   * TODO(t022-future): scopes não implementado. O parâmetro `_scopes` é
   * intencionalmente ignorado e persistimos sempre [] no banco. Toda chave
   * gerada hoje tem god-mode no escopo da accountId. Ver comentário no
   * apiKey.middleware.ts para o plano de habilitar requireScope().
   */
  async generate(
    accountId: string,
    name: string,
    createdById?: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _scopes: string[] = []
  ): Promise<GeneratedApiKey> {
    // Plaintext key format: glk_<40 hex chars>
    const plaintextKey = 'glk_' + crypto.randomBytes(20).toString('hex');
    const prefix = plaintextKey.substring(0, 12);
    const hashedKey = crypto.createHash('sha256').update(plaintextKey).digest('hex');

    const record = await prisma.apiKey.create({
      data: {
        accountId,
        name,
        keyPrefix: prefix,
        hashedKey,
        // TODO(t022-future): scopes não implementado — sempre [] por hora.
        scopes: [],
        createdById,
      },
    });

    return {
      id: record.id,
      name: record.name,
      plaintextKey,
      prefix,
      createdAt: record.createdAt,
    };
  }

  /**
   * List API keys for an account (never returns hashedKey).
   */
  async list(accountId: string): Promise<ApiKeySummary[]> {
    const keys = await prisma.apiKey.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        lastUsedAt: true,
        revokedAt: true,
        createdAt: true,
      },
    });

    return keys.map(k => ({
      id: k.id,
      name: k.name,
      prefix: k.keyPrefix,
      scopes: k.scopes,
      lastUsedAt: k.lastUsedAt,
      revokedAt: k.revokedAt,
      createdAt: k.createdAt,
    }));
  }

  /**
   * Validate a plaintext API key.
   * Returns null if invalid or revoked.
   * Updates lastUsedAt best-effort (fire-and-forget).
   */
  async validate(plaintextKey: string): Promise<ValidatedApiKey | null> {
    if (!plaintextKey || typeof plaintextKey !== 'string') {
      return null;
    }

    const hashedKey = crypto.createHash('sha256').update(plaintextKey).digest('hex');

    const record = await prisma.apiKey.findFirst({
      where: {
        hashedKey,
        revokedAt: null,
      },
      select: {
        id: true,
        accountId: true,
        scopes: true,
      },
    });

    if (!record) {
      return null;
    }

    // Fire-and-forget update of lastUsedAt
    prisma.apiKey
      .update({
        where: { id: record.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => {
        // best-effort; ignore errors
      });

    return {
      id: record.id,
      accountId: record.accountId,
      scopes: record.scopes,
    };
  }

  /**
   * Revoke an API key (scoped by accountId for safety).
   */
  async revoke(id: string, accountId: string): Promise<void> {
    await prisma.apiKey.updateMany({
      where: { id, accountId },
      data: { revokedAt: new Date() },
    });
  }
}

export const apiKeyService = new ApiKeyService();

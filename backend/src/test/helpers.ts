/**
 * Helpers reutilizaveis pelos testes.
 * Cada teste deve usar essas factory functions para criar estado isolado.
 * Nunca compartilhe IDs entre testes (beforeEach do setup.ts limpa tudo).
 */

import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { prismaTest } from './setup';
import { authService } from '../services/auth.service';

export interface TestAccountResult {
  account: { id: string; nome: string };
  user: { id: string; email: string; nome: string; role: 'admin' };
  password: string;
  jwt: string;
  refreshToken: string;
}

/**
 * Cria uma account de teste com um admin user e devolve JWT pronto.
 * Sufixo random no email pra evitar UNIQUE conflict caso varios testes
 * rodem antes do beforeEach limpar.
 */
export async function createTestAccount(overrides?: {
  accountName?: string;
  userName?: string;
  userEmail?: string;
  password?: string;
}): Promise<TestAccountResult> {
  const password = overrides?.password ?? 'Test@1234';
  const email = overrides?.userEmail ?? `admin-${randomUUID().slice(0, 8)}@test.com`;
  const accountName = overrides?.accountName ?? 'Test Account';
  const userName = overrides?.userName ?? 'Test Admin';

  const account = await prismaTest.account.create({
    data: { nome: accountName },
  });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prismaTest.user.create({
    data: {
      accountId: account.id,
      nome: userName,
      email: email.toLowerCase(),
      passwordHash,
      role: 'admin',
      status: 'active',
      permissions: ['dashboard', 'leads', 'kanban', 'emails', 'whatsapp_templates'],
    },
  });

  const loginResult = await authService.login({ email, password });

  return {
    account: { id: account.id, nome: account.nome },
    user: { id: user.id, email: user.email, nome: user.nome, role: 'admin' },
    password,
    jwt: loginResult.token,
    refreshToken: loginResult.refreshToken,
  };
}

/**
 * Cria uma API key real (com hash) e devolve { id, plaintextKey, prefix }.
 * O plaintextKey eh o que vai no header x-api-key dos testes.
 */
export async function createTestApiKey(
  accountId: string,
  scopes: string[] = ['*'],
  options?: { name?: string; revoked?: boolean }
): Promise<{ id: string; plaintextKey: string; prefix: string }> {
  const plaintextKey = 'glk_' + crypto.randomBytes(20).toString('hex');
  const prefix = plaintextKey.substring(0, 12);
  const hashedKey = crypto.createHash('sha256').update(plaintextKey).digest('hex');

  const record = await prismaTest.apiKey.create({
    data: {
      accountId,
      name: options?.name ?? `test-key-${Date.now()}`,
      keyPrefix: prefix,
      hashedKey,
      scopes,
      revokedAt: options?.revoked ? new Date() : null,
    },
  });

  return { id: record.id, plaintextKey, prefix };
}

/**
 * Cria um funil default + N stages com slugs sequenciais.
 * Retorna funnel + array de tags stage criadas.
 */
export async function createTestFunnelWithStages(
  accountId: string,
  stageNames: string[] = ['Novo Lead', 'Em Contato', 'Negociacao', 'Fechado'],
  options?: { isDefault?: boolean }
) {
  const funnel = await prismaTest.funnel.create({
    data: {
      accountId,
      name: 'Funil Principal',
      slug: 'funil-principal',
      isDefault: options?.isDefault ?? true,
    },
  });

  const tags = [];
  for (let i = 0; i < stageNames.length; i++) {
    const name = stageNames[i];
    const tag = await prismaTest.tag.create({
      data: {
        accountId,
        funnelId: funnel.id,
        name,
        slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        type: 'stage',
        ordem: i,
      },
    });
    tags.push(tag);
  }

  return { funnel, tags };
}

/**
 * Cria um contato de teste. Aceita overrides pra cobrir cases especificos.
 */
export async function createTestContact(
  accountId: string,
  overrides?: {
    nome?: string;
    telefone?: string;
    email?: string;
  }
) {
  return prismaTest.contact.create({
    data: {
      accountId,
      nome: overrides?.nome ?? `Contato Teste ${Date.now()}`,
      telefone: overrides?.telefone,
      email: overrides?.email,
    },
  });
}

/**
 * Header Authorization: Bearer <JWT> pronto pra usar com supertest.
 */
export function authHeader(jwt: string) {
  return { Authorization: `Bearer ${jwt}` };
}

/**
 * Header x-api-key pronto pra usar com supertest.
 */
export function apiKeyHeader(plaintextKey: string) {
  return { 'x-api-key': plaintextKey };
}

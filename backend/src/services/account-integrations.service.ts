/**
 * T-025 — Self-service de chaves de IA por admin de conta.
 *
 * Permite que o admin da PROPRIA conta (req.user.accountId) leia/atualize
 * suas chaves OpenAI e Anthropic via /admin/integracoes, sem precisar de
 * super_admin.
 *
 * Padrao de seguranca obrigatorio:
 *   - GET retorna sentinel '***SET***' (string) quando ha valor, ou null.
 *     NUNCA retorna o valor real, mesmo pro proprio admin.
 *   - PATCH com '***SET***' eh IGNORADO (no-op pro campo) — protege contra
 *     overwrite acidental quando frontend reenvia o valor mascarado.
 *   - PATCH com '' (string vazia) ou null EXPLICITAMENTE LIMPA o campo.
 *   - Campo nao presente no body = nao tocado.
 *
 * Escopo: APENAS chaves de IA (openaiApiKey, anthropicApiKey). Sendgrid,
 * Google, Evolution ficam fora — sao gerenciados em outras telas/super admin.
 */

import { prisma } from '../config/database';
import { NotFoundError } from '../utils/errors';
import { eventService } from './event.service';
import { openaiProvider } from './ai/openai-provider';
import { anthropicProvider } from './ai/anthropic-provider';
import { invalidateAccountKeys } from './ai/client-factory';

export type IntegrationsKey = 'openaiApiKey' | 'anthropicApiKey';
export const INTEGRATION_KEYS: readonly IntegrationsKey[] = [
  'openaiApiKey',
  'anthropicApiKey',
] as const;

export const SENTINEL = '***SET***' as const;

export interface IntegrationsView {
  openaiApiKey: typeof SENTINEL | null;
  anthropicApiKey: typeof SENTINEL | null;
}

export interface UpdateIntegrationsInput {
  // undefined = nao tocar; null/'' = limpar; '***SET***' = ignorar; string = setar
  openaiApiKey?: string | null;
  anthropicApiKey?: string | null;
}

type Provider = 'openai' | 'anthropic';

class AccountIntegrationsService {
  /**
   * Le as chaves da conta e retorna sentinel/null (NUNCA valor real).
   */
  async getForAccount(accountId: string): Promise<IntegrationsView> {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { openaiApiKey: true, anthropicApiKey: true },
    });
    if (!account) {
      throw new NotFoundError('Conta');
    }
    return {
      openaiApiKey: account.openaiApiKey ? SENTINEL : null,
      anthropicApiKey: account.anthropicApiKey ? SENTINEL : null,
    };
  }

  /**
   * Aplica patch com regras de sentinel/clear.
   * Retorna a view mascarada pos-update.
   */
  async update(
    accountId: string,
    input: UpdateIntegrationsInput,
    actorId?: string
  ): Promise<IntegrationsView> {
    // Confirma que a conta existe antes de tentar update
    const existing = await prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, openaiApiKey: true, anthropicApiKey: true },
    });
    if (!existing) {
      throw new NotFoundError('Conta');
    }

    const data: Record<string, string | null> = {};
    const changedFields: string[] = [];

    for (const key of INTEGRATION_KEYS) {
      const value = input[key];
      if (value === undefined) continue; // nao tocar
      if (value === SENTINEL) continue; // sentinel = preservar valor existente
      if (value === null || value === '') {
        data[key] = null;
        if (existing[key] !== null) changedFields.push(`${key}:cleared`);
      } else if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed === '' ) {
          data[key] = null;
          if (existing[key] !== null) changedFields.push(`${key}:cleared`);
        } else {
          data[key] = trimmed;
          changedFields.push(`${key}:set`);
        }
      }
    }

    if (Object.keys(data).length > 0) {
      await prisma.account.update({ where: { id: accountId }, data });

      // T-027: o atendimento IA cacheia a chave da conta por 1min pra não fazer
      // um SELECT por mensagem. Sem derrubar esse cache aqui, quem acabou de
      // cadastrar a chave continua tomando "chave ausente" por até um minuto —
      // e o worker de indexação, que roda a cada 30s, marca o documento como
      // 'failed' nesse intervalo.
      invalidateAccountKeys(accountId);

      // Auditoria: registra que houve update mas NUNCA loga o valor.
      await eventService.create({
        eventType: 'account.integrations_updated',
        accountId,
        actorType: actorId ? 'user' : 'system',
        actorId,
        entityType: 'account',
        entityId: accountId,
        payload: { changedFields },
      });
    }

    return this.getForAccount(accountId);
  }

  /**
   * Testa uma chave JA SALVA no banco (le do DB e chama o provider).
   * Se o campo estiver vazio, retorna ok:false com mensagem clara.
   */
  async test(
    accountId: string,
    provider: Provider
  ): Promise<{ ok: boolean; message: string }> {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { openaiApiKey: true, anthropicApiKey: true },
    });
    if (!account) {
      throw new NotFoundError('Conta');
    }

    const key = provider === 'openai' ? account.openaiApiKey : account.anthropicApiKey;
    if (!key) {
      return { ok: false, message: 'Chave nao configurada' };
    }

    if (provider === 'openai') {
      return openaiProvider.testConnection(key);
    }
    return anthropicProvider.testConnection(key);
  }
}

export const accountIntegrationsService = new AccountIntegrationsService();

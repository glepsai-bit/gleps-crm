/**
 * T-027 Fase 1 — resolução de cliente de IA POR CONTA.
 *
 * Os providers do warmup (openai-provider.ts / anthropic-provider.ts) são
 * singletons que leem a chave do ENV no construtor. Isso serve pro warmup, que
 * é uma feature da plataforma, mas NÃO serve pro atendimento: cada tenant paga
 * o próprio consumo com a própria chave (`Account.openaiApiKey`), e trocar a
 * chave na tela /admin/integracoes tem que valer na mensagem seguinte — sem
 * restart do processo.
 *
 * Ordem de resolução: chave da CONTA → chave do ENV (fallback da plataforma).
 * O fallback existe pra não quebrar quem ainda não configurou a própria chave;
 * quando nenhuma das duas existe, falha alto (AiKeyMissingError) em vez de
 * silenciar — diferente do warmup, aqui não há template pra cair.
 *
 * Cache: a chave é lida do banco no máximo 1x por minuto por conta. Sem isso
 * seria um SELECT por mensagem recebida. `invalidate()` derruba o cache na
 * hora em que a chave muda.
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../../config/database';
import { env } from '../../config/env';
import { AppError } from '../../utils/errors';

export type AiProviderName = 'openai' | 'anthropic';

/** 503: falta de configuração, não erro do usuário nem bug. */
export class AiKeyMissingError extends AppError {
  constructor(provider: AiProviderName) {
    super(
      `Nenhuma chave ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} configurada. ` +
        `Cadastre em Administração → Integrações.`,
      503
    );
  }
}

const CACHE_TTL_MS = 60_000;

interface CachedKeys {
  openai: string | null;
  anthropic: string | null;
  expiresAt: number;
}

const cache = new Map<string, CachedKeys>();

/**
 * Derruba o cache de uma conta. Chamado quando o admin salva a chave —
 * sem isso a chave nova só valeria depois do TTL.
 */
export function invalidateAccountKeys(accountId: string): void {
  cache.delete(accountId);
}

/** Só pra teste — o cache é global e vazaria entre casos. */
export function __clearKeyCache(): void {
  cache.clear();
}

async function loadKeys(accountId: string): Promise<CachedKeys> {
  const now = Date.now();
  const hit = cache.get(accountId);
  if (hit && hit.expiresAt > now) return hit;

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { openaiApiKey: true, anthropicApiKey: true },
  });

  const entry: CachedKeys = {
    // trim + vazio→null: a tela grava '' pra limpar, e '' não é chave válida.
    openai: account?.openaiApiKey?.trim() || null,
    anthropic: account?.anthropicApiKey?.trim() || null,
    expiresAt: now + CACHE_TTL_MS,
  };
  cache.set(accountId, entry);
  return entry;
}

/**
 * Chave efetiva da conta pro provider: a da conta, senão a do env.
 * Exportada porque o /playground precisa saber a ORIGEM da chave pra avisar
 * o admin que está gastando a cota da plataforma.
 */
export async function resolveKey(
  accountId: string,
  provider: AiProviderName
): Promise<{ key: string; source: 'account' | 'env' }> {
  const keys = await loadKeys(accountId);
  const accountKey = provider === 'openai' ? keys.openai : keys.anthropic;
  if (accountKey) return { key: accountKey, source: 'account' };

  const envKey = (provider === 'openai' ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY)?.trim();
  if (envKey) return { key: envKey, source: 'env' };

  throw new AiKeyMissingError(provider);
}

/**
 * Clientes SDK são baratos de construir (não abrem conexão no constructor),
 * então não cacheamos o cliente — só a chave. Isso evita o bug clássico de
 * cachear um cliente com chave revogada.
 */
export async function getOpenAI(accountId: string, timeoutMs: number): Promise<OpenAI> {
  const { key } = await resolveKey(accountId, 'openai');
  return new OpenAI({ apiKey: key, timeout: timeoutMs, maxRetries: 1 });
}

export async function getAnthropic(accountId: string, timeoutMs: number): Promise<Anthropic> {
  const { key } = await resolveKey(accountId, 'anthropic');
  return new Anthropic({ apiKey: key, timeout: timeoutMs, maxRetries: 1 });
}

/** A conta consegue usar esse provider (por chave própria ou do env)? */
export async function hasProvider(
  accountId: string,
  provider: AiProviderName
): Promise<boolean> {
  try {
    await resolveKey(accountId, provider);
    return true;
  } catch {
    return false;
  }
}

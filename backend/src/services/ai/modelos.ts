/**
 * ETAPA G — o modelo existe, e a chave da conta alcança ele?
 *
 * O piloto gravou "gpt-5" num agente cuja chave não tinha acesso e só
 * descobriu na primeira mensagem do lead, com um 404 do provider no meio do
 * atendimento. A verificação passa a acontecer ANTES de gravar — no PATCH do
 * agente e no provisionamento — com a lista real de modelos da chave.
 *
 * OpenAI: `GET /v1/models` com a chave efetiva da conta, em cache por 10 min
 * por conta+provider (uma listagem por PATCH seria barata; por mensagem, não
 * — e a mesma lista serve pro provisionamento que vem logo em seguida).
 * Anthropic: tabela fixa de prefixos — a listagem deles é por família, e o
 * que importa aqui é recusar "claude-6" digitado errado.
 *
 * Falha de REDE não bloqueia: sem conseguir conferir, o modelo passa com
 * `verificado: false` e um aviso. 401 = chave INVÁLIDA e bloqueia (com a
 * mensagem de chave, não a de modelo inexistente — o operador precisa trocar
 * a chave, não o modelo). 403 = chave restrita sem permissão de LISTAR
 * modelos: ela pode chamar o modelo mesmo assim, então não bloqueia
 * (`verificado: false` + aviso).
 *
 * O cache é por conta + provider + CHAVE (hash curto da chave efetiva): trocar
 * a chave — por Integrações ou PUT /accounts — muda a entrada sozinha, sem
 * depender de alguém lembrar de invalidar.
 */

import { createHash } from 'crypto';
import { getOpenAI, resolveKey, AiKeyMissingError, type AiProviderName } from './client-factory';
import { ValidationError } from '../../utils/errors';
import { logger } from '../../utils/logger';

export interface ModeloValido {
  ok: true;
  model: string;
  /** false = não deu pra conferir (sem chave ou provider fora); passou por tolerância. */
  verificado: boolean;
  aviso?: string;
}

export interface ModeloInvalido {
  ok: false;
  motivo: string;
  codigo: 'MODELO_INEXISTENTE' | 'CHAVE_SEM_ACESSO';
}

export type ResultadoDaValidacao = ModeloValido | ModeloInvalido;

const CACHE_TTL_MS = 10 * 60_000;
const TIMEOUT_LISTAGEM_MS = 15_000;

/**
 * Famílias Anthropic aceitas, por prefixo: casa 'claude-opus-4-1-20250805'
 * com 'claude-opus-4' e 'claude-haiku-4-5' com 'claude-haiku-4'.
 */
const ANTHROPIC_PREFIXOS = [
  'claude-3-5-haiku',
  'claude-3-5-sonnet',
  'claude-3-7-sonnet',
  'claude-opus-4',
  'claude-sonnet-4',
  'claude-haiku-4',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-5',
  'claude-fable-5',
  'claude-mythos-5',
];

interface EntradaDoCache {
  modelos: Set<string>;
  expiresAt: number;
}

const cache = new Map<string, EntradaDoCache>();

/** Hash curto da chave efetiva: separa o cache por chave sem guardar a chave. */
const impressaoDaChave = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 16);

const chaveDoCache = (accountId: string, provider: AiProviderName, key: string) =>
  `${accountId}:${provider}:${impressaoDaChave(key)}`;

/** Chave da conta mudou: a lista de modelos que ela alcança também pode ter mudado. */
export function invalidarCacheDeModelos(accountId: string): void {
  for (const k of Array.from(cache.keys())) {
    if (k.startsWith(`${accountId}:`)) cache.delete(k);
  }
}

/** Só pra teste — o cache é global e vazaria entre casos. */
export function __limparCacheDeModelos(): void {
  cache.clear();
}

export function mensagemDeModeloInvalido(model: string): string {
  return `Modelo "${model}" não existe ou a chave não tem acesso. Confira o nome do modelo e a chave de IA da conta.`;
}

/** 401 na listagem: o problema é a chave, e trocar o modelo não resolve. */
export function mensagemDeChaveInvalida(provider: AiProviderName): string {
  const nome = provider === 'openai' ? 'OpenAI' : 'Anthropic';
  return `A chave ${nome} da conta é inválida (recusada pelo provedor). Confira a chave em Integrações e tente de novo.`;
}

export async function validarModelo(p: {
  accountId: string;
  provider: AiProviderName;
  model: string | null | undefined;
}): Promise<ResultadoDaValidacao> {
  const model = (p.model ?? '').trim();
  // Vazio = padrão do provider (ver DEFAULT_MODEL em chat.ts): sempre existe.
  if (!model) return { ok: true, model, verificado: true };

  if (p.provider === 'anthropic') {
    const m = model.toLowerCase();
    const casa = ANTHROPIC_PREFIXOS.some((pre) => m === pre || m.startsWith(`${pre}-`));
    return casa
      ? { ok: true, model, verificado: true }
      : { ok: false, codigo: 'MODELO_INEXISTENTE', motivo: mensagemDeModeloInvalido(model) };
  }

  if (p.provider !== 'openai') {
    return { ok: false, codigo: 'MODELO_INEXISTENTE', motivo: `Provider de IA desconhecido: ${p.provider}` };
  }

  // Sem chave não há o que conferir — quem grava a chave depois descobre no
  // provisionamento, que exige chave antes de tudo.
  let key: string;
  try {
    key = (await resolveKey(p.accountId, 'openai')).key;
  } catch (err) {
    if (err instanceof AiKeyMissingError) {
      return { ok: true, model, verificado: false, aviso: 'Sem chave OpenAI na conta: o modelo não foi conferido.' };
    }
    throw err;
  }

  let modelos: Set<string>;
  try {
    modelos = await listarModelosOpenAI(p.accountId, key);
  } catch (err) {
    const status = (err as { status?: number })?.status;
    // 401: a chave é inválida — bloqueia, dizendo isso (e não "modelo não existe").
    if (status === 401) {
      return { ok: false, codigo: 'CHAVE_SEM_ACESSO', motivo: mensagemDeChaveInvalida('openai') };
    }
    // 403: chave restrita que não pode LISTAR modelos. Isso não prova que ela não
    // alcança o modelo — passa sem conferir, avisando.
    if (status === 403) {
      return {
        ok: true,
        model,
        verificado: false,
        aviso: 'A chave não tem permissão para listar os modelos: o modelo não foi conferido.',
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('[ai/modelos] não foi possível listar os modelos; aceitando sem conferir', {
      accountId: p.accountId,
      error: msg.slice(0, 200),
    });
    return { ok: true, model, verificado: false, aviso: `Não foi possível conferir o modelo agora (${msg.slice(0, 120)}).` };
  }

  return modelos.has(model)
    ? { ok: true, model, verificado: true }
    : { ok: false, codigo: 'MODELO_INEXISTENTE', motivo: mensagemDeModeloInvalido(model) };
}

/** Como `validarModelo`, mas lança 400 — pro controller/provisionamento não repetir o if. */
export async function exigirModeloValido(p: {
  accountId: string;
  provider: AiProviderName;
  model: string | null | undefined;
}): Promise<ModeloValido> {
  const r = await validarModelo(p);
  if (!r.ok) throw new ValidationError(r.motivo);
  return r;
}

async function listarModelosOpenAI(accountId: string, key: string): Promise<Set<string>> {
  const k = chaveDoCache(accountId, 'openai', key);
  const hit = cache.get(k);
  const agora = Date.now();
  if (hit && hit.expiresAt > agora) return hit.modelos;

  const client = await getOpenAI(accountId, TIMEOUT_LISTAGEM_MS);
  const modelos = new Set<string>();
  const pagina = await client.models.list();
  for await (const m of pagina) modelos.add(m.id);

  cache.set(k, { modelos, expiresAt: agora + CACHE_TTL_MS });
  return modelos;
}

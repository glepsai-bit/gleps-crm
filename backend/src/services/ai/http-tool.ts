/**
 * T-036 — ferramentas HTTP próprias do agente.
 *
 * A lacuna real contra o n8n: lá o agente chama qualquer uma das 400+
 * integrações como ferramenta; aqui ele tinha três e não conseguia consultar a
 * API do cliente no meio do raciocínio. O fluxo podia chamar uma API — o
 * agente não podia DECIDIR chamá-la.
 *
 * A resposta não é copiar 400 nós. É uma ferramenta configurável: quem tem API
 * tem integração, e o admin descreve a dele uma vez.
 */

import { safeFetch } from '../../utils/ssrf-guard';
import { logger } from '../../utils/logger';
import type { ChatToolDef } from './chat';

/** Teto do corpo devolvido ao modelo. Acima disso ele se perde e o custo dispara. */
const MAX_RESPOSTA_CHARS = 4000;
const TIMEOUT_MS = 12_000;

export interface HttpToolParam {
  nome: string;
  descricao: string;
  /** `texto` livre, ou uma lista fechada de valores aceitos. */
  tipo?: 'texto' | 'numero' | 'opcoes';
  opcoes?: string[];
  obrigatorio?: boolean;
}

export interface HttpToolConfig {
  nome: string;
  /**
   * O campo que decide tudo: é o que o modelo lê para saber SE chama.
   * Descrição vaga vira ferramenta nunca usada, ou usada na hora errada.
   */
  quandoUsar: string;
  metodo?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Pode conter `{{parametro}}`, preenchido pelo modelo. */
  url: string;
  /** Corpo para POST/PUT/PATCH, também com `{{parametro}}`. */
  corpo?: string;
  cabecalhos?: Record<string, string>;
  parametros?: HttpToolParam[];
}

const NOME_VALIDO = /^[a-z][a-z0-9_]{1,48}$/;

/** Só o que tem nome e endereço utilizáveis vira ferramenta. */
export function lerHttpTools(bruto: unknown): HttpToolConfig[] {
  if (!Array.isArray(bruto)) return [];
  return bruto.filter((t): t is HttpToolConfig => {
    const o = t as Partial<HttpToolConfig> | null;
    return Boolean(
      o &&
        typeof o.nome === 'string' &&
        NOME_VALIDO.test(o.nome) &&
        typeof o.url === 'string' &&
        o.url.trim().length > 0 &&
        typeof o.quandoUsar === 'string' &&
        o.quandoUsar.trim().length > 0
    );
  });
}

/** A ferramenta como o modelo a enxerga. */
export function definicaoDaHttpTool(t: HttpToolConfig): ChatToolDef {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const p of t.parametros ?? []) {
    if (!p?.nome) continue;
    properties[p.nome] =
      p.tipo === 'numero'
        ? { type: 'number', description: p.descricao ?? '' }
        : p.tipo === 'opcoes' && Array.isArray(p.opcoes) && p.opcoes.length > 0
          ? { type: 'string', enum: p.opcoes, description: p.descricao ?? '' }
          : { type: 'string', description: p.descricao ?? '' };
    if (p.obrigatorio !== false) required.push(p.nome);
  }

  return {
    name: t.nome,
    description: t.quandoUsar,
    parameters: { type: 'object', properties, required },
  };
}

/** Substitui `{{param}}` pelos valores que o modelo preencheu. */
function preencher(molde: string, args: Record<string, unknown>, paraUrl: boolean): string {
  return molde.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, chave: string) => {
    const v = args[chave];
    if (v === undefined || v === null) return '';
    const texto = String(v);
    // Em URL o valor tem que ser escapado: um parâmetro com `&` ou espaço,
    // vindo de texto que o modelo escreveu, quebraria a query silenciosamente.
    return paraUrl ? encodeURIComponent(texto) : texto;
  });
}

/**
 * Executa e devolve ao modelo o que ele precisa ler.
 *
 * Erro nunca sobe como exceção: o agente precisa poder dizer ao lead que não
 * conseguiu consultar, em vez de o atendimento inteiro falhar porque a API do
 * cliente caiu.
 */
export async function executarHttpTool(
  t: HttpToolConfig,
  args: Record<string, unknown>
): Promise<string> {
  const faltando = (t.parametros ?? [])
    .filter((p) => p.obrigatorio !== false)
    .filter((p) => args[p.nome] === undefined || args[p.nome] === '')
    .map((p) => p.nome);
  if (faltando.length > 0) return `Faltou informar: ${faltando.join(', ')}.`;

  const url = preencher(t.url, args, true);
  const metodo = t.metodo ?? 'GET';
  const temCorpo = metodo !== 'GET' && metodo !== 'DELETE';

  try {
    const resposta = await safeFetch(url, {
      method: metodo,
      headers: {
        ...(temCorpo ? { 'Content-Type': 'application/json' } : {}),
        ...(t.cabecalhos ?? {}),
      },
      ...(temCorpo && t.corpo ? { body: preencher(t.corpo, args, false) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const texto = (await resposta.text()).slice(0, MAX_RESPOSTA_CHARS);

    if (!resposta.ok) {
      // O status importa pro modelo: 404 é "não achei", 500 é "tente depois".
      return `A consulta falhou (HTTP ${resposta.status}). Resposta: ${texto.slice(0, 500)}`;
    }
    return texto || '(a consulta respondeu vazio)';
  } catch (err) {
    const mensagem = err instanceof Error ? err.message : String(err);
    logger.warn('[http-tool] falhou', { ferramenta: t.nome, erro: mensagem });
    // Sem detalhe de rede pro modelo: ele repassaria ao lead, e endereço
    // interno ou nome de host não são assunto de quem está do outro lado.
    return 'Não consegui consultar agora. Diga que vai confirmar e retorna.';
  }
}

/**
 * A FORMA de uma memória gravada — nada além disso.
 *
 * Vive fora do `ai-agent.service` de propósito. Quando o simulador precisou
 * desembrulhar autoria, importar daqui o helper arrastava junto o serviço
 * inteiro do agente — e os testes que mockam esse serviço passaram a receber
 * `undefined` no lugar da função, derrubando o fluxo em silêncio. Formato de
 * dado não pode depender de quem escreve o dado.
 */

/**
 * O valor de uma memória, seja ela antiga (valor cru) ou nova (com autoria).
 *
 * As duas formas convivem de propósito: gravar autoria é melhoria, não motivo
 * pra migrar dado de cliente em produção. Contato que já tem `faturamento:
 * "R$ 80 mil"` continua funcionando.
 */
export function valorDaMemoria(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'v' in (v as object)) {
    return (v as { v: unknown }).v;
  }
  return v;
}

/**
 * Quem gravou e quando, se a informação existir.
 *
 * Responde "por que a IA acha isso?" com uma consulta em vez de uma
 * investigação — e com vários agentes escrevendo na mesma memória, essa
 * pergunta deixa de ser rara.
 */
export function autoriaDaMemoria(v: unknown): { por?: string; em?: string } | null {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'v' in (v as object)) {
    const o = v as { por?: string; em?: string };
    return { por: o.por, em: o.em };
  }
  return null;
}

/**
 * Validade da memória de longo prazo, em dias.
 *
 * O fato sobre a pessoa envelhece: faturamento, dor principal e "quem decide"
 * mudam, e um agente que cita como certo o que o lead disse há um ano parece
 * desatento — pior que perguntar de novo. Passado o prazo a entrada é tratada
 * como AUSENTE na leitura; nada é apagado do banco, então `lembrar` gravando o
 * mesmo campo renova o prazo e o histórico do valor antigo segue auditável.
 */
export const MEMORIA_LONGA_DIAS = 60;

/**
 * Esta memória passou da validade?
 *
 * Só entrada com autoria carrega `em`; valor cru (formato antigo) não tem data,
 * e sem data não há como saber a idade — continua valendo. Data ilegível também
 * conta como sem data, pelo mesmo motivo.
 */
export function memoriaExpirada(v: unknown, agora: number = Date.now()): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v) || !('v' in (v as object))) return false;
  const em = (v as { em?: unknown }).em;
  if (typeof em !== 'string') return false;
  const gravadaEm = new Date(em).getTime();
  if (!Number.isFinite(gravadaEm)) return false;
  return agora - gravadaEm > MEMORIA_LONGA_DIAS * 86_400_000;
}

/** O mapa sem as entradas vencidas — para LEITURA; o banco não muda. */
export function semExpiradas(
  attrs: Record<string, unknown> | undefined,
  agora: number = Date.now()
): Record<string, unknown> {
  if (!attrs) return {};
  return Object.fromEntries(Object.entries(attrs).filter(([, v]) => !memoriaExpirada(v, agora)));
}

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

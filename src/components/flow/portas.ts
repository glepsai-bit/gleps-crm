/**
 * As portas de um bloco do canvas — entradas e saídas — e as regras de ligação
 * que dependem delas, num lugar só.
 *
 * Duas coisas moram aqui porque o card, a página do canvas, a aresta e o painel
 * do agente precisam concordar sobre elas:
 *
 * 1. **O rótulo de uma saída fixa é diferente do valor dela.** O valor
 *    (`respondeu`, `humano`, `encerrou`) é contrato: está gravado em
 *    `edge.branch` de todo fluxo salvo, está no enum `rota` do formato de
 *    resposta dos agentes e é o que `backend/src/services/flow/nodes.ts`
 *    compara pra decidir o ramo. Só o TEXTO NA TELA muda.
 * 2. **Quais blocos recebem o quê.** A base de conhecimento não é um passo do
 *    fluxo: é uma FONTE que alimenta o agente. Por isso ela não tem entrada, e
 *    quem roda agente tem duas — a do fluxo da conversa (topo) e a do
 *    conhecimento (esquerda).
 */

/** A entrada por onde a CONVERSA chega no bloco. */
export const ENTRADA_DE_FLUXO = 'entrada';

/** A entrada por onde uma FONTE (base de conhecimento) alimenta o bloco. */
export const ENTRADA_DE_CONHECIMENTO = 'conhecimento';

/** Blocos que rodam um agente — e portanto consultam uma base. */
export const TIPOS_DE_AGENTE = new Set(['ai.atender', 'ai.agent']);

/** Fonte alimenta um bloco; não é um passo que a conversa percorre. */
export function ehFonte(tipo: string): boolean {
  return tipo.startsWith('source.');
}

/**
 * O bloco recebe o fluxo da conversa?
 *
 * Gatilho não: é onde o fluxo começa. Fonte também não — e essa era a queixa:
 * a base DESENHAVA uma bolinha de entrada no topo que `conexaoValida` sempre
 * recusou. Uma porta que nunca pode ser usada é pior que porta nenhuma.
 */
export function recebeFluxo(tipo: string): boolean {
  return !tipo.startsWith('trigger.') && !ehFonte(tipo);
}

/** O bloco aceita uma fonte ligada nele? Só quem roda agente consulta base. */
export function recebeConhecimento(tipo: string): boolean {
  return TIPOS_DE_AGENTE.has(tipo);
}

/**
 * O texto da saída fixa na tela.
 *
 * "respondeu" era lido como "aqui sai a resposta" — quando a resposta JÁ FOI
 * enviada pelo próprio bloco. A porta responde outra pergunta: "e depois
 * disso, o quê?". Por isso os três rótulos começam por "depois"/"se".
 */
export const ROTULOS_DE_PORTA: Record<string, string> = {
  respondeu: 'Depois de responder',
  humano: 'Se pedir humano',
  encerrou: 'Se encerrar',
};

/**
 * O nome da saída como o usuário lê. Rota criada por quem monta mantém o nome
 * que ele deu; só o underscore vira espaço (`sem_atendente` → "sem atendente").
 */
export function rotuloDaPorta(porta: string): string {
  return ROTULOS_DE_PORTA[porta] ?? porta.replace(/_/g, ' ');
}

/**
 * A regra de quem pode ligar em quem, e por qual entrada.
 *
 * Pura de propósito: `conexaoValida` na página junta isto às checagens que
 * precisam do canvas (nó ligado nele mesmo, ligação repetida), e aqui fica só
 * o que dá pra decidir olhando os dois tipos e a entrada escolhida.
 */
export function ligacaoPermitida(
  tipoDaOrigem: string,
  tipoDoDestino: string,
  entrada: string | null | undefined
): boolean {
  // Gatilho é onde o fluxo começa, e fonte alimenta: nenhum dos dois recebe.
  if (!recebeFluxo(tipoDoDestino)) return false;
  // A base de conhecimento só alimenta quem roda um agente — e só pela entrada
  // de conhecimento. Pela entrada do topo o desenho diria que a conversa passa
  // pela base antes do atendimento, que não é o que acontece.
  if (ehFonte(tipoDaOrigem)) {
    return recebeConhecimento(tipoDoDestino) && entrada === ENTRADA_DE_CONHECIMENTO;
  }
  // E o contrário também: a entrada de conhecimento não recebe passo comum.
  return entrada !== ENTRADA_DE_CONHECIMENTO;
}

/**
 * Em qual entrada do bloco de destino a aresta chega.
 *
 * O grafo salvo guarda só origem, destino e ramo — nunca o handle. Então a
 * entrada é DERIVADA aqui a cada carregamento: aresta que sai de uma fonte
 * chega na entrada de conhecimento, o resto chega na do fluxo.
 *
 * É isto que faz o fluxo que já está salvo — cuja aresta base→agente foi
 * gravada quando só existia a entrada do topo — continuar desenhado e continuar
 * virando `knowledgeBaseId`, sem migração de dados.
 */
export function entradaDaAresta(tipoDaOrigem: string): string {
  return ehFonte(tipoDaOrigem) ? ENTRADA_DE_CONHECIMENTO : ENTRADA_DE_FLUXO;
}

/** Lê uma chave de texto da config do bloco; vazio vira null, que é o que os painéis esperam. */
export function textoDaConfig(config: Record<string, unknown>, chave: string): string | null {
  const v = config[chave];
  return typeof v === 'string' && v ? v : null;
}

/**
 * Agente → base, lido das LINHAS do desenho (bloco de base ligado no bloco de
 * agente). `null` = tem linha, mas o bloco de base ainda não escolheu qual.
 * Vale pro grafo salvo e pro canvas: é a mesma pergunta.
 *
 * Olha só origem e destino, NUNCA o handle — de propósito. Aresta salva antes
 * da entrada de conhecimento existir não tem handle nenhum, e ela precisa
 * continuar valendo como ligação de base.
 */
export function basesDesenhadas(
  nos: { id: string; type: string; config?: Record<string, unknown> }[],
  arestas: { source: string; target: string }[]
): Map<string, string | null> {
  const porId = new Map(nos.map((n) => [n.id, n]));
  const resultado = new Map<string, string | null>();
  for (const e of arestas) {
    const origem = porId.get(e.source);
    const destino = porId.get(e.target);
    if (origem?.type !== 'source.knowledge' || !destino || !recebeConhecimento(destino.type)) {
      continue;
    }
    const agentId = textoDaConfig(destino.config ?? {}, 'agentId');
    if (!agentId) continue;
    const baseId = textoDaConfig(origem.config ?? {}, 'baseId');
    // A primeira linha com base escolhida vence; uma sem base não apaga a que tem.
    if (!resultado.has(agentId) || (baseId && !resultado.get(agentId))) {
      resultado.set(agentId, baseId);
    }
  }
  return resultado;
}

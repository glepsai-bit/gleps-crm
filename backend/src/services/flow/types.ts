/**
 * T-028 Fase 2 — formato do grafo e contrato dos nós.
 *
 * Este formato é o FINAL: o canvas da tela é um editor deste JSON, não uma
 * camada por cima dele. Um fluxo montado por código (o padrão semeado) e um
 * montado arrastando nós produzem exatamente a mesma estrutura.
 */

export type FlowStatus = 'draft' | 'shadow' | 'active';
export type RunStatus = 'buffering' | 'running' | 'done' | 'failed' | 'skipped';

export interface FlowNode {
  id: string;
  type: string;
  label?: string;
  config?: Record<string, unknown>;
  /** Posição no canvas. O motor ignora; existe só pro editor. */
  position?: { x: number; y: number };
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  /**
   * Qual saída do nó de origem esta aresta representa.
   * null/ausente = saída padrão (o caminho "normal").
   */
  branch?: string | null;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/** Uma mensagem do lead acumulada durante o agrupamento. */
export interface BufferedMessage {
  id: string;
  content: string | null;
  contentType: string;
  createdAt: string;
}

export interface NodeContext {
  accountId: string;
  runId: string;
  flowId: string;
  conversationId: string;
  /**
   * Modo sombra: o fluxo roda inteiro e grava cada passo, mas nenhum nó pode
   * enviar mensagem ou alterar a conversa. É o que permite rodar em paralelo
   * com o n8n e comparar, antes de virar a chave.
   */
  shadow: boolean;
  /**
   * Ator sentinela pros services (`flow:<flowId>`). Segue o mesmo padrão que
   * as integrações já usam (`api:<apiKeyId>`): os services só gravam isso em
   * evento, não há FK pra User.
   */
  actorId: string;
  /** Variáveis acumuladas entre os nós. Mutável ao longo do run. */
  vars: Record<string, unknown>;
}

export interface NodeResult {
  /** Qual aresta seguir. Ausente = saída padrão. */
  branch?: string;
  /** Variáveis a mesclar no contexto do run. */
  vars?: Record<string, unknown>;
  /** Encerra o run aqui (guarda bloqueou, conversa resolvida...). */
  stop?: boolean;
  stopReason?: string;
  /** O que aparece no log do passo — é a tela de execuções. */
  output?: Record<string, unknown>;
}

export interface NodeDefinition {
  type: string;
  label: string;
  description: string;
  /** Saídas possíveis. O canvas usa pra desenhar as alças do nó. */
  branches: { key: string; label: string }[];
  /**
   * O nó age pra fora (envia mensagem, altera conversa, chama API externa)?
   * Usado pro selo de "ação" no canvas e pra deixar explícito o que o modo
   * sombra suprime.
   */
  mutates: boolean;
  execute(node: FlowNode, ctx: NodeContext): Promise<NodeResult>;
}

/**
 * Troca {{variavel}} pelo valor no contexto. Aceita caminho com ponto
 * (`{{agente.etapa}}`), que é como a saída estruturada do agente é lida.
 *
 * Variável ausente vira string vazia em vez de deixar o literal `{{x}}` no
 * texto — mandar "Olá {{nome}}" pro lead é pior que mandar "Olá".
 */
export function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const value = readPath(vars, path);
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

export function readPath(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, source);
}

/** Texto agrupado das mensagens que o lead mandou nesta rodada. */
export function bufferedText(vars: Record<string, unknown>): string {
  const msgs = Array.isArray(vars.mensagens) ? (vars.mensagens as BufferedMessage[]) : [];
  return msgs
    .map((m) => (m.content ?? '').trim())
    .filter(Boolean)
    .join('\n');
}

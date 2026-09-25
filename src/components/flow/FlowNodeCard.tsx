/**
 * T-028 — cartão de passo do canvas de fluxo.
 *
 * O nó padrão do React Flow tem fundo claro fixo e ignora o tema: no modo
 * escuro o texto sumia e não dava pra ler o que cada bloco fazia. Este nó usa
 * os tokens do design system, então funciona nos dois temas.
 *
 * Além de legível, ele mostra um RESUMO da configuração — qual agente, quantos
 * segundos, qual etapa. Sem isso o usuário precisa clicar em cada bloco pra
 * lembrar o que configurou.
 */
import { memo } from 'react';
import { Handle, Position, useNodeId, type NodeProps } from '@xyflow/react';
import {
  Bot,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Clock,
  GitBranch,
  Globe,
  GripVertical,
  Maximize2,
  MessageSquare,
  Mic,
  Save,
  Send,
  ShieldCheck,
  Tag,
  Timer,
  Trash2,
  UserPlus,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { CamposDoNo } from './CamposDoNo';
import { useEditorDeFluxo } from './EditorDeFluxoContext';
import {
  ENTRADA_DE_CONHECIMENTO,
  ENTRADA_DE_FLUXO,
  recebeConhecimento,
  recebeFluxo,
  rotuloDaPorta,
} from './portas';

const ICONES: Record<string, LucideIcon> = {
  'trigger.message_received': MessageSquare,
  'guard.conditions': ShieldCheck,
  'buffer.debounce': Timer,
  'media.transcribe': Mic,
  'ai.agent': Bot,
  'logic.switch': GitBranch,
  'crm.apply_stage': Tag,
  'crm.update_contact': Save,
  'chat.reply': Send,
  'chat.assign_human': UserPlus,
  'chat.resolve': CheckCircle2,
  'http.request': Globe,
  'flow.wait': Clock,
  'flow.aguardar': Clock,
  'ai.atender': Bot,
};

/**
 * Tipos cujo conteúdo é grande demais pro bloco e abre ampliado — e o que o
 * botão promete em cada um. O texto muda porque o que abre muda: no bloco de
 * atendimento abre o agente inteiro (prompt, memória, conhecimento), na fonte
 * abre a base.
 */
/** Blocos que rodam um agente — e portanto têm memória própria pra declarar. */
const TEM_MEMORIA = new Set(['ai.atender', 'ai.agent']);

const AMPLIA: Record<string, string> = {
  'ai.atender': 'Abrir o agente',
  'source.knowledge': 'Abrir a base',
  'ai.agent': 'Abrir o prompt',
};

/** Passos que agem pra fora — o modo sombra simula estes. */
const ACOES = new Set([
  'ai.atender',
  'crm.apply_stage',
  'crm.update_contact',
  'chat.reply',
  'chat.assign_human',
  'chat.resolve',
  'http.request',
]);

export interface FlowNodeData extends Record<string, unknown> {
  label?: string;
  tipo?: string;
  config?: Record<string, unknown>;
  /** Nome do agente selecionado, resolvido pela página. */
  agenteNome?: string | null;
  /**
   * A base de conhecimento do agente deste bloco, resolvida pela página.
   * `nome` null = sem base. `aviso` é o que ainda não bate com o salvo:
   * "(salvar pra aplicar)" quando a linha foi desenhada e não salva.
   */
  base?: { nome: string | null; aviso?: string | null };
  /** Problemas do grafo que apontam para este nó. */
  temProblema?: boolean;
  /** Houve um teste. Sem isto não dá pra distinguir "não rodou" de "não passou aqui". */
  execRodou?: boolean;
  /** Saídas nomeadas. Vêm do schema do agente quando o bloco roda um. */
  portas?: string[];
  /**
   * Como este passo se saiu no último teste do simulador.
   *
   * É o que transforma "o fluxo quebrou" em "quebrou NESTE bloco": em vez de
   * ler log e procurar o nó, o bloco acende vermelho na tela. Ausente = não foi
   * alcançado — o que também é informação: o caminho não passou por aqui.
   *
   * `waiting` é o run ainda na janela de agrupamento (só o bloco de agrupar
   * recebe). `puladoNoSimulador` é a espera longa que o simulador não segurou
   * — o bloco diz isso em vez de fingir que passou.
   */
  exec?: { status: string; ms: number; error: string | null; puladoNoSimulador?: string | null };
}

const texto = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Uma linha curta dizendo o que este passo está configurado para fazer. */
function resumo(tipo: string, config: Record<string, unknown>, agenteNome?: string | null): string {
  switch (tipo) {
    // `ai.atender` faltava aqui: o bloco principal do canvas caía no `default`
    // e nunca dizia qual agente estava rodando dentro dele.
    case 'ai.agent':
    case 'ai.atender':
      return agenteNome ? agenteNome : 'sem agente selecionado';
    case 'buffer.debounce':
      return `espera ${Number(config.segundos ?? 15)}s`;
    case 'flow.wait':
      return `${Number(config.segundos ?? 5)}s`;
    case 'flow.aguardar':
      return `${Number(config.valor ?? 1)} ${texto(config.unidade) || 'dias'}`;
    case 'media.transcribe':
      return `idioma ${texto(config.idioma) || 'pt'}`;
    case 'crm.apply_stage':
      return texto(config.etapa) || 'etapa não definida';
    case 'chat.reply':
      return texto(config.texto) || 'texto não definido';
    case 'logic.switch':
      return texto(config.variavel) || 'variável não definida';
    case 'http.request':
      return `${texto(config.metodo) || 'POST'} ${texto(config.url) || 'sem URL'}`;
    case 'chat.resolve':
      return `encerra como ${texto(config.outcome) || 'resolved'}`;
    case 'chat.assign_human':
      // Com time escolhido só atendentes dele entram — o nome do time fica
      // nos campos do bloco; aqui basta dizer que não é sorteio geral.
      return texto(config.teamId) ? 'transfere para o time escolhido' : 'sorteia atendente online';
    case 'crm.update_contact': {
      const campos = Object.keys((config.campos ?? {}) as Record<string, unknown>);
      const destino = texto(config.destino) === 'conversa' ? 'nesta conversa' : 'no lead';
      return campos.length ? `${campos.length} campo(s) ${destino}` : 'nenhum campo';
    }
    case 'guard.conditions': {
      const ativas: string[] = [];
      if (config.humanoAssumiu !== false) ativas.push('humano assumiu');
      if (config.conversaResolvida !== false) ativas.push('já resolvida');
      return ativas.length ? `para se: ${ativas.join(', ')}` : 'sem condições';
    }
    case 'trigger.message_received':
      return 'quando o lead escrever';
    default:
      return '';
  }
}

/** Moldura do resultado do teste. Erro ganha o destaque mais forte. */
const MOLDURA_EXEC: Record<string, string> = {
  ok: 'border-emerald-500/70 ring-2 ring-emerald-500/25',
  error: 'border-destructive ring-2 ring-destructive/35',
  skipped: 'border-amber-500/70 ring-2 ring-amber-500/25',
  // Na janela de agrupamento: o fluxo está parado AQUI, esperando o lead.
  waiting: 'border-sky-500/70 ring-2 ring-sky-500/25 animate-pulse',
};
/** Espera que o simulador não segurou: passou, mas não como passaria de verdade. */
const MOLDURA_PULADO = 'border-sky-500/50 border-dashed ring-2 ring-sky-500/15';

/** O que o rodapé do bloco diz sobre o último teste. */
function rotuloDaExec(exec: NonNullable<FlowNodeData['exec']>): string {
  if (exec.status === 'waiting') return 'aguardando';
  if (exec.status === 'error') return 'erro';
  if (exec.status === 'skipped') return 'parou aqui';
  if (exec.puladoNoSimulador != null) {
    return exec.puladoNoSimulador
      ? `pulado no simulador (${exec.puladoNoSimulador})`
      : 'pulado no simulador';
  }
  return 'passou';
}

function FlowNodeCardBase({ data, selected }: NodeProps) {
  const d = (data ?? {}) as FlowNodeData;
  const tipo = d.tipo ?? '';
  const config = d.config ?? {};
  const Icone = ICONES[tipo] ?? CircleHelp;
  const ehGatilho = tipo.startsWith('trigger.');
  const temEntradaDeFluxo = recebeFluxo(tipo);
  const temEntradaDeConhecimento = recebeConhecimento(tipo);
  const ehAcao = ACOES.has(tipo);
  const detalhe = resumo(tipo, config, d.agenteNome);
  const exec = d.exec;
  const puladoNoSimulador = exec?.status === 'ok' && exec.puladoNoSimulador != null;

  const editor = useEditorDeFluxo();
  const id = useNodeId();
  // Sem editor (teste isolado) o bloco é só leitura — que é o certo.
  const editavel = Boolean(editor && id);
  const aberto = Boolean(id && editor?.abertos.has(id));
  const portas = Array.isArray(d.portas) ? (d.portas as string[]) : [];
  /*
    A saída `default` continua embaixo; as outras saem pela direita.

    Um bloco com dois ramos ("seguiu" / "deu erro") é a maioria dos casos. Se
    TODAS as saídas fossem para a direita, um fluxo linear passaria a desenhar
    uma volta a cada passo. Assim a linha principal continua descendo e só o
    desvio sai de lado — que é como o olho já lê um fluxograma.
  */
  const temPadrao = portas.includes('default');
  const nomeadas = portas.filter((p) => p !== 'default');

  return (
    <div
      className={cn(
        'rounded-lg border bg-card text-card-foreground shadow-sm transition-colors',
        aberto ? 'w-[300px]' : 'w-[220px]',
        selected ? 'border-primary ring-2 ring-primary/30' : 'border-border',
        d.temProblema && 'border-destructive/60',
        // O resultado do teste vence a borda normal: durante a depuração é a
        // informação que importa. A seleção continua ganhando de tudo — é a
        // ação deliberada do usuário.
        !selected && exec && (puladoNoSimulador ? MOLDURA_PULADO : MOLDURA_EXEC[exec.status]),
        // Não alcançado no teste esmaece: o caminho não passou por aqui, e ver
        // isso de relance é metade do diagnóstico.
        !selected && d.execRodou && !exec && 'opacity-45'
      )}
    >
      {/* Gatilho não tem entrada (é onde o fluxo começa) e fonte também não
          (ela alimenta um bloco, não é um passo que a conversa percorre). */}
      {temEntradaDeFluxo && (
        <Handle
          id={ENTRADA_DE_FLUXO}
          type="target"
          position={Position.Top}
          title="Entrada — a conversa chega por aqui"
          aria-label="Entrada — a conversa chega por aqui"
          className="!w-3 !h-3 !bg-primary !border-2 !border-background"
        />
      )}

      {/*
        A segunda entrada, só pra fontes.

        A base entrava pela MESMA porta da conversa, e isso desenhava uma
        mentira: a base não é um passo antes do atendimento, é um material que
        o agente consulta. Separada e de lado, com contorno tracejado, ela
        para de disputar a linha principal do fluxograma.
      */}
      {temEntradaDeConhecimento && (
        <Handle
          id={ENTRADA_DE_CONHECIMENTO}
          type="target"
          position={Position.Left}
          title="Conhecimento — ligue a base aqui"
          aria-label="Conhecimento — ligue a base aqui"
          className="!w-3 !h-3 !bg-background !border-2 !border-dashed !border-sky-500 dark:!border-sky-400"
        />
      )}

      <div className="px-3 pb-2.5">
        {/*
          A faixa de arraste.

          O card inteiro é arrastável MENOS o que está marcado `nodrag` — e com
          os campos abertos isso é ~85% da altura. Sem uma faixa visível o
          usuário mira no meio do bloco (onde o cursor de "arraste" aparecia por
          herança), nada acontece, e a conclusão é "não dá pra arrastar". Aqui a
          faixa tem fundo próprio, a alça acende no hover e o cursor muda — e é
          a MESMA barra esteja o bloco aberto ou fechado.
        */}
        <div className="group/alca -mx-3 mb-0.5 flex cursor-grab select-none items-center gap-2 rounded-t-lg border-b bg-muted/40 px-3 py-2 active:cursor-grabbing">
          <GripVertical className="-ml-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-colors group-hover/alca:text-muted-foreground" />
          <span
            className={cn(
              'flex items-center justify-center w-6 h-6 rounded-md shrink-0',
              ehGatilho && 'bg-primary/15 text-primary',
              !ehGatilho && ehAcao && 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
              !ehGatilho && !ehAcao && 'bg-muted text-muted-foreground'
            )}
          >
            <Icone className="w-3.5 h-3.5" />
          </span>

          <span className="text-[13px] font-medium leading-tight flex-1 min-w-0 truncate">
            {d.label || tipo}
          </span>

          {ehAcao && !editavel && (
            <Zap
              className="w-3 h-3 text-amber-500 shrink-0"
              aria-label="Age para fora — simulado no modo sombra"
            />
          )}

          {editavel && (
            /* nodrag: sem isto, clicar no botão arrasta o bloco em vez de
               acionar. O React Flow decide pelo seletor no alvo do ponteiro. */
            <div className="nodrag flex items-center gap-0.5 shrink-0">
              {AMPLIA[tipo] && (
                <button
                  type="button"
                  onClick={() => editor!.ampliar(id!)}
                  title={AMPLIA[tipo]}
                  aria-label={AMPLIA[tipo]}
                  className="p-1 rounded hover:bg-muted text-muted-foreground"
                >
                  <Maximize2 className="w-3 h-3" />
                </button>
              )}
              {/* Memória só faz sentido com agente escolhido: é a memória DELE. */}
              {TEM_MEMORIA.has(tipo) && typeof config.agentId === 'string' && config.agentId && (
                <button
                  type="button"
                  onClick={() => editor!.abrirMemoria(id!)}
                  title="O que este agente lembra"
                  aria-label="O que este agente lembra"
                  className="p-1 rounded hover:bg-muted text-muted-foreground"
                >
                  <Brain className="w-3 h-3" />
                </button>
              )}
              <button
                type="button"
                onClick={() => editor!.alternarAberto(id!)}
                title={aberto ? 'Fechar campos' : 'Abrir campos'}
                className="p-1 rounded hover:bg-muted text-muted-foreground"
              >
                {aberto ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
            </div>
          )}
        </div>

        {detalhe && (
          <p className="text-[11px] text-muted-foreground mt-2 leading-snug line-clamp-2 break-words">
            {detalhe}
          </p>
        )}

        {d.base && (
          /* A base ao lado do agente: "sem base" é a informação que faltava —
             a ferramenta de busca ligada num agente sem base não acha nada, e
             nada na tela dizia isso. */
          <p
            className={cn(
              'text-[11px] mt-0.5 leading-snug line-clamp-2 break-words',
              d.base.nome ? 'text-muted-foreground' : 'text-muted-foreground/60'
            )}
          >
            {d.base.nome ? `base: ${d.base.nome}` : 'sem base'}
            {d.base.aviso && (
              <span className="text-amber-600 dark:text-amber-400"> {d.base.aviso}</span>
            )}
          </p>
        )}

        {aberto && editavel && (
          /* nodrag para o arrasto não roubar o clique no campo; nowheel para o
             scroll de textarea e lista não virar zoom do canvas; nopan porque
             arrastar o mouse pra SELECIONAR texto num campo panava o canvas —
             o d3-zoom só desiste em `.nopan`, e `nodrag` não impede o evento
             de subir até ele. */
          <div className="nodrag nopan nowheel mt-2.5 pt-2.5 border-t space-y-3 text-xs">
            <CamposDoNo
              tipo={tipo}
              config={config}
              agentes={editor!.agentes}
              bases={editor!.bases}
              set={(chave, valor) => editor!.setConfig(id!, chave, valor)}
              janelaDoFluxo={editor!.janelaDoFluxo}
              />
            {!ehGatilho && (
              <button
                type="button"
                onClick={() => editor!.remover(id!)}
                className="flex items-center gap-1.5 text-[11px] text-destructive hover:underline"
              >
                <Trash2 className="w-3 h-3" /> Remover passo
              </button>
            )}
          </div>
        )}

        {exec && (
          <div className="mt-1.5 flex items-center gap-1.5 text-[10px]">
            <span
              className={cn(
                'font-medium',
                exec.status === 'ok' && !puladoNoSimulador && 'text-emerald-600 dark:text-emerald-400',
                puladoNoSimulador && 'text-sky-700 dark:text-sky-400',
                exec.status === 'waiting' && 'text-sky-700 dark:text-sky-400',
                exec.status === 'error' && 'text-destructive',
                exec.status === 'skipped' && 'text-amber-600 dark:text-amber-400'
              )}
            >
              {rotuloDaExec(exec)}
            </span>
            {exec.status !== 'waiting' && <span className="text-muted-foreground">{exec.ms}ms</span>}
          </div>
        )}

        {exec?.error && (
          // A mensagem do erro no próprio bloco: sem isso o usuário veria o
          // vermelho e teria que ir procurar o motivo em outro lugar.
          <p className="text-[10px] text-destructive mt-1 leading-snug line-clamp-3 break-words">
            {exec.error}
          </p>
        )}
      </div>

      {portas.length > 0 ? (
        /* Portas nomeadas: a decisão do agente vira saída visível, em vez de
           variável que um nó de condição lê depois. */
        <>
          {nomeadas.length > 0 && (
            <div className="border-t px-3 py-2.5 space-y-2">
              {nomeadas.map((porta) => (
                /*
                  Uma bolinha por linha, e ela fica pra FORA do card.

                  Antes havia duas bolinhas cinzas iguais por linha: uma
                  decorativa ao lado do nome (onde o olho mirava) e a de verdade
                  encostada na borda, meio escondida DENTRO do card. Quem
                  clicava na primeira não conseguia puxar cabo nenhum.

                  A altura mínima da linha separa os alvos: o hit-box real de
                  cada porta tem 28px (ver .react-flow__handle::after no
                  index.css) e linhas mais juntas fariam os alvos se sobrepor.
                */
                <div
                  key={porta}
                  className="relative flex min-h-[20px] items-center justify-end gap-1.5"
                >
                  <span className="truncate text-[11px] font-medium text-muted-foreground">
                    {rotuloDaPorta(porta)}
                  </span>
                  <Handle
                    id={porta}
                    type="source"
                    position={Position.Right}
                    style={{ top: '50%', right: -16 }}
                    className="!w-3 !h-3 !bg-primary !border-2 !border-background"
                  />
                </div>
              ))}
            </div>
          )}
          {temPadrao && (
            <Handle
              id="default"
              type="source"
              position={Position.Bottom}
              className="!w-3 !h-3 !bg-primary !border-2 !border-background"
            />
          )}
        </>
      ) : (
        <Handle
          type="source"
          position={Position.Bottom}
          className="!w-3 !h-3 !bg-primary !border-2 !border-background"
        />
      )}
    </div>
  );
}

/**
 * Comparador próprio — sem ele, digitar num campo re-renderiza o grafo inteiro.
 *
 * `nodesExibidos` remonta o objeto `data` de TODOS os nós a cada `setNodes`,
 * então o comparador raso do `memo` nunca segura nada: o conteúdo é igual, a
 * referência não. Comparamos os campos que de fato mudam o desenho.
 *
 * `config` entra por referência de propósito: só o nó editado recebe objeto
 * novo, então referência é exatamente o sinal que queremos. Mesmo padrão do
 * MessageBubble no chat, pelo mesmo motivo.
 */
function mesmoDesenho(a: NodeProps, b: NodeProps): boolean {
  if (a.selected !== b.selected || a.id !== b.id) return false;
  const x = (a.data ?? {}) as FlowNodeData;
  const y = (b.data ?? {}) as FlowNodeData;
  return (
    x.tipo === y.tipo &&
    x.label === y.label &&
    x.config === y.config &&
    x.agenteNome === y.agenteNome &&
    x.base?.nome === y.base?.nome &&
    x.base?.aviso === y.base?.aviso &&
    x.temProblema === y.temProblema &&
    x.execRodou === y.execRodou &&
    x.exec?.status === y.exec?.status &&
    x.exec?.ms === y.exec?.ms &&
    x.exec?.error === y.exec?.error &&
    x.exec?.puladoNoSimulador === y.exec?.puladoNoSimulador &&
    (x.portas ?? []).join('|') === (y.portas ?? []).join('|')
  );
}

export const FlowNodeCard = memo(FlowNodeCardBase, mesmoDesenho);

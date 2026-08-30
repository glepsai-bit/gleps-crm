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
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  MessageSquare,
  ShieldCheck,
  Timer,
  Mic,
  Bot,
  GitBranch,
  Tag,
  Save,
  Send,
  UserPlus,
  CheckCircle2,
  Globe,
  Clock,
  Zap,
  CircleHelp,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

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
};

/** Passos que agem pra fora — o modo sombra simula estes. */
const ACOES = new Set([
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
  /** Problemas do grafo que apontam para este nó. */
  temProblema?: boolean;
  /** Houve um teste. Sem isto não dá pra distinguir "não rodou" de "não passou aqui". */
  execRodou?: boolean;
  /**
   * Como este passo se saiu no último teste do simulador.
   *
   * É o que transforma "o fluxo quebrou" em "quebrou NESTE bloco": em vez de
   * ler log e procurar o nó, o bloco acende vermelho na tela. Ausente = não foi
   * alcançado — o que também é informação: o caminho não passou por aqui.
   */
  exec?: { status: string; ms: number; error: string | null };
}

const texto = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Uma linha curta dizendo o que este passo está configurado para fazer. */
function resumo(tipo: string, config: Record<string, unknown>, agenteNome?: string | null): string {
  switch (tipo) {
    case 'ai.agent':
      return agenteNome ? agenteNome : 'sem agente selecionado';
    case 'buffer.debounce':
      return `espera ${Number(config.segundos ?? 15)}s`;
    case 'flow.wait':
      return `${Number(config.segundos ?? 5)}s`;
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
      return 'sorteia atendente online';
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
};

function FlowNodeCardBase({ data, selected }: NodeProps) {
  const d = (data ?? {}) as FlowNodeData;
  const tipo = d.tipo ?? '';
  const config = d.config ?? {};
  const Icone = ICONES[tipo] ?? CircleHelp;
  const ehGatilho = tipo.startsWith('trigger.');
  const ehAcao = ACOES.has(tipo);
  const detalhe = resumo(tipo, config, d.agenteNome);
  const exec = d.exec;

  return (
    <div
      className={cn(
        'rounded-lg border bg-card text-card-foreground shadow-sm w-[220px] transition-colors',
        selected ? 'border-primary ring-2 ring-primary/30' : 'border-border',
        d.temProblema && 'border-destructive/60',
        // O resultado do teste vence a borda normal: durante a depuração é a
        // informação que importa. A seleção continua ganhando de tudo — é a
        // ação deliberada do usuário.
        !selected && exec && MOLDURA_EXEC[exec.status],
        // Não alcançado no teste esmaece: o caminho não passou por aqui, e ver
        // isso de relance é metade do diagnóstico.
        !selected && d.execRodou && !exec && 'opacity-45'
      )}
    >
      {/* Gatilho não tem entrada: é onde o fluxo começa. */}
      {!ehGatilho && (
        <Handle
          type="target"
          position={Position.Top}
          className="!w-2.5 !h-2.5 !bg-muted-foreground !border-background"
        />
      )}

      <div className="px-3 py-2.5">
        <div className="flex items-center gap-2">
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

          {ehAcao && (
            <Zap
              className="w-3 h-3 text-amber-500 shrink-0"
              aria-label="Age para fora — simulado no modo sombra"
            />
          )}
        </div>

        {detalhe && (
          <p className="text-[11px] text-muted-foreground mt-1 leading-snug line-clamp-2 break-words">
            {detalhe}
          </p>
        )}

        {exec && (
          <div className="mt-1.5 flex items-center gap-1.5 text-[10px]">
            <span
              className={cn(
                'font-medium',
                exec.status === 'ok' && 'text-emerald-600 dark:text-emerald-400',
                exec.status === 'error' && 'text-destructive',
                exec.status === 'skipped' && 'text-amber-600 dark:text-amber-400'
              )}
            >
              {exec.status === 'ok' ? 'passou' : exec.status === 'error' ? 'erro' : 'parou aqui'}
            </span>
            <span className="text-muted-foreground">{exec.ms}ms</span>
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

      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-2.5 !h-2.5 !bg-muted-foreground !border-background"
      />
    </div>
  );
}

export const FlowNodeCard = memo(FlowNodeCardBase);

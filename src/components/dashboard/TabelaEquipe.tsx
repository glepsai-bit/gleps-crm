import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { AgentMetricRow } from '@/services/chat-metrics.backend.service';
import { formatMin, formatNumero, iniciais, pct } from './dashboardFormat';

interface TabelaEquipeProps {
  agentes: AgentMetricRow[];
  resolvidasIa: number;
  nomeAgenteIa?: string;
  agenteSelecionado: string;
  onSelecionar: (agentId: string) => void;
  onLimpar: () => void;
  carregando: boolean;
}

export function TabelaEquipe({ agentes, resolvidasIa, nomeAgenteIa, agenteSelecionado, onSelecionar, onLimpar, carregando }: TabelaEquipeProps) {
  const ordenados = [...agentes].sort((a, b) => b.resolved - a.resolved).slice(0, 10);
  const maximo = Math.max(resolvidasIa, ...ordenados.map((a) => a.resolved), 1);
  const vazio = ordenados.length === 0 && resolvidasIa === 0;

  return (
    <div className="lg:col-span-2 rounded-xl border bg-card p-5 flex flex-col gap-3.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-foreground">Equipe</h2>
          <p className="text-[12.5px] text-muted-foreground mt-1">Clique em alguém para filtrar o painel inteiro</p>
        </div>
        {agenteSelecionado !== 'all' && (
          <button type="button" onClick={onLimpar} className="text-[13px] font-medium text-primary hover:underline">
            Limpar filtro
          </button>
        )}
      </div>
      {carregando ? (
        <Skeleton className="h-40 w-full" />
      ) : vazio ? (
        <p className="text-sm text-muted-foreground text-center py-10">Sem conversas atribuídas no período.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse">
            <thead>
              <tr className="text-left text-[11.5px] font-medium uppercase tracking-wider text-muted-foreground">
                <th className="pb-2.5 font-medium">Quem</th>
                <th className="pb-2.5 font-medium w-[34%]">Resolvidas</th>
                <th className="pb-2.5 font-medium text-right">Abertas</th>
                <th className="pb-2.5 font-medium text-right">1ª resposta</th>
                <th className="pb-2.5 font-medium text-right">Resolução</th>
              </tr>
            </thead>
            <tbody>
              {resolvidasIa > 0 && (
                <tr className="border-t text-[13.5px]" data-testid="linha-ia">
                  <td className="py-2.5 font-semibold text-foreground">
                    <span className="inline-flex items-center gap-2.5">
                      <span className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-[7px] bg-primary text-xs text-primary-foreground">IA</span>
                      {nomeAgenteIa ? `${nomeAgenteIa} · agente de IA` : 'Agente de IA'}
                    </span>
                  </td>
                  <td className="py-2.5"><Barra valor={resolvidasIa} maximo={maximo} cor="bg-primary" /></td>
                  <td className="py-2.5 text-right text-muted-foreground">—</td>
                  <td className="py-2.5 text-right text-muted-foreground">—</td>
                  <td className="py-2.5 text-right text-muted-foreground">—</td>
                </tr>
              )}
              {ordenados.map((a) => {
                const sel = agenteSelecionado === a.agentId;
                return (
                  <tr
                    key={a.agentId}
                    onClick={() => onSelecionar(a.agentId)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelecionar(a.agentId);
                      }
                    }}
                    tabIndex={0}
                    aria-selected={sel}
                    data-selected={sel || undefined}
                    className={cn('border-t text-[13.5px] cursor-pointer transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:bg-muted/50', sel && 'bg-primary/10')}
                  >
                    <td className="py-2.5 font-semibold text-foreground">
                      <span className="inline-flex items-center gap-2.5">
                        <span className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-[7px] bg-muted text-xs text-foreground/80">{iniciais(a.agentName)}</span>
                        {a.agentName}
                      </span>
                    </td>
                    <td className="py-2.5"><Barra valor={a.resolved} maximo={maximo} cor="bg-success" /></td>
                    <td className={cn('py-2.5 text-right tabular-nums', a.open > 0 && pct(a.open, a.total) > 40 ? 'text-warning' : 'text-foreground/80')}>{formatNumero(a.open)}</td>
                    <td className="py-2.5 text-right tabular-nums text-foreground/80">{formatMin(a.avgFirstResponseMin)}</td>
                    <td className="py-2.5 text-right tabular-nums text-foreground/80">{formatMin(a.avgResolutionMin)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Barra({ valor, maximo, cor }: { valor: number; maximo: number; cor: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full', cor)} style={{ width: `${pct(valor, maximo)}%` }} />
      </div>
      <span className="w-7 text-right font-semibold tabular-nums text-foreground">{valor}</span>
    </div>
  );
}

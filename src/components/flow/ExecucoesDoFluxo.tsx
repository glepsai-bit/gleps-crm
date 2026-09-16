/**
 * T-037 — as execuções dentro do construtor.
 *
 * Mesma pergunta do simulador, tempo verbal diferente: testar é o que você
 * acabou de fazer, execuções é o que já aconteceu com lead de verdade. Separar
 * em telas obrigava a sair do desenho pra responder "por que ela respondeu
 * aquilo?" — e ao voltar você tinha perdido o contexto do bloco.
 *
 * Clicar numa execução acende os blocos dela no canvas, exatamente como o
 * teste faz. É a mesma leitura, sobre outro momento.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, XCircle, MinusCircle, Eye, Loader2 } from 'lucide-react';
import { flowsService, type RunStatus } from '@/services/flows.backend.service';
import type { StatusPorNo } from './SimuladorChat';

const STATUS: Record<RunStatus, { label: string; cor: string }> = {
  buffering: { label: 'agrupando', cor: 'text-blue-600 dark:text-blue-400' },
  running: { label: 'executando', cor: 'text-blue-600 dark:text-blue-400' },
  sleeping: { label: 'aguardando', cor: 'text-amber-600 dark:text-amber-400' },
  done: { label: 'concluída', cor: 'text-emerald-600 dark:text-emerald-400' },
  failed: { label: 'falhou', cor: 'text-destructive' },
  skipped: { label: 'pulada', cor: 'text-muted-foreground' },
};

interface Props {
  flowId: string;
  /** Acende os blocos da execução escolhida, como o teste faz. */
  onPassos: (porNo: StatusPorNo) => void;
}

export function ExecucoesDoFluxo({ flowId, onPassos }: Props) {
  const [aberta, setAberta] = useState<string | null>(null);

  const { data: runs, isLoading } = useQuery({
    queryKey: ['flow-runs', flowId],
    queryFn: () => flowsService.listRuns({ flowId, limit: 40 }),
    // Execução acontece em segundos; sem o poll o painel parece travado.
    refetchInterval: 8000,
  });

  const { data: detalhe } = useQuery({
    queryKey: ['flow-run', aberta],
    queryFn: () => flowsService.getRun(aberta!),
    enabled: Boolean(aberta),
  });

  // Acende no canvas assim que o detalhe chega.
  if (detalhe && aberta === detalhe.id) {
    const porNo: StatusPorNo = {};
    for (const s of detalhe.steps) porNo[s.nodeId] = { status: s.status, ms: s.ms, error: s.error };
    queueMicrotask(() => onPassos(porNo));
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground gap-2">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Carregando…
      </div>
    );
  }

  if (!runs?.length) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center gap-2 px-6 text-xs text-muted-foreground">
        <Eye className="w-7 h-7" />
        <p>Nenhum atendimento ainda. Assim que um lead escrever com o fluxo publicado, ele aparece aqui.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-2.5 space-y-1.5 min-h-0">
      {runs.map((r) => {
        const st = STATUS[r.status] ?? STATUS.done;
        const selecionada = aberta === r.id;
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => setAberta(selecionada ? null : r.id)}
            className={`w-full text-left rounded-md border p-2.5 transition-colors ${
              selecionada ? 'border-primary/60 bg-muted/40' : 'hover:border-primary/40'
            }`}
          >
            <div className="flex items-center gap-2">
              {r.status === 'failed' ? (
                <XCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
              ) : r.status === 'skipped' ? (
                <MinusCircle className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              ) : (
                <CheckCircle2 className={`w-3.5 h-3.5 shrink-0 ${st.cor}`} />
              )}
              <span className={`text-[11px] font-medium ${st.cor}`}>{st.label}</span>
              {r.shadow && (
                <span className="text-[10px] text-amber-600 dark:text-amber-400">sombra</span>
              )}
              <span className="text-[10px] text-muted-foreground ml-auto">
                {new Date(r.createdAt).toLocaleString('pt-BR', {
                  day: '2-digit',
                  month: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>
            {(r.stopReason || r.error) && (
              <div className="text-[10px] text-muted-foreground mt-1 truncate">
                {r.error ?? r.stopReason}
              </div>
            )}
            {selecionada && (
              <div className="text-[10px] text-primary mt-1.5">
                Acendendo os blocos desta execução no desenho
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

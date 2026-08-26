/**
 * T-028 Fase 2 — execuções do fluxo.
 *
 * É o substituto da aba Executions do n8n, e o instrumento do corte: no modo
 * sombra dá pra abrir cada execução, ver o que a IA TERIA respondido e comparar
 * com o que o n8n respondeu de fato, antes de virar a chave.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, XCircle, MinusCircle, Clock, Eye, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  flowsService,
  type FlowRunStep,
  type RunStatus,
} from '@/services/flows.backend.service';

const STATUS: Record<RunStatus, { label: string; classe: string }> = {
  buffering: { label: 'Agrupando', classe: 'bg-blue-500/15 text-blue-600 border-blue-500/30' },
  running: { label: 'Executando', classe: 'bg-blue-500/15 text-blue-600 border-blue-500/30' },
  done: { label: 'Concluída', classe: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30' },
  failed: { label: 'Falhou', classe: 'bg-destructive/15 text-destructive border-destructive/30' },
  skipped: { label: 'Pulada', classe: 'bg-muted text-muted-foreground' },
};

export default function AdminIaExecucoesPage() {
  const [abertaId, setAbertaId] = useState<string | null>(null);

  const { data: runs, isLoading } = useQuery({
    queryKey: ['flow-runs'],
    queryFn: () => flowsService.listRuns({ limit: 100 }),
    // Execução acontece em segundos; sem o poll a tela parece travada.
    refetchInterval: 5000,
  });

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Execuções</h1>
        <p className="text-muted-foreground mt-1">
          Cada atendimento que o fluxo processou, passo a passo. É aqui que se descobre por que a
          IA respondeu o que respondeu.
        </p>
      </div>

      <div className="flex gap-6 items-start">
        <div className="flex-1 min-w-0 space-y-2">
          {isLoading && <div className="text-muted-foreground">Carregando…</div>}
          {!isLoading && !runs?.length && (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                Nenhuma execução ainda. Assim que um lead mandar mensagem com o fluxo publicado,
                ela aparece aqui.
              </CardContent>
            </Card>
          )}
          {runs?.map((r) => {
            const s = STATUS[r.status];
            return (
              <button
                key={r.id}
                onClick={() => setAbertaId(r.id)}
                className={`w-full text-left rounded-lg border p-3 hover:border-primary/40 transition-colors ${
                  abertaId === r.id ? 'border-primary/60 bg-muted/30' : ''
                }`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={s.classe}>
                    {s.label}
                  </Badge>
                  {r.shadow && (
                    <Badge
                      variant="outline"
                      className="bg-amber-500/15 text-amber-600 border-amber-500/30"
                    >
                      <Eye className="w-3 h-3 mr-1" /> sombra
                    </Badge>
                  )}
                  <span className="text-sm font-medium">{r.flow.name}</span>
                  <span className="text-xs text-muted-foreground">{r._count.steps} passos</span>
                  <span className="text-xs text-muted-foreground ml-auto">
                    {new Date(r.createdAt).toLocaleString('pt-BR')}
                  </span>
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </div>
                {(r.stopReason || r.error) && (
                  <div className="text-xs text-muted-foreground mt-1 truncate">
                    {r.error ?? r.stopReason}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {abertaId && <DetalheDaExecucao runId={abertaId} onFechar={() => setAbertaId(null)} />}
      </div>
    </div>
  );
}

function DetalheDaExecucao({ runId, onFechar }: { runId: string; onFechar: () => void }) {
  const { data: run, isLoading } = useQuery({
    queryKey: ['flow-run', runId],
    queryFn: () => flowsService.getRun(runId),
    refetchInterval: 5000,
  });

  if (isLoading || !run) {
    return <div className="w-[28rem] shrink-0 text-muted-foreground">Carregando…</div>;
  }

  return (
    <div className="w-[28rem] shrink-0 border rounded-lg p-4 space-y-3 max-h-[calc(100vh-10rem)] overflow-y-auto">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-medium text-sm">{run.flow.name}</div>
          <div className="text-xs text-muted-foreground">
            {new Date(run.createdAt).toLocaleString('pt-BR')}
            {run.stopReason && ` · ${run.stopReason}`}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onFechar}>
          ✕
        </Button>
      </div>

      {run.shadow && (
        <div className="text-[11px] rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400 p-2">
          Execução em modo sombra: os passos marcados como <strong>simulado</strong> não foram
          aplicados de verdade. Compare a resposta com a do n8n antes de ativar.
        </div>
      )}

      {run.error && (
        <div className="text-[11px] rounded-md border border-destructive/30 bg-destructive/10 text-destructive p-2">
          {run.error}
        </div>
      )}

      <Separator />

      <div className="space-y-2">
        {run.steps.map((s) => (
          <Passo key={s.id} step={s} />
        ))}
        {run.steps.length === 0 && (
          <div className="text-xs text-muted-foreground">
            Ainda sem passos — a execução está aguardando o agrupamento terminar.
          </div>
        )}
      </div>
    </div>
  );
}

function Passo({ step }: { step: FlowRunStep }) {
  const [aberto, setAberto] = useState(false);
  const icone =
    step.status === 'ok' ? (
      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
    ) : step.status === 'error' ? (
      <XCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
    ) : (
      <MinusCircle className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
    );

  const simulado = Boolean((step.output as Record<string, unknown> | null)?.simulado);

  return (
    <div className="rounded-md border text-xs">
      <button
        onClick={() => setAberto((v) => !v)}
        className="w-full flex items-center gap-2 p-2 text-left hover:bg-muted/40"
      >
        {icone}
        <span className="font-medium">{step.nodeType}</span>
        {simulado && (
          <Badge
            variant="outline"
            className="bg-amber-500/15 text-amber-600 border-amber-500/30 text-[10px] py-0"
          >
            simulado
          </Badge>
        )}
        <span className="ml-auto text-muted-foreground flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {step.ms}ms
        </span>
      </button>

      {aberto && (
        <div className="border-t p-2 space-y-2 bg-muted/20">
          {step.error && <div className="text-destructive break-words">{step.error}</div>}
          {step.output && (
            <div>
              <div className="text-muted-foreground mb-1">Saída</div>
              <pre className="text-[10px] bg-background rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">
                {JSON.stringify(step.output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

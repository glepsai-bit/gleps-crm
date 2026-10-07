import { Link } from 'react-router-dom';
import { Clock } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { LiveAttendanceResult } from '@/services/chat-metrics.backend.service';

interface FaixaAgoraProps {
  data: LiveAttendanceResult | undefined;
  carregando: boolean;
  humanOnlyActive: boolean;
  onFilterHumans: () => void;
}

export function FaixaAgora({ data, carregando, humanOnlyActive, onFilterHumans }: FaixaAgoraProps) {
  const total = data?.total ?? 0;
  const ia = data?.ia?.count ?? 0;
  const humano = data?.humano?.count ?? 0;
  const esperando = data?.emAberto?.count ?? 0;
  const esperandoMais5 = data?.esperandoHaMais5Min ?? 0;
  const p = (n: number) => (total > 0 ? (n / total) * 100 : 0);

  return (
    <section aria-label="Agora" className="rounded-xl border bg-card px-5 py-3.5 flex flex-wrap items-center gap-x-6 gap-y-3">
      <div className="flex items-center gap-3 min-w-[220px]">
        <span className="relative flex h-2 w-2" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-60 animate-ping motion-reduce:animate-none" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
        </span>
        <div>
          <div className="text-[11.5px] font-semibold uppercase tracking-wider text-success">Agora</div>
          {carregando && !data ? (
            <Skeleton className="h-5 w-40 mt-1" />
          ) : total === 0 ? (
            <div className="text-[15px] font-semibold text-foreground mt-0.5">Nenhuma conversa em aberto agora</div>
          ) : (
            <div className="text-[15px] font-semibold text-foreground mt-0.5">
              <span className="tabular-nums">{total}</span> {total === 1 ? 'conversa em aberto' : 'conversas em aberto'}
            </div>
          )}
        </div>
      </div>

      {total > 0 && (
        <div className="flex-1 basis-80 min-w-0">
          <div
            className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={`IA ${ia}, humano ${humano}, esperando ${esperando}`}
          >
            <div className="bg-primary transition-all" style={{ width: `${p(ia)}%` }} />
            <div className="bg-success transition-all" style={{ width: `${p(humano)}%` }} />
            <div className="bg-warning transition-all" style={{ width: `${p(esperando)}%` }} />
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 mt-2 text-[12.5px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <i className="h-2 w-2 rounded-sm bg-primary" />
              IA atendendo <b className="tabular-nums font-semibold text-foreground">{ia}</b>
            </span>
            <button
              type="button"
              onClick={onFilterHumans}
              aria-pressed={humanOnlyActive}
              title="Clique para filtrar conversas atendidas por humanos"
              className={cn(
                'flex items-center gap-1.5 rounded px-1 -mx-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                humanOnlyActive && 'bg-muted ring-1 ring-success',
              )}
            >
              <i className="h-2 w-2 rounded-sm bg-success" />
              Humano <b className="tabular-nums font-semibold text-foreground">{humano}</b>
            </button>
            <span className="flex items-center gap-1.5">
              <i className="h-2 w-2 rounded-sm bg-warning" />
              Esperando <b className="tabular-nums font-semibold text-foreground">{esperando}</b>
            </span>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 ml-auto">
        {esperandoMais5 > 0 && (
          <span className="inline-flex items-center gap-1.5 h-[22px] rounded-full border border-warning/40 bg-warning/10 px-2 text-[11.5px] font-medium text-warning">
            <Clock className="h-3 w-3" aria-hidden="true" />
            {esperandoMais5} esperando há mais de 5 min
          </span>
        )}
        <Link to="/admin/chat" className="text-[13px] font-medium text-primary hover:underline">
          Abrir o Chat →
        </Link>
      </div>
    </section>
  );
}

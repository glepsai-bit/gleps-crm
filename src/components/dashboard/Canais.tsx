import { useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import type { InboxMetricRow, TeamMetricRow } from '@/services/chat-metrics.backend.service';
import { Segmentado } from './Segmentado';
import { formatNumero, formatPct, pct } from './dashboardFormat';

interface CanaisProps {
  porInbox: InboxMetricRow[];
  porTime: TeamMetricRow[];
  origem?: { anuncio: number; organico: number };
  carregando: boolean;
}

type Agrupar = 'inbox' | 'time';

export function Canais({ porInbox, porTime, origem, carregando }: CanaisProps) {
  const [agrupar, setAgrupar] = useState<Agrupar>('inbox');

  const itens = (agrupar === 'inbox'
    ? porInbox.map((i) => ({ id: i.inboxId, nome: i.inboxName, total: i.total }))
    : porTime.map((t) => ({ id: t.teamId, nome: t.teamName, total: t.total }))
  )
    .filter((i) => i.total > 0)
    .sort((a, b) => b.total - a.total);
  const soma = itens.reduce((s, i) => s + i.total, 0);

  const totalOrigem = origem ? origem.anuncio + origem.organico : 0;

  return (
    <div className="rounded-xl border bg-card p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold text-foreground">Canais</h2>
        <Segmentado<Agrupar>
          compacto
          rotuloGrupo="Agrupar por"
          valor={agrupar}
          onChange={setAgrupar}
          opcoes={[
            { valor: 'inbox', rotulo: 'Inbox' },
            { valor: 'time', rotulo: 'Time' },
          ]}
        />
      </div>
      {carregando ? (
        <Skeleton className="h-28 w-full" />
      ) : itens.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">
          {agrupar === 'inbox' ? 'Nenhuma conversa por inbox no período.' : 'Nenhuma conversa atribuída a times.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-3.5">
          {itens.map((i, idx) => (
            <li key={i.id}>
              <div className="flex justify-between gap-2 text-[13px] text-foreground/80 mb-1.5">
                <span className="truncate">{i.nome}</span>
                <span className="shrink-0 font-semibold tabular-nums text-foreground">
                  {formatNumero(i.total)} <span className="font-medium text-muted-foreground">{formatPct(pct(i.total, soma))}</span>
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary" style={{ width: `${pct(i.total, soma)}%`, opacity: Math.max(0.4, 1 - idx * 0.25) }} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {origem && totalOrigem > 0 && (
        <div className="mt-auto border-t pt-3 text-[12.5px] text-muted-foreground">
          Origem dos contatos novos:{' '}
          <span className="font-semibold text-foreground">{formatPct(pct(origem.anuncio, totalOrigem))}</span> anúncios Meta ·{' '}
          <span className="font-semibold text-foreground">{formatPct(pct(origem.organico, totalOrigem))}</span> orgânico
        </div>
      )}
    </div>
  );
}

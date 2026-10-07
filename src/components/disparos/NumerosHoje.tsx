import { Link } from 'react-router-dom';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { NumeroDisparo } from '@/services/disparos.backend.service';
import { CHIP_STATUS_NUMERO, rotuloChipNumero } from './disparosFormat';

interface Props {
  numeros: NumeroDisparo[];
  carregando: boolean;
  optouts: number | null;
}

function textoDaBarra(n: NumeroDisparo) {
  if (n.status === 'aquecendo') return <><b className="tabular-nums text-foreground">{n.limiteDiario}</b> por dia — ainda não recomendado</>;
  if (n.status === 'pausado') return <>aquecimento pausado</>;
  return <><b className="tabular-nums text-foreground">{n.restantesHoje}</b> de {n.limiteDiario} restantes hoje</>;
}

export function NumerosHoje({ numeros, carregando, optouts }: Props) {
  return (
    <section aria-label="Seus números hoje" className="flex flex-wrap items-center gap-5 rounded-xl border bg-card px-5 py-4">
      <div className="min-w-[150px]">
        <div className="text-xs font-medium text-muted-foreground">Seus números hoje</div>
        <div className="mt-1 text-[13px] text-muted-foreground">o limite vem do aquecimento</div>
      </div>

      <div className="grid flex-1 basis-[520px] grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {carregando && numeros.length === 0 && <Skeleton className="h-[72px] w-full" />}
        {!carregando && numeros.length === 0 && <p className="text-[13px] text-muted-foreground">Nenhum número de WhatsApp conectado.</p>}
        {numeros.map((n) => {
          const pct = n.limiteDiario > 0 ? Math.min(100, (n.restantesHoje / n.limiteDiario) * 100) : 0;
          return (
            <div key={n.inboxId} className="rounded-[10px] bg-muted/60 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[13px] font-semibold">{n.nome}</span>
                <span className={cn('inline-flex h-[22px] shrink-0 items-center rounded-full px-2.5 text-[11.5px] font-semibold', CHIP_STATUS_NUMERO[n.status].classe)}>{rotuloChipNumero(n)}</span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
                <div className={cn('h-full rounded-full', n.status === 'pronto' ? 'bg-success' : 'bg-primary')} style={{ width: `${n.status === 'aquecendo' ? Math.min(100, (n.dia ?? 1) / 30 * 100) : pct}%` }} />
              </div>
              <div className="mt-1.5 text-xs text-muted-foreground">{textoDaBarra(n)}</div>
            </div>
          );
        })}
      </div>

      {optouts !== null && (
        <Link to="/admin/opt-outs" className="whitespace-nowrap text-[12.5px] text-primary hover:underline">
          <b className="tabular-nums text-foreground">{optouts}</b> pediram para sair → ver lista
        </Link>
      )}
    </section>
  );
}

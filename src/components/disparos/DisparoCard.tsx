import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { DisparoResumo } from '@/services/disparos.backend.service';
import { CHIP_STATUS_DISPARO, formatarDataHora, formatarHora } from './disparosFormat';

interface Props {
  disparo: DisparoResumo;
  fuso: string;
  /** "Para ..." já montado a partir da lista. */
  paraQuem: string;
  numeros: string;
  ocupado: boolean;
  onPausar: () => void;
  onRetomar: () => void;
  onCancelar: () => void;
  onEditar: () => void;
  onVer: () => void;
}

export function DisparoCard({ disparo: d, fuso, paraQuem, numeros, ocupado, onPausar, onRetomar, onCancelar, onEditar, onVer }: Props) {
  const chip = CHIP_STATUS_DISPARO[d.status];
  const feitas = d.enviadas + d.falhas;
  const pct = d.total > 0 ? Math.min(100, (feitas / d.total) * 100) : 0;
  const agendado = d.status === 'agendado';

  return (
    <article className="flex flex-col gap-3 rounded-[10px] border bg-card p-4" aria-label={d.nome}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h3 className="text-[14.5px] font-semibold">{d.nome}</h3>
            <span className={cn('inline-flex h-[22px] items-center rounded-full px-2.5 text-[11.5px] font-semibold', chip.classe)}>
              {agendado && d.agendadoPara ? `Agendado · ${formatarDataHora(d.agendadoPara, fuso)}` : chip.rotulo}
            </span>
          </div>
          <p className="mt-1.5 max-w-[560px] truncate text-[13px] text-muted-foreground">"{d.texto}"</p>
        </div>
        <div className="flex gap-1.5">
          {d.status === 'enviando' && <Button size="sm" variant="outline" disabled={ocupado} onClick={onPausar}>Pausar</Button>}
          {d.status === 'pausado' && <Button size="sm" variant="outline" disabled={ocupado} onClick={onRetomar}>Retomar</Button>}
          {agendado && <Button size="sm" variant="outline" disabled={ocupado} onClick={onEditar}>Editar</Button>}
          <Button size="sm" variant="ghost" disabled={ocupado} onClick={onCancelar}>Cancelar</Button>
          {!agendado && <Button size="sm" variant="ghost" onClick={onVer}>Ver</Button>}
        </div>
      </div>

      {d.status === 'pausado' && d.pausadoMotivo && <p className="text-[13px] text-warning">{d.pausadoMotivo}</p>}

      <div className="flex flex-wrap gap-x-[18px] gap-y-1 text-[12.5px] text-muted-foreground">
        <span>Para <b className="font-semibold text-foreground">{paraQuem}</b> · <span className="tabular-nums">{d.total}</span> contatos</span>
        <span>Pelo número <b className="font-semibold text-foreground">{numeros}</b></span>
        {agendado ? (
          d.previsaoTerminoEm && <span>Previsão: termina às <span className="tabular-nums">{formatarHora(d.previsaoTerminoEm, fuso)}</span></span>
        ) : (
          <span>
            Começou <span className="tabular-nums">{formatarHora(d.iniciadoEm, fuso)}</span>
            {d.previsaoTerminoEm && <> · termina por volta das <span className="tabular-nums">{formatarHora(d.previsaoTerminoEm, fuso)}</span></>}
          </span>
        )}
      </div>

      {!agendado && (
        <>
          <div className="flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={`Progresso de ${d.nome}`}>
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-[12.5px] font-semibold tabular-nums">{feitas} de {d.total}</span>
          </div>
          <div className="flex flex-wrap gap-4 text-[12.5px] text-muted-foreground">
            <span><b className="tabular-nums text-foreground">{d.enviadas}</b> enviadas</span>
            <span><b className="tabular-nums text-warning">{d.falhas}</b> {d.falhas === 1 ? 'falha' : 'falhas'}</span>
            <span><b className="tabular-nums text-success">{d.respondidas}</b> {d.respondidas === 1 ? 'respondeu' : 'responderam'}</span>
            <span><b className="tabular-nums text-foreground">{d.optout}</b> pediram para sair</span>
          </div>
        </>
      )}
    </article>
  );
}

import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { NumeroAquecimento } from '@/services/aquecimento.backend.service';
import { formatarTelefone, horaCurta, iniciais } from './aquecimentoFormat';

interface Props {
  numeros: NumeroAquecimento[];
  carregando: boolean;
  onAdicionar: () => void;
  onAbrir: (n: NumeroAquecimento) => void;
  onPausar: (n: NumeroAquecimento) => void;
  onRetomar: (n: NumeroAquecimento) => void;
  onRemover: (n: NumeroAquecimento) => void;
  ocupadoId?: string | null;
}

const CHIP: Record<NumeroAquecimento['status'], { rotulo: string; classe: string }> = {
  aquecendo: { rotulo: 'Aquecendo', classe: 'bg-primary/10 text-primary' },
  pronto: { rotulo: 'Pronto', classe: 'bg-success/15 text-success' },
  pausado: { rotulo: 'Pausado', classe: 'bg-warning/15 text-warning' },
  aguardando_parceiro: { rotulo: 'Aguardando parceiro', classe: 'bg-muted text-muted-foreground' },
};

const SAUDE: Record<NumeroAquecimento['saude'], { rotulo: string; ponto: string }> = {
  boa: { rotulo: 'Boa', ponto: 'bg-success' },
  atencao: { rotulo: 'Atenção', ponto: 'bg-warning' },
  pausado: { rotulo: 'Pausado', ponto: 'bg-muted-foreground' },
};

function Etapa({ n }: { n: NumeroAquecimento }) {
  const chip = CHIP[n.status];
  const pronto = n.status === 'pronto';
  const pct = pronto ? 100 : Math.min(100, Math.round((n.dia / 30) * 100));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        <span className={cn('inline-flex h-[22px] items-center rounded-full px-2.5 text-[11.5px] font-semibold whitespace-nowrap', chip.classe)}>{chip.rotulo}</span>
        <span className="text-[12.5px] text-muted-foreground tabular-nums">
          {pronto ? '30 dias completos' : `dia ${n.dia} de 30`}
        </span>
      </div>
      <div className="h-1.5 w-[120px] overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Progresso do aquecimento">
        <div className={cn('h-full', pronto ? 'bg-success' : n.status === 'pausado' ? 'bg-warning' : 'bg-primary')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Hoje({ n }: { n: NumeroAquecimento }) {
  if (n.status === 'pronto') {
    return (
      <>
        <div className="font-semibold text-foreground">Pode disparar</div>
        <div className="mt-0.5 text-[12.5px] text-muted-foreground tabular-nums">até {n.limiteDiario} mensagens/dia · {n.restantesHoje} restantes hoje</div>
      </>
    );
  }
  if (n.status === 'pausado') {
    return (
      <>
        <div className="font-semibold text-warning">
          {n.falhasSeguidas > 1
            ? `${n.falhasSeguidas} envios falharam seguidos`
            : n.falhasSeguidas === 1
              ? '1 envio falhou'
              : 'Pausado'}
        </div>
        <div className="mt-0.5 text-[12.5px] text-muted-foreground">
          {n.pausadoEm ? `às ${horaCurta(n.pausadoEm)}` : ''}
          {n.pausadoEm && n.pausadoMotivo ? ' · ' : ''}
          {n.pausadoMotivo ?? ''}
        </div>
      </>
    );
  }
  if (n.status === 'aguardando_parceiro') {
    return <div className="text-[13px] text-muted-foreground">Precisa de outro número aquecendo</div>;
  }
  return (
    <>
      <div className="font-semibold text-foreground tabular-nums">
        {n.hoje.enviadas} <span className="font-medium text-muted-foreground">de {n.hoje.planejadas} enviadas</span>
      </div>
      <div className="mt-0.5 text-[12.5px] text-muted-foreground tabular-nums">{n.hoje.recebidas} recebidas</div>
    </>
  );
}

export function TabelaNumeros({ numeros, carregando, onAdicionar, onAbrir, onPausar, onRetomar, onRemover, ocupadoId }: Props) {
  return (
    <section aria-label="Seus números" className="rounded-xl border bg-card p-5 flex flex-col gap-3.5">
      <div>
        <h2 className="text-[15px] font-semibold text-foreground">Seus números</h2>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          Todos os números em aquecimento desta conta conversam entre si. Precisa de pelo menos dois.
        </p>
      </div>

      {carregando && numeros.length === 0 ? (
        <Skeleton className="h-40 w-full" />
      ) : numeros.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-12 text-center">
          <h3 className="text-base font-semibold text-foreground">Nenhum número aquecendo</h3>
          <p className="max-w-md text-sm text-muted-foreground">
            Escolha um número conectado para começar. Com dois ou mais, eles passam a conversar entre si todos os dias.
          </p>
          <Button onClick={onAdicionar}><Plus className="h-4 w-4" />Aquecer um número</Button>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse">
            <thead>
              <tr className="text-left text-[11.5px] font-medium uppercase tracking-wider text-muted-foreground">
                <th className="px-3 pb-2.5 font-medium">Número</th>
                <th className="px-3 pb-2.5 font-medium">Etapa</th>
                <th className="px-3 pb-2.5 font-medium">Hoje</th>
                <th className="px-3 pb-2.5 font-medium">Saúde</th>
                <th className="px-3 pb-2.5 font-medium text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {numeros.map((n) => {
                const saude = SAUDE[n.saude];
                const ocupado = ocupadoId === n.id;
                return (
                  <tr
                    key={n.id}
                    onClick={() => onAbrir(n)}
                    className="cursor-pointer border-t text-[13.5px] text-foreground/90 hover:bg-muted/40"
                  >
                    <td className="px-3 py-3.5">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onAbrir(n); }}
                        className="flex items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                        aria-label={`Ver histórico de ${n.inboxNome}`}
                      >
                        <span className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-[9px] bg-muted text-xs font-semibold text-foreground/80">{iniciais(n.inboxNome)}</span>
                        <span>
                          <span className="block font-semibold text-foreground">{n.inboxNome}</span>
                          <span className="block text-[12.5px] text-muted-foreground tabular-nums">{formatarTelefone(n.telefone)}</span>
                        </span>
                      </button>
                    </td>
                    <td className="px-3 py-3.5"><Etapa n={n} /></td>
                    <td className="px-3 py-3.5"><Hoje n={n} /></td>
                    <td className="px-3 py-3.5">
                      <span className="inline-flex items-center gap-2"><span className={cn('h-2 w-2 rounded-full', saude.ponto)} aria-hidden="true" />{saude.rotulo}</span>
                    </td>
                    <td className="px-3 py-3.5 text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="inline-flex flex-col items-end gap-1">
                        <div className="inline-flex items-center gap-1.5">
                          {n.status === 'pausado' ? (
                            <Button size="sm" variant="outline" disabled={ocupado} onClick={() => onRetomar(n)}>Retomar</Button>
                          ) : n.status !== 'pronto' ? (
                            <Button size="sm" variant="outline" disabled={ocupado} onClick={() => onPausar(n)}>Pausar</Button>
                          ) : null}
                          <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={ocupado} onClick={() => onRemover(n)}>Tirar do aquecimento</Button>
                        </div>
                        {n.status === 'pausado' && (
                          <span className="text-[11px] text-muted-foreground">zera as falhas e continua do dia {n.dia}</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

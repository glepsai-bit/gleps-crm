import { Cell, Pie, PieChart } from 'recharts';
import { Skeleton } from '@/components/ui/skeleton';
import { formatNumero, formatPct, pct } from './dashboardFormat';

interface QuemResolveuProps {
  resolvidasIa: number;
  resolvidasHumano: number;
  carregando: boolean;
  transferidas?: { total: number; pct: number | null };
}

export function QuemResolveu({ resolvidasIa, resolvidasHumano, carregando, transferidas }: QuemResolveuProps) {
  const total = resolvidasIa + resolvidasHumano;
  const pctIa = Math.round(pct(resolvidasIa, total));
  const dados = [
    { nome: 'Agente de IA', valor: resolvidasIa, cor: 'hsl(var(--primary))' },
    { nome: 'Equipe', valor: resolvidasHumano, cor: 'hsl(var(--success))' },
  ];

  return (
    <div className="rounded-xl border bg-card p-5 flex flex-col gap-4">
      <div>
        <h2 className="text-[15px] font-semibold text-foreground">Quem resolveu</h2>
        <p className="text-[12.5px] text-muted-foreground mt-1">
          {carregando ? 'Carregando…' : `${formatNumero(total)} ${total === 1 ? 'conversa resolvida' : 'conversas resolvidas'} no período`}
        </p>
      </div>
      {carregando ? (
        <Skeleton className="h-[120px] w-full" />
      ) : total === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">Sem conversas resolvidas no período.</p>
      ) : (
        <div className="flex items-center gap-5">
          <div
            className="relative h-[120px] w-[120px] shrink-0"
            role="img"
            aria-label={`IA ${pctIa} por cento, equipe ${100 - pctIa} por cento`}
          >
            <PieChart width={120} height={120}>
              <Pie data={dados} dataKey="valor" nameKey="nome" cx="50%" cy="50%" innerRadius={46} outerRadius={60} startAngle={90} endAngle={-270} stroke="none" isAnimationActive={false}>
                {dados.map((d) => (
                  <Cell key={d.nome} fill={d.cor} />
                ))}
              </Pie>
            </PieChart>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-2xl font-bold tabular-nums leading-none text-foreground">{pctIa}%</span>
              <span className="text-[11px] text-muted-foreground mt-1">pela IA</span>
            </div>
          </div>
          <div className="flex flex-col gap-3 flex-1 min-w-0">
            {dados.map((d) => (
              <div key={d.nome} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-[13px] text-foreground/80">
                  <i className="h-2.5 w-2.5 rounded-[3px]" style={{ background: d.cor }} />
                  {d.nome}
                </span>
                <span className="text-[15px] font-semibold tabular-nums text-foreground">{formatNumero(d.valor)}</span>
              </div>
            ))}
            {transferidas && (
              <div className="border-t pt-2.5 text-[12.5px] text-muted-foreground">
                Transferidas para humano:{' '}
                <span className="font-semibold tabular-nums text-foreground">{formatNumero(transferidas.total)}</span>
                {transferidas.pct != null && <> ({formatPct(transferidas.pct)})</>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

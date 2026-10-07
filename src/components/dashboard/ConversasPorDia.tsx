import { Area, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';

export interface PontoDia {
  chave: string;
  date: string;
  total: number;
  resolvidas: number;
}

interface ConversasPorDiaProps {
  dados: PontoDia[];
  carregando: boolean;
  rotuloPeriodo: string;
}

export function ConversasPorDia({ dados, carregando, rotuloPeriodo }: ConversasPorDiaProps) {
  return (
    <div className="lg:col-span-2 rounded-xl border bg-card p-5 flex flex-col gap-3.5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-[15px] font-semibold text-foreground">Conversas por dia</h2>
          <p className="text-[12.5px] text-muted-foreground mt-1">Recebidas e resolvidas no período</p>
        </div>
        <div className="flex gap-4 text-[12.5px] text-muted-foreground">
          <span className="flex items-center gap-1.5"><i className="h-[3px] w-2.5 rounded bg-primary" />Recebidas</span>
          <span className="flex items-center gap-1.5"><i className="h-[3px] w-2.5 rounded bg-success" />Resolvidas</span>
        </div>
      </div>
      {carregando ? (
        <Skeleton className="h-[220px] w-full" />
      ) : dados.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-12">Sem dados no período.</p>
      ) : (
        <div role="img" aria-label={`Conversas por dia, ${rotuloPeriodo}`}>
          <ChartContainer
            config={{
              total: { label: 'Recebidas', color: 'hsl(var(--primary))' },
              resolvidas: { label: 'Resolvidas', color: 'hsl(var(--success))' },
            }}
            className="h-[220px] w-full"
          >
            <ComposedChart data={dados} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="gradRecebidas" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.32} />
                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
              <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} interval="preserveStartEnd" minTickGap={24} />
              <YAxis axisLine={false} tickLine={false} allowDecimals={false} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} width={32} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Area type="monotone" dataKey="total" name="Recebidas" stroke="hsl(var(--primary))" strokeWidth={2.2} fill="url(#gradRecebidas)" />
              <Line type="monotone" dataKey="resolvidas" name="Resolvidas" stroke="hsl(var(--success))" strokeWidth={2.2} dot={false} />
            </ComposedChart>
          </ChartContainer>
        </div>
      )}
    </div>
  );
}

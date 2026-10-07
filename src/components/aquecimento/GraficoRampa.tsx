import { useMemo } from 'react';
import { Area, CartesianGrid, ComposedChart, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { rampaPorDia } from './aquecimentoFormat';

/** A curva é fixa para todos os números; por isso não marca o dia de ninguém. */
export function GraficoRampa() {
  const dados = useMemo(() => rampaPorDia(), []);
  return (
    <div className="rounded-xl border bg-card p-5 flex flex-col gap-3.5">
      <div>
        <h2 className="text-[15px] font-semibold text-foreground">Quantas mensagens por dia</h2>
        <p className="mt-1 text-[12.5px] text-muted-foreground">Começa devagar e sobe até o número aguentar um disparo de verdade.</p>
      </div>
      <div role="img" aria-label="Mensagens por dia: 10 no dia 1, 40 no dia 7, 80 no dia 14, 180 no dia 21, 200 a partir do dia 22">
        <ChartContainer config={{ mensagens: { label: 'Mensagens', color: 'hsl(var(--primary))' } }} className="h-[200px] w-full">
          <ComposedChart data={dados} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gradRampa" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
            <XAxis dataKey="dia" axisLine={false} tickLine={false} ticks={[1, 7, 14, 21, 30]} tickFormatter={(d) => `dia ${d}`} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} />
            <YAxis axisLine={false} tickLine={false} domain={[0, 200]} ticks={[0, 50, 100, 150, 200]} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} width={32} />
            <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => `Dia ${p?.[0]?.payload?.dia ?? ''}`} />} />
            <Area type="monotone" dataKey="mensagens" name="Mensagens" stroke="hsl(var(--primary))" strokeWidth={2.4} fill="url(#gradRampa)" dot={false} />
          </ComposedChart>
        </ChartContainer>
      </div>
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">
        Entre 08h e 20h no horário da conta, com intervalos irregulares, como gente de verdade. Depois do dia 30 o número continua trocando algumas mensagens por dia para não esfriar.
      </p>
    </div>
  );
}

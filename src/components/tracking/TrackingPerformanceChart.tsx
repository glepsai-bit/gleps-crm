/**
 * Evolução diária: investimento (área, eixo esquerdo) × resultados
 * (linhas, eixo direito). É o que mostra se a curva de custo acompanha a de
 * conversas — o sinal que a otimização da Meta está (ou não) funcionando.
 */
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from 'recharts';
import { TrendingUp } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import type { TrackingDailyPoint } from '@/services/tracking.backend.service';
import { brl, brlCompact, shortDay } from './format';

// Três séries só — quatro linhas sobre a mesma área viram ruído, e a cor
// restante do tema (--chart-4) é vermelha, que leria como alerta num gráfico
// de resultado. Reuniões ficam na tabela por anúncio.
const chartConfig = {
  spend: { label: 'Investimento', color: 'hsl(var(--chart-1))' },
  conversations: { label: 'Conversas', color: 'hsl(var(--chart-3))' },
  purchases: { label: 'Vendas', color: 'hsl(var(--chart-2))' },
} satisfies ChartConfig;

interface Props {
  daily: TrackingDailyPoint[];
}

export function TrackingPerformanceChart({ daily }: Props) {
  if (daily.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Evolução diária</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground py-8 text-center">
            Sem dados no período selecionado.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-primary shrink-0" />
          <CardTitle className="text-base">Evolução diária</CardTitle>
        </div>
        <CardDescription>
          Investimento na escala da esquerda, resultados na da direita.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-2 sm:p-4 pt-0">
        <ChartContainer config={chartConfig} className="h-[240px] sm:h-[300px] w-full">
          <ComposedChart data={daily} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="trkSpend" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(var(--chart-1))" stopOpacity={0.35} />
                <stop offset="95%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--chart-grid))" />
            <XAxis
              dataKey="date"
              tickFormatter={shortDay}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
              tickMargin={8}
              minTickGap={16}
            />
            <YAxis
              yAxisId="money"
              tickFormatter={brlCompact}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
              width={52}
            />
            <YAxis
              yAxisId="count"
              orientation="right"
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
              width={30}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(label) => shortDay(String(label))}
                  formatter={(value, name) =>
                    name === 'spend'
                      ? [brl(Number(value)), chartConfig.spend.label]
                      : [
                          String(value),
                          chartConfig[name as keyof typeof chartConfig]?.label ?? String(name),
                        ]
                  }
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            <Area
              yAxisId="money"
              type="monotone"
              dataKey="spend"
              stroke="hsl(var(--chart-1))"
              strokeWidth={2}
              fill="url(#trkSpend)"
            />
            <Line
              yAxisId="count"
              type="monotone"
              dataKey="conversations"
              stroke="hsl(var(--chart-3))"
              strokeWidth={2}
              dot={false}
            />
            <Line
              yAxisId="count"
              type="monotone"
              dataKey="purchases"
              stroke="hsl(var(--chart-2))"
              strokeWidth={2}
              dot={false}
            />
          </ComposedChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

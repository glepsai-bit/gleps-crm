import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { Bar, BarChart, XAxis, YAxis, Cell } from 'recharts';
import { Zap } from 'lucide-react';
import { cn } from '@/lib/utils';

interface VelocityBucket {
  label: string;
  count: number;
  percentage: number;
}

interface ConversionVelocityProps {
  buckets: VelocityBucket[];
  cicloMedio: number;
  fastConversionPercent: number; // % that convert in ≤3 days
}

const chartConfig = {
  count: {
    label: 'Vendas',
    color: 'hsl(var(--primary))',
  },
};

const barColors = [
  'hsl(var(--success))',
  'hsl(var(--primary))',
  'hsl(var(--chart-3))',
  'hsl(var(--warning))',
  'hsl(var(--destructive))',
];

export function ConversionVelocity({ buckets, cicloMedio, fastConversionPercent }: ConversionVelocityProps) {
  const maxCount = Math.max(...buckets.map(b => b.count), 1);

  const hasData = buckets.some(b => b.count > 0);

  if (!hasData) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-lg bg-primary/10">
            <Zap className="w-5 h-5 text-primary" />
          </div>
          <div>
            <CardTitle className="text-base">Velocidade de Conversão</CardTitle>
            <p className="text-xs text-muted-foreground">Tempo entre captação do lead e pagamento</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 gap-3">
          <div className="p-3 rounded-lg bg-primary/5 border border-primary/20">
            <p className="text-xs font-medium text-muted-foreground mb-1">Ciclo Médio</p>
            <p className="text-xl font-bold text-foreground">{cicloMedio.toFixed(1)} dias</p>
          </div>
          <div className="p-3 rounded-lg bg-success/5 border border-success/20">
            <p className="text-xs font-medium text-muted-foreground mb-1">Conversão Rápida</p>
            <p className="text-xl font-bold text-success">{fastConversionPercent.toFixed(0)}%</p>
            <p className="text-[10px] text-muted-foreground">em até 3 dias</p>
          </div>
        </div>

        {/* Horizontal Bar Chart */}
        <ChartContainer config={chartConfig} className="h-[180px] w-full">
          <BarChart
            data={buckets}
            layout="vertical"
            margin={{ top: 0, right: 10, left: 0, bottom: 0 }}
          >
            <XAxis type="number" hide />
            <YAxis
              type="category"
              dataKey="label"
              axisLine={false}
              tickLine={false}
              tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }}
              width={75}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value, _name, item) => [
                    `${value} vendas (${item.payload.percentage.toFixed(0)}%)`,
                    'Conversões',
                  ]}
                />
              }
            />
            <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={24}>
              {buckets.map((_, index) => (
                <Cell key={index} fill={barColors[index % barColors.length]} />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>

        {/* Insight */}
        {fastConversionPercent > 0 && (
          <div className="p-3 rounded-lg bg-muted/50 border">
            <p className="text-xs text-muted-foreground">
              💡 <strong>{fastConversionPercent.toFixed(0)}%</strong> das vendas ocorrem em até 3 dias.
              {fastConversionPercent >= 50
                ? ' Seus leads convertem rápido — mantenha a velocidade de atendimento.'
                : ' Leads que não fecham rápido têm menor chance de converter. Priorize o follow-up nos primeiros dias.'}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

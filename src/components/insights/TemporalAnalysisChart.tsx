import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { Area, AreaChart, XAxis, YAxis, ResponsiveContainer, ReferenceLine } from 'recharts';
import { Calendar, TrendingUp, TrendingDown, Sun, Moon } from 'lucide-react';
import { format, parseISO, getDay } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface DailyData {
  date: string;
  valor: number;
  count: number;
}

interface TemporalAnalysisChartProps {
  dailyData: DailyData[];
  bestDay: { date: string; valor: number } | null;
  worstDay: { date: string; valor: number } | null;
  bestWeekday: { day: string; averageRevenue: number } | null;
  peakHour: { hour: number; count: number } | null;
}

const chartConfig = {
  valor: {
    label: "Receita",
    color: "hsl(var(--primary))",
  },
  media: {
    label: "Média Móvel",
    color: "hsl(var(--muted-foreground))",
  },
};

export function TemporalAnalysisChart({
  dailyData,
  bestDay,
  worstDay,
  bestWeekday,
  peakHour,
}: TemporalAnalysisChartProps) {
  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
      notation: value >= 10000 ? 'compact' : 'standard',
    }).format(value);
  };

  // Calculate 7-day moving average
  const dataWithMovingAverage = dailyData.map((item, index) => {
    const start = Math.max(0, index - 6);
    const slice = dailyData.slice(start, index + 1);
    const average = slice.reduce((sum, d) => sum + d.valor, 0) / slice.length;
    return {
      ...item,
      media: average,
      displayDate: format(parseISO(item.date), 'dd/MM'),
    };
  });

  const averageValue = dailyData.length > 0 
    ? dailyData.reduce((sum, d) => sum + d.valor, 0) / dailyData.length 
    : 0;

  const formatHour = (hour: number) => {
    return `${hour.toString().padStart(2, '0')}:00`;
  };

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-primary/10">
              <Calendar className="w-5 h-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-base">Análise Temporal</CardTitle>
              <p className="text-xs text-muted-foreground">Receita diária e tendências</p>
            </div>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-primary" />
              <span>Receita</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-muted-foreground/50" />
              <span>Média 7d</span>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Insight Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {bestDay && (
            <div className="p-3 rounded-lg bg-success/5 border border-success/20">
              <div className="flex items-center gap-1 mb-1">
                <TrendingUp className="w-3 h-3 text-success" />
                <span className="text-xs font-medium text-success">Melhor Dia</span>
              </div>
              <p className="font-semibold text-sm">{format(parseISO(bestDay.date), 'dd/MM', { locale: ptBR })}</p>
              <p className="text-xs text-muted-foreground">{formatCurrency(bestDay.valor)}</p>
            </div>
          )}
          {worstDay && (
            <div className="p-3 rounded-lg bg-destructive/5 border border-destructive/20">
              <div className="flex items-center gap-1 mb-1">
                <TrendingDown className="w-3 h-3 text-destructive" />
                <span className="text-xs font-medium text-destructive">Menor Dia</span>
              </div>
              <p className="font-semibold text-sm">{format(parseISO(worstDay.date), 'dd/MM', { locale: ptBR })}</p>
              <p className="text-xs text-muted-foreground">{formatCurrency(worstDay.valor)}</p>
            </div>
          )}
          {bestWeekday && (
            <div className="p-3 rounded-lg bg-primary/5 border border-primary/20">
              <div className="flex items-center gap-1 mb-1">
                <Sun className="w-3 h-3 text-primary" />
                <span className="text-xs font-medium text-primary">Melhor Dia Semana</span>
              </div>
              <p className="font-semibold text-sm">{bestWeekday.day}</p>
              <p className="text-xs text-muted-foreground">Média {formatCurrency(bestWeekday.averageRevenue)}</p>
            </div>
          )}
          {peakHour && (
            <div className="p-3 rounded-lg bg-warning/5 border border-warning/20">
              <div className="flex items-center gap-1 mb-1">
                <Moon className="w-3 h-3 text-warning" />
                <span className="text-xs font-medium text-warning">Horário de Pico</span>
              </div>
              <p className="font-semibold text-sm">{formatHour(peakHour.hour)}</p>
              <p className="text-xs text-muted-foreground">{peakHour.count} vendas neste horário</p>
            </div>
          )}
        </div>

        {/* Chart */}
        <ChartContainer config={chartConfig} className="h-[200px] sm:h-[220px] md:h-[250px] w-full">
          <AreaChart data={dataWithMovingAverage} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="colorValor" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis 
              dataKey="displayDate" 
              axisLine={false} 
              tickLine={false}
              tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
              interval="preserveStartEnd"
            />
            <YAxis 
              axisLine={false} 
              tickLine={false}
              tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 9 }}
              tickFormatter={(value) => formatCurrency(value)}
              width={55}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(value) => `Data: ${value}`}
                  formatter={(value, name) => [formatCurrency(value as number), name === 'valor' ? 'Receita' : 'Média 7d']}
                />
              }
            />
            <ReferenceLine 
              y={averageValue} 
              stroke="hsl(var(--muted-foreground))" 
              strokeDasharray="3 3" 
              strokeOpacity={0.5}
            />
            <Area
              type="monotone"
              dataKey="media"
              stroke="hsl(var(--muted-foreground))"
              strokeWidth={1}
              strokeDasharray="4 4"
              fill="none"
            />
            <Area
              type="monotone"
              dataKey="valor"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              fillOpacity={1}
              fill="url(#colorValor)"
            />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { useFinance } from '@/contexts/FinanceContext';
import {
  useFilteredFinanceKPIs,
  type FinanceFilters,
} from '@/hooks/useFilteredFinanceKPIs';
import { TrendingUp } from 'lucide-react';

interface RevenueChartProps {
  isLoading?: boolean;
  /** H-DASH-2: filtros do DashboardFilters (período/canal/agente). */
  filters?: FinanceFilters;
}

// Chart colors from design system (token para adaptar ao tema)
const CHART_GREEN = 'hsl(var(--chart-2))'; // chart-2 - success/revenue

const chartConfig = {
  valor: {
    label: 'Faturamento',
    color: CHART_GREEN,
  },
} satisfies ChartConfig;

export function RevenueChart({ isLoading = false, filters }: RevenueChartProps) {
  const finance = useFinance();
  const filteredKpis = useFilteredFinanceKPIs(
    filters ?? { period: 'all', channel: 'all', type: 'all', agent: 'all' }
  );
  const kpis = filters ? filteredKpis : finance.kpis;

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-5 w-48" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[300px] w-full" />
        </CardContent>
      </Card>
    );
  }

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
      notation: 'compact',
    }).format(value);
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader className="p-3 sm:p-4 pb-2">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 sm:w-5 sm:h-5 shrink-0" style={{ color: CHART_GREEN }} />
          <CardTitle className="text-sm sm:text-base font-semibold text-foreground truncate">
            Evolução do Faturamento
          </CardTitle>
        </div>
        <p className="text-[10px] sm:text-xs text-muted-foreground">Últimos 7 dias</p>
      </CardHeader>
      <CardContent className="p-2 sm:p-4 pt-0">
        <ChartContainer config={chartConfig} className="h-[200px] sm:h-[250px] md:h-[300px] w-full">
          <AreaChart
            data={kpis.faturamentoPorDia}
            margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
          >
            <defs>
              <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={CHART_GREEN} stopOpacity={0.3} />
                <stop offset="95%" stopColor={CHART_GREEN} stopOpacity={0} />
              </linearGradient>
            </defs>
            {/* Grid - token --chart-grid (adapta ao tema) */}
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--chart-grid))" />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
              tickMargin={8}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickFormatter={formatCurrency}
              tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
              width={50}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) => formatCurrency(value as number)}
                />
              }
            />
            <Area
              type="monotone"
              dataKey="valor"
              stroke={CHART_GREEN}
              strokeWidth={2}
              fillOpacity={1}
              fill="url(#colorRevenue)"
            />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
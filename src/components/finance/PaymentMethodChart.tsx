import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
} from '@/components/ui/chart';
import { PieChart, Pie, Cell } from 'recharts';
import { useFinance } from '@/contexts/FinanceContext';
import { CreditCard } from 'lucide-react';
import { PaymentMethod } from '@/types/crm';

interface PaymentMethodChartProps {
  isLoading?: boolean;
}

// Chart colors from design system - fixed palette
const COLORS: Record<PaymentMethod | 'none', string> = {
  pix: '#16A34A',       // chart-2 green
  debito: '#2563EB',    // chart-1 blue
  credito: '#3B82F6',   // blue variant
  boleto: '#F59E0B',    // chart-3 yellow
  dinheiro: '#22C55E',  // green variant
  convenio: '#8B5CF6',  // purple
  none: '#94A3B8',      // muted
};

const LABELS: Record<PaymentMethod | 'none', string> = {
  pix: 'PIX',
  debito: 'Débito',
  credito: 'Crédito',
  boleto: 'Boleto',
  dinheiro: 'Dinheiro',
  convenio: 'Convênio',
  none: 'Não informado',
};

const chartConfig = {
  pix: { label: 'PIX', color: COLORS.pix },
  debito: { label: 'Débito', color: COLORS.debito },
  credito: { label: 'Crédito', color: COLORS.credito },
  boleto: { label: 'Boleto', color: COLORS.boleto },
  dinheiro: { label: 'Dinheiro', color: COLORS.dinheiro },
  convenio: { label: 'Convênio', color: COLORS.convenio },
  none: { label: 'Não informado', color: COLORS.none },
} satisfies ChartConfig;

export function PaymentMethodChart({ isLoading = false }: PaymentMethodChartProps) {
  const { kpis } = useFinance();

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
    }).format(value);
  };

  const data = kpis.porMetodoPagamento.map((item) => ({
    name: LABELS[item.method],
    value: item.valor,
    count: item.count,
    method: item.method,
  }));

  const total = data.reduce((sum, item) => sum + item.value, 0);

  if (data.length === 0) {
    return (
      <Card className="overflow-hidden">
        <CardHeader className="p-3 sm:p-4 pb-2">
          <div className="flex items-center gap-2">
            <CreditCard className="w-4 h-4 sm:w-5 sm:h-5 text-primary shrink-0" />
            <CardTitle className="text-sm sm:text-base font-semibold text-foreground truncate">
              Distribuição por Método
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="p-2 sm:p-4">
          <div className="h-[160px] sm:h-[200px] flex items-center justify-center text-muted-foreground text-sm">
            Nenhuma venda paga no período
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader className="p-3 sm:p-4 pb-2">
        <div className="flex items-center gap-2">
          <CreditCard className="w-4 h-4 sm:w-5 sm:h-5 text-primary shrink-0" />
          <CardTitle className="text-sm sm:text-base font-semibold text-foreground truncate">
            Distribuição por Método
          </CardTitle>
        </div>
        <p className="text-[10px] sm:text-xs text-muted-foreground">Vendas pagas por forma de pagamento</p>
      </CardHeader>
      <CardContent className="p-2 sm:p-4 pt-0">
        <ChartContainer config={chartConfig} className="h-[160px] sm:h-[200px] md:h-[240px] w-full">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius="40%"
              outerRadius="70%"
              paddingAngle={2}
              dataKey="value"
              nameKey="name"
            >
              {data.map((entry, index) => (
                <Cell
                  key={`cell-${index}`}
                  fill={COLORS[entry.method]}
                  stroke="#FFFFFF"
                  strokeWidth={2}
                />
              ))}
            </Pie>
            <ChartTooltip
              content={({ active, payload }) => {
                if (!active || !payload?.[0]) return null;
                const data = payload[0].payload;
                const percentage = total > 0 ? ((data.value / total) * 100).toFixed(1) : 0;
                return (
                  <div className="bg-card border border-border rounded-lg p-2 sm:p-3 shadow-card">
                    <p className="font-medium text-foreground text-sm">{data.name}</p>
                    <p className="text-xs sm:text-sm text-muted-foreground">
                      {formatCurrency(data.value)} ({percentage}%)
                    </p>
                    <p className="text-xs sm:text-sm text-muted-foreground">
                      {data.count} venda{data.count !== 1 ? 's' : ''}
                    </p>
                  </div>
                );
              }}
            />
          </PieChart>
        </ChartContainer>

        {/* Legend - responsive grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 sm:gap-2 mt-2 sm:mt-3">
          {data.map((item) => {
            const percentage = total > 0 ? ((item.value / total) * 100).toFixed(0) : 0;
            return (
              <div key={item.method} className="flex items-center gap-1.5 min-w-0">
                <div
                  className="w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: COLORS[item.method] }}
                />
                <span className="text-[9px] sm:text-[10px] md:text-xs text-foreground truncate">
                  {item.name} ({percentage}%)
                </span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
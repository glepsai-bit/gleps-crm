import { 
  DollarSign, 
  TrendingUp, 
  ShoppingCart, 
  CheckCircle, 
  Clock, 
  XCircle,
  RotateCcw
} from 'lucide-react';
import { KPICard } from '@/components/dashboard/KPICard';
import { useFinance } from '@/contexts/FinanceContext';

interface FinanceKPICardsProps {
  isLoading?: boolean;
}

export function FinanceKPICards({ isLoading = false }: FinanceKPICardsProps) {
  const { kpis } = useFinance();

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value);
  };

  return (
    <div className="kpi-grid-finance">
      <KPICard
        title="Faturamento"
        subtitle="Vendas pagas"
        value={formatCurrency(kpis.faturamentoBruto)}
        icon={DollarSign}
        iconColor="text-success"
        iconBgColor="bg-success/10"
        isLoading={isLoading}
      />
      <KPICard
        title="Ticket Médio"
        subtitle="Média/venda"
        value={formatCurrency(kpis.ticketMedio)}
        icon={TrendingUp}
        iconColor="text-primary"
        iconBgColor="bg-primary/10"
        isLoading={isLoading}
      />
      <KPICard
        title="Total Vendas"
        subtitle="Pagas + Pend."
        value={kpis.totalVendas}
        icon={ShoppingCart}
        iconColor="text-info"
        iconBgColor="bg-info/10"
        isLoading={isLoading}
      />
      <KPICard
        title="Pagas"
        subtitle={formatCurrency(kpis.vendasPagas.valor)}
        value={kpis.vendasPagas.count}
        icon={CheckCircle}
        iconColor="text-success"
        iconBgColor="bg-success/10"
        isLoading={isLoading}
      />
      <KPICard
        title="Pendentes"
        subtitle={formatCurrency(kpis.vendasPendentes.valor)}
        value={kpis.vendasPendentes.count}
        icon={Clock}
        iconColor="text-warning"
        iconBgColor="bg-warning/10"
        isLoading={isLoading}
      />
      <KPICard
        title="Estornadas"
        subtitle={formatCurrency(kpis.vendasEstornadas.valor)}
        value={kpis.vendasEstornadas.count}
        icon={RotateCcw}
        iconColor="text-muted-foreground"
        iconBgColor="bg-muted"
        isLoading={isLoading}
      />
    </div>
  );
}

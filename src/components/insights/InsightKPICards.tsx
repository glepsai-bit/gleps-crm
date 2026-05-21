import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, DollarSign, Target, Users, ShoppingCart } from 'lucide-react';
import { cn } from '@/lib/utils';

interface InsightKPICardsProps {
  faturamento: number;
  ticketMedio: number;
  taxaConversao: number;
  receitaPorLead: number;
  totalLeads: number;
  totalVendas: number;
  previousPeriod?: {
    faturamento: number;
    ticketMedio: number;
    taxaConversao: number;
    receitaPorLead: number;
  };
}

interface KPICardProps {
  title: string;
  value: string;
  subtitle?: string;
  icon: React.ReactNode;
  variation?: number;
  iconBgClass?: string;
}

function KPICard({ title, value, subtitle, icon, variation, iconBgClass = 'bg-primary/10' }: KPICardProps) {
  const hasVariation = variation !== undefined && !isNaN(variation);
  const isPositive = hasVariation && variation >= 0;

  return (
    <Card className="hover:shadow-md transition-shadow min-w-0 w-full h-full">
      <CardContent className="p-3 sm:p-4 h-full">
        <div className="flex items-start justify-between gap-2 h-full">
          <div className="min-w-0 flex-1 space-y-0.5 sm:space-y-1">
            <p className="text-[9px] sm:text-[10px] md:text-xs font-medium uppercase tracking-[0.04em] text-muted-foreground leading-tight">{title}</p>
            <p className="text-lg sm:text-xl md:text-2xl font-semibold text-foreground leading-tight break-words">{value}</p>
            {subtitle && (
              <p className="text-[9px] sm:text-[10px] md:text-xs text-muted-foreground leading-snug break-words">{subtitle}</p>
            )}
            {hasVariation && (
              <Badge 
                variant="outline" 
                className={cn(
                  "mt-2 text-xs font-medium",
                  isPositive 
                    ? "text-success border-success/30 bg-success/10" 
                    : "text-destructive border-destructive/30 bg-destructive/10"
                )}
              >
                {isPositive ? <TrendingUp className="w-3 h-3 mr-1" /> : <TrendingDown className="w-3 h-3 mr-1" />}
                {isPositive ? '+' : ''}{variation.toFixed(1)}%
              </Badge>
            )}
          </div>
          <div className={cn("p-1.5 sm:p-2 rounded-lg shrink-0", iconBgClass)}>
            <div className="[&>svg]:w-3.5 [&>svg]:h-3.5 sm:[&>svg]:w-4 sm:[&>svg]:h-4 md:[&>svg]:w-5 md:[&>svg]:h-5">{icon}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function InsightKPICards({
  faturamento,
  ticketMedio,
  taxaConversao,
  receitaPorLead,
  totalLeads,
  totalVendas,
  previousPeriod,
}: InsightKPICardsProps) {
  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value);
  };

  const calculateVariation = (current: number, previous: number | undefined) => {
    if (!previous || previous === 0) return undefined;
    return ((current - previous) / previous) * 100;
  };

  return (
    <div className="kpi-grid">
      <KPICard
        title="Faturamento"
        value={formatCurrency(faturamento)}
        subtitle={`${totalVendas} venda${totalVendas !== 1 ? 's' : ''} paga${totalVendas !== 1 ? 's' : ''}`}
        icon={<DollarSign className="w-5 h-5 text-success" />}
        iconBgClass="bg-success/10"
        variation={calculateVariation(faturamento, previousPeriod?.faturamento)}
      />
      <KPICard
        title="Ticket Médio"
        value={formatCurrency(ticketMedio)}
        subtitle="Valor médio por venda"
        icon={<ShoppingCart className="w-5 h-5 text-primary" />}
        iconBgClass="bg-primary/10"
        variation={calculateVariation(ticketMedio, previousPeriod?.ticketMedio)}
      />
      <KPICard
        title="Taxa de Conversão"
        value={`${taxaConversao.toFixed(1)}%`}
        subtitle="Lead → Venda paga"
        icon={<Target className="w-5 h-5 text-warning" />}
        iconBgClass="bg-warning/10"
        variation={calculateVariation(taxaConversao, previousPeriod?.taxaConversao)}
      />
      <KPICard
        title="Receita por Lead"
        value={formatCurrency(receitaPorLead)}
        subtitle={`${totalLeads} lead${totalLeads !== 1 ? 's' : ''} no período`}
        icon={<Users className="w-5 h-5 text-secondary-foreground" />}
        iconBgClass="bg-secondary"
        variation={calculateVariation(receitaPorLead, previousPeriod?.receitaPorLead)}
      />
    </div>
  );
}

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Repeat, Clock, Users, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MarketingMetricsProps {
  ltv: number;
  taxaRecorrencia: number;
  cacImplicito: number;
  cicloMedioVenda: number; // in days
  clientesRecorrentes: number;
  totalClientes: number;
}

export function MarketingMetrics({
  ltv,
  taxaRecorrencia,
  cacImplicito,
  cicloMedioVenda,
  clientesRecorrentes,
  totalClientes,
}: MarketingMetricsProps) {
  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value);
  };

  const getRecurrenceLevel = (rate: number) => {
    if (rate >= 30) return { label: 'Excelente', color: 'text-success' };
    if (rate >= 15) return { label: 'Bom', color: 'text-primary' };
    if (rate >= 5) return { label: 'Regular', color: 'text-warning' };
    return { label: 'Baixo', color: 'text-destructive' };
  };

  const getCycleLevel = (days: number) => {
    if (days <= 3) return { label: 'Rápido', color: 'text-success' };
    if (days <= 7) return { label: 'Normal', color: 'text-primary' };
    if (days <= 14) return { label: 'Lento', color: 'text-warning' };
    return { label: 'Muito lento', color: 'text-destructive' };
  };

  const recurrenceLevel = getRecurrenceLevel(taxaRecorrencia);
  const cycleLevel = getCycleLevel(cicloMedioVenda);

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-lg bg-primary/10">
            <TrendingUp className="w-5 h-5 text-primary" />
          </div>
          <div>
            <CardTitle className="text-base">Métricas de Marketing</CardTitle>
            <p className="text-xs text-muted-foreground">Indicadores para estratégia comercial</p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 xs:grid-cols-2 gap-3 sm:gap-4">
          {/* LTV */}
          <div className="p-3 sm:p-4 rounded-lg border bg-card">
            <div className="flex items-center gap-2 mb-2 sm:mb-3">
              <Users className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-primary" />
              <span className="text-[10px] sm:text-xs font-medium text-muted-foreground">LTV Estimado</span>
            </div>
            <p className="text-lg sm:text-xl md:text-2xl font-bold text-primary break-words">{formatCurrency(ltv)}</p>
            <p className="text-[10px] sm:text-xs text-muted-foreground mt-1">
              Valor médio por cliente recorrente
            </p>
          </div>

          {/* CAC Implícito */}
          <div className="p-3 sm:p-4 rounded-lg border bg-card">
            <div className="flex items-center gap-2 mb-2 sm:mb-3">
              <Users className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-warning" />
              <span className="text-[10px] sm:text-xs font-medium text-muted-foreground">CAC Implícito</span>
            </div>
            <p className="text-lg sm:text-xl md:text-2xl font-bold text-foreground">
              {cacImplicito.toFixed(1)} leads
            </p>
            <p className="text-[10px] sm:text-xs text-muted-foreground mt-1">
              Leads necessários para 1 venda
            </p>
          </div>

          {/* Taxa de Recorrência */}
          <div className="p-3 sm:p-4 rounded-lg border bg-card">
            <div className="flex items-center justify-between mb-2 sm:mb-3 gap-2">
              <div className="flex items-center gap-2">
                <Repeat className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-success" />
                <span className="text-[10px] sm:text-xs font-medium text-muted-foreground">Recorrência</span>
              </div>
              <Badge variant="outline" className={cn("text-[10px] sm:text-xs", recurrenceLevel.color)}>
                {recurrenceLevel.label}
              </Badge>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between items-end gap-2">
                <p className="text-lg sm:text-xl md:text-2xl font-bold">{taxaRecorrencia.toFixed(1)}%</p>
                <p className="text-[10px] sm:text-xs text-muted-foreground">
                  {clientesRecorrentes}/{totalClientes}
                </p>
              </div>
              <Progress value={taxaRecorrencia} className="h-2" />
            </div>
          </div>

          {/* Ciclo Médio de Venda */}
          <div className="p-3 sm:p-4 rounded-lg border bg-card">
            <div className="flex items-center justify-between mb-2 sm:mb-3 gap-2">
              <div className="flex items-center gap-2">
                <Clock className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-secondary-foreground" />
                <span className="text-[10px] sm:text-xs font-medium text-muted-foreground">Ciclo de Venda</span>
              </div>
              <Badge variant="outline" className={cn("text-[10px] sm:text-xs", cycleLevel.color)}>
                {cycleLevel.label}
              </Badge>
            </div>
            <p className="text-lg sm:text-xl md:text-2xl font-bold text-foreground">
              {cicloMedioVenda.toFixed(1)} dias
            </p>
            <p className="text-[10px] sm:text-xs text-muted-foreground mt-1">
              Lead → Pagamento
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

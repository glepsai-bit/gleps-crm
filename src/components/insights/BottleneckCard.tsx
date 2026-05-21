import { Card, CardContent } from '@/components/ui/card';
import { AlertTriangle, TrendingUp, ShoppingCart, Rocket } from 'lucide-react';
import { cn } from '@/lib/utils';

interface BottleneckCardProps {
  totalLeads: number;
  taxaConversao: number;
  ticketMedio: number;
  receitaPorLead: number;
}

type BottleneckType = 'captacao' | 'fechamento' | 'mix' | 'escala';

interface BottleneckInfo {
  type: BottleneckType;
  label: string;
  description: string;
  recommendation: string;
  severity: 'error' | 'warning' | 'success';
}

function detectBottleneck(props: BottleneckCardProps): BottleneckInfo {
  const { totalLeads, taxaConversao, ticketMedio, receitaPorLead } = props;

  if (totalLeads < 10) {
    return {
      type: 'captacao',
      label: 'Captação',
      description: 'Poucos leads no funil.',
      recommendation: 'Invista em canais de aquisição como tráfego pago, indicações e parcerias.',
      severity: 'error',
    };
  }

  if (taxaConversao < 15) {
    return {
      type: 'fechamento',
      label: 'Fechamento',
      description: 'Leads não estão convertendo em vendas.',
      recommendation: 'Revise argumentação comercial, velocidade de resposta e follow-up.',
      severity: 'error',
    };
  }

  if (taxaConversao > 25 && receitaPorLead > 0 && ticketMedio < receitaPorLead * 0.8) {
    return {
      type: 'mix',
      label: 'Mix de Produto',
      description: 'Conversão boa, mas valor por venda abaixo do potencial.',
      recommendation: 'Priorize produtos premium, combos e upsell para aumentar o ticket.',
      severity: 'warning',
    };
  }

  return {
    type: 'escala',
    label: 'Escala',
    description: 'Processo comercial saudável.',
    recommendation: 'Aumente o volume de leads para escalar receita com a mesma eficiência.',
    severity: 'success',
  };
}

const iconMap = {
  captacao: AlertTriangle,
  fechamento: AlertTriangle,
  mix: ShoppingCart,
  escala: Rocket,
};

const colorMap = {
  error: {
    bg: 'bg-destructive/5 border-destructive/20',
    icon: 'bg-destructive/10 text-destructive',
    label: 'text-destructive',
  },
  warning: {
    bg: 'bg-warning/5 border-warning/20',
    icon: 'bg-warning/10 text-warning',
    label: 'text-warning',
  },
  success: {
    bg: 'bg-success/5 border-success/20',
    icon: 'bg-success/10 text-success',
    label: 'text-success',
  },
};

export function BottleneckCard(props: BottleneckCardProps) {
  const bottleneck = detectBottleneck(props);
  const Icon = iconMap[bottleneck.type];
  const colors = colorMap[bottleneck.severity];

  return (
    <Card className={cn('border', colors.bg)}>
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-start gap-3 sm:gap-4">
          <div className={cn('p-2.5 rounded-lg shrink-0', colors.icon)}>
            <Icon className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] sm:text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Gargalo Identificado
              </span>
              <span className={cn('text-xs sm:text-sm font-bold', colors.label)}>
                {bottleneck.label}
              </span>
            </div>
            <p className="text-sm font-medium text-foreground">{bottleneck.description}</p>
            <p className="text-xs text-muted-foreground mt-1">{bottleneck.recommendation}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Bot, User, HelpCircle, ArrowRightLeft, TrendingUp } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { ResolucaoMetrics, TaxasMetrics } from '@/types/chatwoot-metrics';

interface ResolucaoCardProps {
  resolucao: ResolucaoMetrics;
  taxas: TaxasMetrics;
  isLoading?: boolean;
}

// Chart colors from design system
const CHART_BLUE = '#2563EB';  // IA
const CHART_GREEN = '#16A34A'; // Humano
const CHART_MUTED = '#6B7280'; // Não classificado

export function ResolucaoCard({
  resolucao,
  taxas,
  isLoading = false,
}: ResolucaoCardProps) {
  const [hoveredSegment, setHoveredSegment] = useState<'ia' | 'humano' | null>(null);

  // Safe defaults
  const safeResolucao = resolucao ?? {
    total: 0,
    ia: { total: 0, explicito: 0, botNativo: 0, inferido: 0 },
    humano: { total: 0, explicito: 0, inferido: 0 },
    naoClassificado: 0,
    transbordoFinalizado: 0,
  };
  
  const safeTaxas = taxas ?? {
    resolucaoIA: '0%',
    resolucaoHumano: '0%',
    transbordo: '0%',
    eficienciaIA: '0%',
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-5 w-32" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-32 w-32 rounded-full mx-auto" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  const totalClassificado = safeResolucao.ia.total + safeResolucao.humano.total;
  const percentIA = totalClassificado > 0 
    ? Math.round((safeResolucao.ia.total / totalClassificado) * 100) 
    : 0;
  const percentHumano = totalClassificado > 0 ? 100 - percentIA : 0;

  const displayValue = hoveredSegment === 'ia' 
    ? percentIA 
    : hoveredSegment === 'humano' 
    ? percentHumano 
    : percentIA;
  
  const displayLabel = hoveredSegment === 'humano' ? 'Humano' : 'IA';
  const displayColor = hoveredSegment === 'humano' ? CHART_GREEN : CHART_BLUE;

  // Calculate methodology breakdown
  const totalExplicito = safeResolucao.ia.explicito + safeResolucao.humano.explicito;
  const percentExplicito = safeResolucao.total > 0 
    ? Math.round((totalExplicito / safeResolucao.total) * 100) 
    : 0;

  return (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Resolução (Quem Fechou)
          </CardTitle>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger>
                <Badge variant="outline" className="text-xs font-normal">
                  <TrendingUp className="w-3 h-3 mr-1" />
                  Histórico
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-xs">Baseado em {safeResolucao.total} conversas resolvidas</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-4">
          Quem resolveu as conversas no período?
        </p>

        <div className="flex flex-col sm:flex-row items-center gap-4 sm:gap-6">
          {/* Donut Chart */}
          <div className="relative w-24 h-24 sm:w-28 sm:h-28 shrink-0">
            <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
              {/* Background circle */}
              <circle
                cx="50"
                cy="50"
                r="40"
                fill="none"
                stroke="#E5E7EB"
                strokeWidth="14"
              />
              {/* IA segment - Blue */}
              <circle
                cx="50"
                cy="50"
                r="40"
                fill="none"
                stroke={CHART_BLUE}
                strokeWidth={hoveredSegment === 'ia' ? 18 : 14}
                strokeDasharray={`${(percentIA / 100) * 251.2} 251.2`}
                className={cn(
                  "transition-all duration-300 cursor-pointer",
                  hoveredSegment === 'ia' && "drop-shadow-lg"
                )}
                style={{
                  filter: hoveredSegment === 'ia' ? 'brightness(1.1)' : 'none',
                }}
                onMouseEnter={() => setHoveredSegment('ia')}
                onMouseLeave={() => setHoveredSegment(null)}
              />
              {/* Human segment - Green */}
              <circle
                cx="50"
                cy="50"
                r="40"
                fill="none"
                stroke={CHART_GREEN}
                strokeWidth={hoveredSegment === 'humano' ? 18 : 14}
                strokeDasharray={`${(percentHumano / 100) * 251.2} 251.2`}
                strokeDashoffset={`-${(percentIA / 100) * 251.2}`}
                className={cn(
                  "transition-all duration-300 cursor-pointer",
                  hoveredSegment === 'humano' && "drop-shadow-lg"
                )}
                style={{
                  filter: hoveredSegment === 'humano' ? 'brightness(1.1)' : 'none',
                }}
                onMouseEnter={() => setHoveredSegment('humano')}
                onMouseLeave={() => setHoveredSegment(null)}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center transition-all duration-200">
                <p 
                  className="text-lg sm:text-xl font-bold transition-all duration-200"
                  style={{ color: displayColor }}
                >
                  {displayValue}%
                </p>
                <p className="text-[10px] text-muted-foreground">{displayLabel}</p>
              </div>
            </div>
          </div>

          {/* Legend - Responsive layout */}
          <div className="flex flex-col gap-2 sm:gap-3 flex-1 w-full min-w-0">
            <div 
              className={cn(
                "flex items-center gap-2 sm:gap-3 p-2 rounded-lg transition-all duration-200 cursor-pointer",
                hoveredSegment === 'ia' ? 'bg-primary/10 scale-105' : 'hover:bg-muted'
              )}
              onMouseEnter={() => setHoveredSegment('ia')}
              onMouseLeave={() => setHoveredSegment(null)}
            >
              <div className={cn(
                "p-1.5 sm:p-2 rounded-lg transition-all duration-200 shrink-0",
                hoveredSegment === 'ia' ? "bg-primary/20" : "bg-primary/10"
              )}>
                <Bot className="w-3 h-3 sm:w-4 sm:h-4" style={{ color: CHART_BLUE }} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs sm:text-sm font-medium text-foreground">IA</p>
                <p className="text-[10px] sm:text-xs text-muted-foreground truncate">
                  {safeResolucao.ia.total} resolvidas
                </p>
              </div>
              <span 
                className={cn(
                  "text-base sm:text-lg font-bold transition-all duration-200 shrink-0",
                  hoveredSegment === 'ia' && 'scale-110'
                )}
                style={{ color: CHART_BLUE }}
              >
                {percentIA}%
              </span>
            </div>
            
            <div 
              className={cn(
                "flex items-center gap-2 sm:gap-3 p-2 rounded-lg transition-all duration-200 cursor-pointer",
                hoveredSegment === 'humano' ? 'bg-success/10 scale-105' : 'hover:bg-muted'
              )}
              onMouseEnter={() => setHoveredSegment('humano')}
              onMouseLeave={() => setHoveredSegment(null)}
            >
              <div className={cn(
                "p-1.5 sm:p-2 rounded-lg transition-all duration-200 shrink-0",
                hoveredSegment === 'humano' ? "bg-success/20" : "bg-success/10"
              )}>
                <User className="w-3 h-3 sm:w-4 sm:h-4" style={{ color: CHART_GREEN }} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs sm:text-sm font-medium text-foreground">Humano</p>
                <p className="text-[10px] sm:text-xs text-muted-foreground truncate">
                  {safeResolucao.humano.total} resolvidas
                </p>
              </div>
              <span 
                className={cn(
                  "text-base sm:text-lg font-bold transition-all duration-200 shrink-0",
                  hoveredSegment === 'humano' && 'scale-110'
                )}
                style={{ color: CHART_GREEN }}
              >
                {percentHumano}%
              </span>
            </div>
          </div>
        </div>

        {/* Transbordo finalizado + Eficiência */}
        <div className="mt-4 pt-3 border-t border-border space-y-2">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <ArrowRightLeft className="w-3 h-3" />
              <span>Transbordo finalizado</span>
            </div>
            <span className="font-medium">{safeResolucao.transbordoFinalizado}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <TrendingUp className="w-3 h-3" />
              <span>Eficiência da IA</span>
            </div>
            <span className="font-medium text-primary">{safeTaxas.eficienciaIA}</span>
          </div>
          
          {/* Methodology indicator */}
          {safeResolucao.naoClassificado > 0 && (
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mt-2">
              <HelpCircle className="w-3 h-3" />
              <span>{safeResolucao.naoClassificado} sem classificação ({percentExplicito}% explícito via n8n)</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Bot, User } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface IAvsHumanCardProps {
  percentualIA: number;
  percentualHumano: number;
  isLoading?: boolean;
}

// Chart colors from design system
const CHART_BLUE = '#2563EB';  // chart-1 - IA
const CHART_GREEN = '#16A34A'; // chart-2 - Humano

export function IAvsHumanCard({
  percentualIA,
  percentualHumano,
  isLoading = false,
}: IAvsHumanCardProps) {
  const [hoveredSegment, setHoveredSegment] = useState<'ia' | 'humano' | null>(null);

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

  const displayValue = hoveredSegment === 'ia' 
    ? percentualIA 
    : hoveredSegment === 'humano' 
    ? percentualHumano 
    : percentualIA;
  
  const displayLabel = hoveredSegment === 'humano' ? 'Humano' : 'IA';
  const displayColor = hoveredSegment === 'humano' ? CHART_GREEN : CHART_BLUE;

  return (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          IA vs Humano
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-4">
          Distribuição de atendimentos
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
                strokeDasharray={`${(percentualIA / 100) * 251.2} 251.2`}
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
                strokeDasharray={`${(percentualHumano / 100) * 251.2} 251.2`}
                strokeDashoffset={`-${(percentualIA / 100) * 251.2}`}
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
                <p className="text-[10px] sm:text-xs text-muted-foreground truncate">Atendimento automatizado</p>
              </div>
              <span 
                className={cn(
                  "text-base sm:text-lg font-bold transition-all duration-200 shrink-0",
                  hoveredSegment === 'ia' && 'scale-110'
                )}
                style={{ color: CHART_BLUE }}
              >
                {percentualIA}%
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
                <p className="text-[10px] sm:text-xs text-muted-foreground truncate">Atendimento por agentes</p>
              </div>
              <span 
                className={cn(
                  "text-base sm:text-lg font-bold transition-all duration-200 shrink-0",
                  hoveredSegment === 'humano' && 'scale-110'
                )}
                style={{ color: CHART_GREEN }}
              >
                {percentualHumano}%
              </span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
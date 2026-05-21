import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Bot, User, Clock, MessageCircle } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { AtendimentoMetrics } from '@/types/chatwoot-metrics';

interface AtendimentoRealtimeCardProps {
  data: AtendimentoMetrics;
  isLoading?: boolean;
}

// Chart colors from design system
const CHART_BLUE = '#2563EB';  // IA
const CHART_GREEN = '#16A34A'; // Humano
const CHART_MUTED = '#6B7280'; // Sem Assignee

export function AtendimentoRealtimeCard({
  data,
  isLoading = false,
}: AtendimentoRealtimeCardProps) {
  // Safe defaults
  const safeData = data ?? {
    total: 0,
    ia: 0,
    humano: 0,
    semAssignee: 0,
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-5 w-40" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-8 w-full" />
          <div className="grid grid-cols-3 gap-4">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        </CardContent>
      </Card>
    );
  }

  const total = safeData.total || 1; // Avoid division by zero
  const percentIA = Math.round((safeData.ia / total) * 100);
  const percentHumano = Math.round((safeData.humano / total) * 100);
  const percentSemAssignee = 100 - percentIA - percentHumano;

  return (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Atendimento ao Vivo
          </CardTitle>
          <Badge variant="outline" className="text-xs font-normal">
            <Clock className="w-3 h-3 mr-1" />
            Tempo Real
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Quem está atendendo agora? ({safeData.total} conversas abertas)
        </p>

        {/* Stacked Progress Bar */}
        <div className="relative h-6 rounded-full overflow-hidden bg-muted">
          {safeData.total > 0 ? (
            <div className="flex h-full">
              {/* IA Segment */}
              <div 
                className="h-full transition-all duration-500 flex items-center justify-center"
                style={{ 
                  width: `${percentIA}%`, 
                  backgroundColor: CHART_BLUE,
                }}
              >
                {percentIA >= 15 && (
                  <span className="text-[10px] font-medium text-white">
                    {percentIA}%
                  </span>
                )}
              </div>
              {/* Humano Segment */}
              <div 
                className="h-full transition-all duration-500 flex items-center justify-center"
                style={{ 
                  width: `${percentHumano}%`, 
                  backgroundColor: CHART_GREEN,
                }}
              >
                {percentHumano >= 15 && (
                  <span className="text-[10px] font-medium text-white">
                    {percentHumano}%
                  </span>
                )}
              </div>
              {/* Sem Assignee Segment */}
              <div 
                className="h-full transition-all duration-500 flex items-center justify-center"
                style={{ 
                  width: `${percentSemAssignee}%`, 
                  backgroundColor: CHART_MUTED,
                }}
              >
                {percentSemAssignee >= 15 && (
                  <span className="text-[10px] font-medium text-white">
                    {percentSemAssignee}%
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
              Nenhuma conversa aberta
            </div>
          )}
        </div>

        {/* Legend with counts */}
        <div className="grid grid-cols-3 gap-2">
          {/* IA */}
          <div className="flex flex-col items-center p-2 rounded-lg bg-muted/50">
            <div 
              className="p-1.5 rounded-full mb-1"
              style={{ backgroundColor: `${CHART_BLUE}20` }}
            >
              <Bot className="w-4 h-4" style={{ color: CHART_BLUE }} />
            </div>
            <span className="text-lg font-bold" style={{ color: CHART_BLUE }}>
              {safeData.ia}
            </span>
            <span className="text-[10px] text-muted-foreground">IA</span>
          </div>
          
          {/* Humano */}
          <div className="flex flex-col items-center p-2 rounded-lg bg-muted/50">
            <div 
              className="p-1.5 rounded-full mb-1"
              style={{ backgroundColor: `${CHART_GREEN}20` }}
            >
              <User className="w-4 h-4" style={{ color: CHART_GREEN }} />
            </div>
            <span className="text-lg font-bold" style={{ color: CHART_GREEN }}>
              {safeData.humano}
            </span>
            <span className="text-[10px] text-muted-foreground">Humano</span>
          </div>
          
          {/* Aguardando */}
          <div className="flex flex-col items-center p-2 rounded-lg bg-muted/50">
            <div 
              className="p-1.5 rounded-full mb-1"
              style={{ backgroundColor: `${CHART_MUTED}20` }}
            >
              <MessageCircle className="w-4 h-4" style={{ color: CHART_MUTED }} />
            </div>
            <span className="text-lg font-bold" style={{ color: CHART_MUTED }}>
              {safeData.semAssignee}
            </span>
            <span className="text-[10px] text-muted-foreground">Em Aberto</span>
          </div>
        </div>

      </CardContent>
    </Card>
  );
}

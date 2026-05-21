import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Lightbulb, TrendingUp, TrendingDown, AlertCircle, Sparkles, Target } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface Insight {
  id: string;
  type: 'success' | 'warning' | 'opportunity' | 'info';
  title: string;
  description: string;
  metric?: string;
}

interface AutomaticInsightsProps {
  insights: Insight[];
}

export function AutomaticInsights({ insights }: AutomaticInsightsProps) {
  const getInsightIcon = (type: Insight['type']) => {
    switch (type) {
      case 'success':
        return <TrendingUp className="w-4 h-4" />;
      case 'warning':
        return <AlertCircle className="w-4 h-4" />;
      case 'opportunity':
        return <Sparkles className="w-4 h-4" />;
      default:
        return <Target className="w-4 h-4" />;
    }
  };

  const getInsightStyles = (type: Insight['type']) => {
    switch (type) {
      case 'success':
        return {
          bg: 'bg-success/5 border-success/20',
          icon: 'text-success',
          badge: 'bg-success/10 text-success border-success/30',
        };
      case 'warning':
        return {
          bg: 'bg-warning/5 border-warning/20',
          icon: 'text-warning',
          badge: 'bg-warning/10 text-warning border-warning/30',
        };
      case 'opportunity':
        return {
          bg: 'bg-primary/5 border-primary/20',
          icon: 'text-primary',
          badge: 'bg-primary/10 text-primary border-primary/30',
        };
      default:
        return {
          bg: 'bg-secondary border-border',
          icon: 'text-muted-foreground',
          badge: 'bg-secondary text-muted-foreground border-border',
        };
    }
  };

  const getInsightLabel = (type: Insight['type']) => {
    switch (type) {
      case 'success':
        return 'Destaque';
      case 'warning':
        return 'Atenção';
      case 'opportunity':
        return 'Oportunidade';
      default:
        return 'Insight';
    }
  };

  if (insights.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-lg bg-warning/10">
            <Lightbulb className="w-5 h-5 text-warning" />
          </div>
          <div>
            <CardTitle className="text-base">Insights Automáticos</CardTitle>
            <p className="text-xs text-muted-foreground">Oportunidades identificadas nos seus dados</p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {insights.map((insight) => {
            const styles = getInsightStyles(insight.type);
            return (
              <div
                key={insight.id}
                className={cn(
                  "p-4 rounded-lg border transition-colors hover:bg-accent/5",
                  styles.bg
                )}
              >
                <div className="flex items-start gap-3">
                  <div className={cn("mt-0.5", styles.icon)}>
                    {getInsightIcon(insight.type)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <Badge variant="outline" className={cn("text-xs", styles.badge)}>
                        {getInsightLabel(insight.type)}
                      </Badge>
                      {insight.metric && (
                        <span className="text-xs font-medium text-foreground">{insight.metric}</span>
                      )}
                    </div>
                    <p className="font-medium text-sm text-foreground">{insight.title}</p>
                    <p className="text-xs text-muted-foreground mt-1">{insight.description}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

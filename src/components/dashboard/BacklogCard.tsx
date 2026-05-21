import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Clock, AlertTriangle, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface BacklogData {
  ate15min: number;
  de15a60min: number;
  acima60min: number;
}

interface BacklogCardProps {
  data: BacklogData;
  isLoading?: boolean;
}

// Chart colors from design system
const CHART_GREEN = '#16A34A';  // chart-2 - success
const CHART_YELLOW = '#F59E0B'; // chart-3 - warning  
const CHART_RED = '#DC2626';    // chart-4 - danger

export function BacklogCard({ data, isLoading = false }: BacklogCardProps) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-48" />
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  const total = data.ate15min + data.de15a60min + data.acima60min;

  const backlogItems = [
    {
      label: 'Até 15 minutos',
      value: data.ate15min,
      percentage: total > 0 ? (data.ate15min / total) * 100 : 0,
      icon: Clock,
      color: CHART_GREEN,
      bgColor: 'bg-success-soft',
    },
    {
      label: '15 a 60 minutos',
      value: data.de15a60min,
      percentage: total > 0 ? (data.de15a60min / total) * 100 : 0,
      icon: AlertTriangle,
      color: CHART_YELLOW,
      bgColor: 'bg-warning-soft',
    },
    {
      label: 'Acima de 60 minutos',
      value: data.acima60min,
      percentage: total > 0 ? (data.acima60min / total) * 100 : 0,
      icon: AlertCircle,
      color: CHART_RED,
      bgColor: 'bg-destructive-soft',
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Backlog Humano
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {backlogItems.map((item) => (
            <div
              key={item.label}
              className={cn('p-4 rounded-lg', item.bgColor)}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <item.icon className="w-4 h-4" style={{ color: item.color }} />
                  <span className="text-sm font-medium text-foreground">{item.label}</span>
                </div>
                <span className="text-lg font-bold text-foreground">{item.value}</span>
              </div>
              <div className="h-2 bg-white/50 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${item.percentage}%`, backgroundColor: item.color }}
                />
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
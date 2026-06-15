import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Clock, AlertTriangle, AlertCircle, Inbox } from 'lucide-react';
import { cn } from '@/lib/utils';

interface BacklogBuckets {
  ate15min: number;
  de15a60min: number;
  acima60min: number;
}

interface BacklogData extends BacklogBuckets {
  // Conversas sem nenhum assignee (nem bot, nem humano).
  // Opcional pra retrocompatibilidade com payloads antigos.
  naoAtribuidas?: BacklogBuckets;
}

interface BacklogCardProps {
  data: BacklogData;
  isLoading?: boolean;
}

// Chart colors from design system
const CHART_GREEN = '#16A34A';  // chart-2 - success
const CHART_YELLOW = '#F59E0B'; // chart-3 - warning
const CHART_RED = '#DC2626';    // chart-4 - danger

function buildBacklogItems(buckets: BacklogBuckets) {
  const total = buckets.ate15min + buckets.de15a60min + buckets.acima60min;
  return [
    {
      label: 'Até 15 minutos',
      value: buckets.ate15min,
      percentage: total > 0 ? (buckets.ate15min / total) * 100 : 0,
      icon: Clock,
      color: CHART_GREEN,
      bgColor: 'bg-success-soft',
    },
    {
      label: '15 a 60 minutos',
      value: buckets.de15a60min,
      percentage: total > 0 ? (buckets.de15a60min / total) * 100 : 0,
      icon: AlertTriangle,
      color: CHART_YELLOW,
      bgColor: 'bg-warning-soft',
    },
    {
      label: 'Acima de 60 minutos',
      value: buckets.acima60min,
      percentage: total > 0 ? (buckets.acima60min / total) * 100 : 0,
      icon: AlertCircle,
      color: CHART_RED,
      bgColor: 'bg-destructive-soft',
    },
  ];
}

function BacklogSection({
  items,
}: {
  items: ReturnType<typeof buildBacklogItems>;
}) {
  return (
    <div className="space-y-3">
      {items.map((item) => (
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
          <div className="h-2 bg-foreground/10 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${item.percentage}%`, backgroundColor: item.color }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

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

  const humanoItems = buildBacklogItems(data);
  const naoAtribuidas = data.naoAtribuidas;
  const naoAtribuidasTotal = naoAtribuidas
    ? naoAtribuidas.ate15min + naoAtribuidas.de15a60min + naoAtribuidas.acima60min
    : 0;
  const naoAtribuidasItems = naoAtribuidas ? buildBacklogItems(naoAtribuidas) : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Backlog Humano
        </CardTitle>
      </CardHeader>
      <CardContent>
        <BacklogSection items={humanoItems} />

        {naoAtribuidasItems && (
          <div className="mt-6 pt-4 border-t border-border">
            <div className="flex items-center gap-2 mb-3">
              <Inbox className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium text-muted-foreground">
                Não atribuídas
              </span>
              <span className="text-xs text-muted-foreground ml-auto">
                {naoAtribuidasTotal} aguardando atendente
              </span>
            </div>
            <BacklogSection items={naoAtribuidasItems} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
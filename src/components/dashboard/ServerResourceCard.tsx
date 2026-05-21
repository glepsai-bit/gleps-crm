import { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface ServerResourceCardProps {
  title: string;
  value: string;
  subtitle?: string;
  percent?: number;
  icon: LucideIcon;
  iconColor?: string;
  iconBgColor?: string;
  isLoading?: boolean;
  className?: string;
}

function getProgressColor(percent: number): string {
  if (percent >= 90) return 'bg-destructive';
  if (percent >= 75) return 'bg-warning';
  return 'bg-primary';
}

export function ServerResourceCard({
  title,
  value,
  subtitle,
  percent,
  icon: Icon,
  iconColor = 'text-primary',
  iconBgColor = 'bg-primary/10',
  isLoading = false,
  className,
}: ServerResourceCardProps) {
  if (isLoading) {
    return (
      <Card className={cn(className)}>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between">
            <div className="space-y-2 flex-1">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-6 w-24" />
            </div>
            <Skeleton className="h-8 w-8 rounded-lg" />
          </div>
          <Skeleton className="h-2 w-full rounded-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn('min-w-0 w-full', className)}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {title}
            </p>
            <p className="text-lg sm:text-xl font-bold text-foreground leading-tight mt-1">
              {value}
            </p>
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
            )}
          </div>
          <div className={cn('p-1.5 rounded-lg shrink-0', iconBgColor)}>
            <Icon className={cn('w-4 h-4', iconColor)} />
          </div>
        </div>
        {percent !== undefined && (
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>Uso</span>
              <span>{percent}%</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all', getProgressColor(percent))}
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

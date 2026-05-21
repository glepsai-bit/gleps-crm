import { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface KPICardProps {
  title: string;
  subtitle?: string;
  value: string | number;
  icon: LucideIcon;
  iconColor?: string;
  iconBgColor?: string;
  isLoading?: boolean;
  className?: string;
  trend?: {
    value: number;
    isPositive: boolean;
  };
}

export function KPICard({
  title,
  subtitle,
  value,
  icon: Icon,
  iconColor = 'text-primary',
  iconBgColor = 'bg-primary/10',
  isLoading = false,
  className,
  trend,
}: KPICardProps) {
  if (isLoading) {
    return (
      <Card className={cn(className)}>
        <CardContent className="space-y-3">
          <div className="flex items-start justify-between">
            <div className="space-y-2 flex-1">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-8 w-20" />
              <Skeleton className="h-3 w-32" />
            </div>
            <Skeleton className="h-10 w-10 rounded-lg" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn('min-w-0 w-full h-full overflow-hidden p-0', className)}>
      <CardContent className="p-4 sm:p-5 h-full flex flex-col justify-between gap-3">
        {/* Header: label + icon */}
        <div className="flex items-start justify-between gap-2">
          <p className="flex-1 min-w-0 overflow-hidden text-ellipsis text-[9px] sm:text-[10px] font-semibold uppercase tracking-wide text-muted-foreground leading-tight">
            {title}
          </p>
          <div className={cn('p-1 sm:p-1.5 rounded-lg shrink-0', iconBgColor)}>
            <Icon className={cn('w-3.5 h-3.5 sm:w-4 sm:h-4', iconColor)} />
          </div>
        </div>
        {/* Value */}
        <div className="space-y-0.5">
          <p className="text-2xl sm:text-3xl font-bold text-foreground leading-none tabular-nums">
            {value}
          </p>
          {subtitle && (
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          )}
          {trend && (
            <p
              className={cn(
                'text-xs font-medium',
                trend.isPositive ? 'text-success' : 'text-destructive'
              )}
            >
              {trend.isPositive ? '↑' : '↓'} {Math.abs(trend.value)}%
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
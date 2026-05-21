import { RefreshCw, Check, AlertCircle, Pause } from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';

interface SyncIndicatorProps {
  isSyncing: boolean;
  lastSyncAt: string | null;
  error?: Error | null;
  isTabActive?: boolean;
  onManualSync?: () => void;
  className?: string;
  showLabel?: boolean;
  size?: 'sm' | 'md';
}

export function SyncIndicator({ 
  isSyncing, 
  lastSyncAt, 
  error, 
  isTabActive = true,
  onManualSync,
  className,
  showLabel = true,
  size = 'sm',
}: SyncIndicatorProps) {
  const iconSize = size === 'sm' ? 'w-4 h-4' : 'w-5 h-5';
  
  const getStatusIcon = () => {
    if (error) {
      return <AlertCircle className={cn(iconSize, "text-destructive")} />;
    }
    if (!isTabActive) {
      return <Pause className={cn(iconSize, "text-muted-foreground")} />;
    }
    if (isSyncing) {
      return <RefreshCw className={cn(iconSize, "text-muted-foreground animate-spin")} />;
    }
    return <Check className={cn(iconSize, "text-success")} />;
  };

  const getStatusText = () => {
    if (error) {
      return 'Erro na sincronização';
    }
    if (!isTabActive) {
      return 'Sincronização pausada (aba inativa)';
    }
    if (isSyncing) {
      return 'Sincronizando...';
    }
    if (lastSyncAt) {
      return `Atualizado ${format(new Date(lastSyncAt), "HH:mm", { locale: ptBR })}`;
    }
    return 'Sincronizado';
  };

  const getShortLabel = () => {
    if (!isTabActive) return 'Pausado';
    if (isSyncing) return 'Sincronizando';
    return 'Atualizado';
  };

  const getBackgroundColor = () => {
    if (error) return 'bg-destructive/10';
    if (!isTabActive) return 'bg-muted/50';
    if (isSyncing) return 'bg-muted/50';
    return 'bg-success/10';
  };

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div 
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 rounded-md transition-all duration-300",
              getBackgroundColor(),
              onManualSync && "cursor-pointer hover:opacity-80",
              className
            )}
            onClick={onManualSync}
            role={onManualSync ? 'button' : undefined}
          >
            {getStatusIcon()}
            {showLabel && (
              <span className="text-xs text-muted-foreground hidden sm:inline">
                {getShortLabel()}
              </span>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="flex flex-col gap-1">
          <p>{getStatusText()}</p>
          {onManualSync && !isSyncing && (
            <p className="text-xs text-muted-foreground">Clique para atualizar</p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// Variant with manual refresh button
interface SyncIndicatorWithButtonProps extends Omit<SyncIndicatorProps, 'onManualSync'> {
  onRefresh: () => void;
  refreshLabel?: string;
}

export function SyncIndicatorWithButton({
  isSyncing,
  lastSyncAt,
  error,
  isTabActive = true,
  onRefresh,
  refreshLabel = 'Atualizar',
  className,
}: SyncIndicatorWithButtonProps) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <SyncIndicator
        isSyncing={isSyncing}
        lastSyncAt={lastSyncAt}
        error={error}
        isTabActive={isTabActive}
        showLabel={true}
      />
      <Button
        variant="outline"
        size="sm"
        onClick={onRefresh}
        disabled={isSyncing}
        className="h-7 text-xs"
      >
        <RefreshCw className={cn("w-3 h-3 mr-1", isSyncing && "animate-spin")} />
        {refreshLabel}
      </Button>
    </div>
  );
}

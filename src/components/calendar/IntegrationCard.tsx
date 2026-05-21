import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Check, AlertCircle, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

export type IntegrationStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'coming_soon';

interface ConnectedInfo {
  identifier: string;
  connectedAt: string;
  lastSync?: string;
}

interface IntegrationCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  status: IntegrationStatus;
  connectedInfo?: ConnectedInfo;
  errorMessage?: string;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onConfigure?: () => void;
  onReconnect?: () => void;
  onSync?: () => void;
  isSyncing?: boolean;
}

export function IntegrationCard({
  icon,
  title,
  description,
  status,
  connectedInfo,
  errorMessage,
  onConnect,
  onDisconnect,
  onConfigure,
  onReconnect,
  onSync,
  isSyncing,
}: IntegrationCardProps) {
  const getStatusBadge = () => {
    switch (status) {
      case 'connected':
        return (
          <Badge className="bg-success/10 text-success border-success/20">
            <Check className="w-3 h-3 mr-1" />
            Conectado
          </Badge>
        );
      case 'connecting':
        return (
          <Badge variant="secondary">
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
            Conectando...
          </Badge>
        );
      case 'error':
        return (
          <Badge variant="destructive">
            <AlertCircle className="w-3 h-3 mr-1" />
            Erro
          </Badge>
        );
      case 'coming_soon':
        return (
          <Badge variant="outline" className="text-muted-foreground">
            Em breve
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className="text-muted-foreground">
            Não conectado
          </Badge>
        );
    }
  };

  return (
    <Card className={cn(
      'transition-all duration-200',
      status === 'connected' && 'ring-1 ring-success/20',
      status === 'error' && 'ring-1 ring-destructive/20'
    )}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className={cn(
              'w-10 h-10 rounded-lg flex items-center justify-center',
              status === 'connected' ? 'bg-success/10 text-success' :
              status === 'error' ? 'bg-destructive/10 text-destructive' :
              'bg-muted text-muted-foreground'
            )}>
              {icon}
            </div>
            <div>
              <CardTitle className="text-base">{title}</CardTitle>
              {getStatusBadge()}
            </div>
          </div>
        </div>
        <CardDescription className="mt-2">{description}</CardDescription>
      </CardHeader>
      
      <CardContent className="pt-0">
        {/* Connected Info */}
        {status === 'connected' && connectedInfo && (
          <div className="mb-4 p-3 rounded-lg bg-muted/50 text-sm space-y-1">
            <p className="font-medium">{connectedInfo.identifier}</p>
            {connectedInfo.lastSync && (
              <p className="text-muted-foreground text-xs">
                Última sincronização: {connectedInfo.lastSync}
              </p>
            )}
          </div>
        )}

        {/* Error Message */}
        {status === 'error' && errorMessage && (
          <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            {errorMessage}
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          {status === 'disconnected' && onConnect && (
            <Button onClick={onConnect} className="w-full">
              Conectar
            </Button>
          )}

          {status === 'connecting' && (
            <Button disabled className="w-full">
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Conectando...
            </Button>
          )}

          {status === 'connected' && (
            <>
              {onSync && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onSync}
                  disabled={isSyncing}
                >
                  {isSyncing ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <RefreshCw className="w-4 h-4 mr-1" />
                  )}
                  Sincronizar
                </Button>
              )}
              {onConfigure && (
                <Button variant="outline" size="sm" onClick={onConfigure}>
                  Configurar
                </Button>
              )}
              {onDisconnect && (
                <Button variant="ghost" size="sm" onClick={onDisconnect}>
                  Desconectar
                </Button>
              )}
            </>
          )}

          {status === 'error' && onReconnect && (
            <Button onClick={onReconnect} className="w-full">
              Reconectar
            </Button>
          )}

          {status === 'coming_soon' && (
            <Button disabled variant="outline" className="w-full">
              Em desenvolvimento
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

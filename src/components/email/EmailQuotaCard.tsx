import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Mail, AlertTriangle, Clock } from 'lucide-react';
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import { cn } from '@/lib/utils';

interface QuotaInfo {
  used: number;
  limit: number;
  remaining: number;
  resetAt: string;
}

interface QuotaResponse {
  monthly: QuotaInfo;
  daily: QuotaInfo;
  canSend: boolean;
  timezone: string;
}

function getColor(percent: number) {
  if (percent >= 90) return 'text-red-600 dark:text-red-400';
  if (percent >= 70) return 'text-amber-600 dark:text-amber-400';
  return 'text-emerald-600 dark:text-emerald-400';
}

function getProgressColor(percent: number) {
  if (percent >= 90) return '[&>div]:bg-red-500';
  if (percent >= 70) return '[&>div]:bg-amber-500';
  return '[&>div]:bg-emerald-500';
}

function formatReset(iso: string) {
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

export default function EmailQuotaCard() {
  const [quota, setQuota] = useState<QuotaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await apiClient.get<QuotaResponse>(API_ENDPOINTS.EMAIL.QUOTA);
      setQuota(data);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Falha ao carregar cota');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 60_000); // refresh a cada 60s
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <Card className="p-4">
        <div className="text-sm text-muted-foreground">Carregando consumo de e-mails...</div>
      </Card>
    );
  }

  if (error || !quota) {
    return null; // não polui a UI se quota não estiver disponível
  }

  const dailyPct = quota.daily.limit > 0 ? Math.min(100, (quota.daily.used / quota.daily.limit) * 100) : 0;
  const monthlyPct = quota.monthly.limit > 0 ? Math.min(100, (quota.monthly.used / quota.monthly.limit) * 100) : 0;
  const blocked = !quota.canSend;

  return (
    <Card className={cn('p-4', blocked && 'border-red-500/50 bg-red-50/30 dark:bg-red-950/20')}>
      <div className="flex items-center gap-2 mb-3">
        <Mail className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold">Consumo de e-mails</h3>
        {blocked && (
          <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400">
            <AlertTriangle className="w-3.5 h-3.5" /> Limite atingido
          </span>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Diário */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">📆 Hoje</span>
            <span className={cn('font-semibold tabular-nums', getColor(dailyPct))}>
              {quota.daily.used.toLocaleString('pt-BR')} / {quota.daily.limit.toLocaleString('pt-BR')}
            </span>
          </div>
          <Progress value={dailyPct} className={cn('h-2', getProgressColor(dailyPct))} />
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Clock className="w-3 h-3" /> Reset: {formatReset(quota.daily.resetAt)}
          </div>
        </div>

        {/* Mensal */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">📅 Este mês</span>
            <span className={cn('font-semibold tabular-nums', getColor(monthlyPct))}>
              {quota.monthly.used.toLocaleString('pt-BR')} / {quota.monthly.limit.toLocaleString('pt-BR')}
            </span>
          </div>
          <Progress value={monthlyPct} className={cn('h-2', getProgressColor(monthlyPct))} />
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Clock className="w-3 h-3" /> Reset: {formatReset(quota.monthly.resetAt)}
          </div>
        </div>
      </div>
    </Card>
  );
}
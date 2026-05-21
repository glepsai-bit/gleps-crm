import { useState, useEffect, useCallback } from 'react';
import { Building2, Users, CheckCircle, PauseCircle, Contact, DollarSign, TrendingUp, Cpu, HardDrive, Wifi, Clock, Server, MemoryStick, Globe } from 'lucide-react';
import { KPICard } from '@/components/dashboard/KPICard';
import { ServerResourceCard } from '@/components/dashboard/ServerResourceCard';
import { ServerConsumptionChart } from '@/components/dashboard/ServerConsumptionChart';
import { WeeklyConsumptionChart } from '@/components/dashboard/WeeklyConsumptionChart';
import { useBackend } from '@/config/backend.config';
import { supabase } from '@/integrations/supabase/client';
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import { toast } from '@/hooks/use-toast';

interface SuperAdminKPIs {
  totalAccounts: number;
  activeAccounts: number;
  pausedAccounts: number;
  totalUsers: number;
  activeUsers: number;
  totalContacts: number;
  totalPaidSales: number;
  totalRevenue: number;
  totalApiRequests: number;
  apiMonth: string;
}

interface ServerResources {
  cpu_percent: number;
  cpu_cores: number;
  ram_used_bytes: number;
  ram_total_bytes: number;
  ram_percent: number;
  disk_used_bytes: number;
  disk_total_bytes: number;
  disk_percent: number;
  network_in_bytes_sec: number;
  network_out_bytes_sec: number;
  node_heap_used: number;
  node_heap_total: number;
  node_rss: number;
  uptime_seconds: number;
  os_type: string;
  os_platform: string;
  hostname: string;
}

interface MetricsSnapshot {
  timestamp: string;
  cpu: number;
  ram_used: number;
  ram_total: number;
}

interface WeeklyData {
  day: string;
  cpu_avg: number;
  ram_avg: number;
  requests: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatBytesPerSec(bytes: number): string {
  if (bytes === 0) return '0 B/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export default function SuperAdminDashboard() {
  const [kpis, setKpis] = useState<SuperAdminKPIs | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Server metrics state
  const [serverResources, setServerResources] = useState<ServerResources | null>(null);
  const [consumptionHistory, setConsumptionHistory] = useState<MetricsSnapshot[]>([]);
  const [weeklyData, setWeeklyData] = useState<WeeklyData[]>([]);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [historyPeriod, setHistoryPeriod] = useState<'24h' | '7d' | '30d'>('24h');

  useEffect(() => {
    async function fetchKPIs() {
      try {
        if (useBackend) {
          const response = await apiClient.get<SuperAdminKPIs | { data: SuperAdminKPIs }>(
            API_ENDPOINTS.DASHBOARD.SUPER_ADMIN_KPIS
          );
          const data = (response as any).data || response;
          setKpis(data);
        } else {
          const { data, error } = await supabase.functions.invoke('super-admin-kpis');
          if (error) throw error;
          setKpis(data);
        }
      } catch (err: any) {
        console.error('Erro ao buscar KPIs:', err);
        toast({
          title: 'Erro ao carregar dados',
          description: err.message || 'Não foi possível carregar os KPIs do dashboard.',
          variant: 'destructive',
        });
      } finally {
        setIsLoading(false);
      }
    }
    fetchKPIs();
  }, []);

  const fetchServerMetrics = useCallback(async () => {
    try {
      const [resourcesRes, historyRes, weeklyRes] = await Promise.all([
        apiClient.get<{ data: ServerResources }>(API_ENDPOINTS.DASHBOARD.SERVER_RESOURCES),
        apiClient.get<{ data: MetricsSnapshot[] }>(API_ENDPOINTS.DASHBOARD.CONSUMPTION_HISTORY, {
          params: { period: historyPeriod },
        }),
        apiClient.get<{ data: WeeklyData[] }>(API_ENDPOINTS.DASHBOARD.WEEKLY_CONSUMPTION),
      ]);

      setServerResources(resourcesRes.data);
      setConsumptionHistory(historyRes.data);
      setWeeklyData(weeklyRes.data);
    } catch (err: any) {
      console.error('Erro ao buscar métricas do servidor:', err);
      // Don't toast on every refresh failure
    } finally {
      setMetricsLoading(false);
    }
  }, [historyPeriod]);

  useEffect(() => {
    if (!useBackend) {
      setMetricsLoading(false);
      return;
    }
    fetchServerMetrics();

    // Auto-refresh every 60 seconds
    const interval = setInterval(fetchServerMetrics, 60000);
    return () => clearInterval(interval);
  }, [fetchServerMetrics]);

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);

  const kpiCards = [
    {
      title: 'Total de Contas',
      value: kpis?.totalAccounts ?? 0,
      icon: Building2,
      iconColor: 'text-primary',
      iconBgColor: 'bg-primary/10',
    },
    {
      title: 'Contas Ativas',
      value: kpis?.activeAccounts ?? 0,
      icon: CheckCircle,
      iconColor: 'text-success',
      iconBgColor: 'bg-success/10',
    },
    {
      title: 'Contas Pausadas',
      value: kpis?.pausedAccounts ?? 0,
      icon: PauseCircle,
      iconColor: 'text-warning',
      iconBgColor: 'bg-warning/10',
    },
    {
      title: 'Total de Usuários',
      value: kpis?.totalUsers ?? 0,
      subtitle: `${kpis?.activeUsers ?? 0} ativos`,
      icon: Users,
      iconColor: 'text-info',
      iconBgColor: 'bg-info/10',
    },
    {
      title: 'Total de Contatos',
      value: kpis?.totalContacts ?? 0,
      icon: Contact,
      iconColor: 'text-accent-foreground',
      iconBgColor: 'bg-accent',
    },
    {
      title: 'Vendas Pagas',
      value: kpis?.totalPaidSales ?? 0,
      icon: DollarSign,
      iconColor: 'text-success',
      iconBgColor: 'bg-success/10',
    },
    {
      title: 'Receita Total',
      value: formatCurrency(kpis?.totalRevenue ?? 0),
      icon: TrendingUp,
      iconColor: 'text-primary',
      iconBgColor: 'bg-primary/10',
    },
    {
      title: 'API Maps Data',
      value: kpis?.totalApiRequests ?? 0,
      subtitle: `RapidAPI • ${kpis?.apiMonth ?? new Date().toISOString().slice(0, 7)}`,
      icon: Globe,
      iconColor: 'text-chart-4',
      iconBgColor: 'bg-chart-4/10',
    },
  ];

  return (
    <div className="page-container">
      {/* Business KPIs */}
      <div className="page-header">
        <div>
          <h1 className="text-xl sm:text-2xl md:text-3xl font-bold text-foreground">Dashboard Global</h1>
          <p className="text-xs sm:text-sm text-muted-foreground">
            Visão geral de todas as contas, usuários e receita
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {kpiCards.map((kpi) => (
          <KPICard
            key={kpi.title}
            title={kpi.title}
            value={kpi.value}
            subtitle={kpi.subtitle}
            icon={kpi.icon}
            iconColor={kpi.iconColor}
            iconBgColor={kpi.iconBgColor}
            isLoading={isLoading}
          />
        ))}
      </div>

      {/* Server Monitoring Section - only available with Express backend */}
      {useBackend && (
        <div className="space-y-4 pt-4">
          <div className="flex items-center gap-2">
            <Server className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold text-foreground">Monitoramento do Servidor</h2>
            {!metricsLoading && serverResources && (
              <span className="text-xs text-muted-foreground ml-auto">
                {serverResources.hostname} • {serverResources.os_platform}
              </span>
            )}
          </div>

          {/* Resource Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <ServerResourceCard
              title="CPU"
              value={`${serverResources?.cpu_percent ?? 0}%`}
              subtitle={`${serverResources?.cpu_cores ?? 0} cores`}
              percent={serverResources?.cpu_percent}
              icon={Cpu}
              iconColor="text-chart-1"
              iconBgColor="bg-chart-1/10"
              isLoading={metricsLoading}
            />
            <ServerResourceCard
              title="RAM"
              value={formatBytes(serverResources?.ram_used_bytes ?? 0)}
              subtitle={`de ${formatBytes(serverResources?.ram_total_bytes ?? 0)}`}
              percent={serverResources?.ram_percent}
              icon={MemoryStick}
              iconColor="text-chart-2"
              iconBgColor="bg-chart-2/10"
              isLoading={metricsLoading}
            />
            <ServerResourceCard
              title="Disco"
              value={formatBytes(serverResources?.disk_used_bytes ?? 0)}
              subtitle={`de ${formatBytes(serverResources?.disk_total_bytes ?? 0)}`}
              percent={serverResources?.disk_percent}
              icon={HardDrive}
              iconColor="text-chart-3"
              iconBgColor="bg-chart-3/10"
              isLoading={metricsLoading}
            />
            <ServerResourceCard
              title="Rede ↓"
              value={formatBytesPerSec(serverResources?.network_in_bytes_sec ?? 0)}
              icon={Wifi}
              iconColor="text-info"
              iconBgColor="bg-info/10"
              isLoading={metricsLoading}
            />
            <ServerResourceCard
              title="Rede ↑"
              value={formatBytesPerSec(serverResources?.network_out_bytes_sec ?? 0)}
              icon={Wifi}
              iconColor="text-info"
              iconBgColor="bg-info/10"
              isLoading={metricsLoading}
            />
            <ServerResourceCard
              title="Uptime"
              value={formatUptime(serverResources?.uptime_seconds ?? 0)}
              subtitle={`Node.js RSS: ${formatBytes(serverResources?.node_rss ?? 0)}`}
              icon={Clock}
              iconColor="text-success"
              iconBgColor="bg-success/10"
              isLoading={metricsLoading}
            />
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ServerConsumptionChart
              data={consumptionHistory}
              isLoading={metricsLoading}
              period={historyPeriod}
              onPeriodChange={setHistoryPeriod}
            />
            <WeeklyConsumptionChart
              data={weeklyData}
              isLoading={metricsLoading}
            />
          </div>
        </div>
      )}
    </div>
  );
}

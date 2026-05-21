import { useState, useMemo } from 'react';
import { useAuth, useRoleAccess } from '@/contexts/AuthContext';
import { useCalendar } from '@/contexts/CalendarContext';
import { useChatwootMetrics } from '@/hooks/useChatwootMetrics';
import {
  Users,
  MessageSquare,
  Clock,
  ArrowRightLeft,
  CalendarCheck,
  Bot,
  X,
  AlertCircle,
  UserPlus,
  RefreshCw,
} from 'lucide-react';
import { subDays, startOfDay, endOfDay, isWithinInterval, parseISO } from 'date-fns';
import { DateRange } from 'react-day-picker';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SyncIndicatorWithButton } from '@/components/ui/sync-indicator';

// Dashboard Components
import { DashboardFilters } from '@/components/dashboard/DashboardFilters';
import { KPICard } from '@/components/dashboard/KPICard';
import { AtendimentoRealtimeCard } from '@/components/dashboard/AtendimentoRealtimeCard';
import { ResolucaoCard } from '@/components/dashboard/ResolucaoCard';
import { HourlyPeakChart } from '@/components/dashboard/HourlyPeakChart';
import { BacklogCard } from '@/components/dashboard/BacklogCard';
import { AgentPerformanceTable } from '@/components/dashboard/AgentPerformanceTable';
import { QualityCards } from '@/components/dashboard/QualityCards';

export default function AdminDashboard() {
  const { user, account } = useAuth();
  const { isAdmin } = useRoleAccess();
  const { events } = useCalendar();
  const [period, setPeriod] = useState('7d');
  const [dateRange, setDateRange] = useState<DateRange | undefined>({
    from: startOfDay(subDays(new Date(), 7)),
    to: endOfDay(new Date()),
  });
  const [channel, setChannel] = useState('all');
  const [selectedAgent, setSelectedAgent] = useState('all');
  const [selectedAgentFromTable, setSelectedAgentFromTable] = useState<string | null>(null);

  // Fetch real metrics from Chatwoot with auto-polling
  const {
    data: metricsData,
    isLoading,
    isSyncing,
    lastSyncAt,
    isTabActive,
    error: metricsError,
    isConfigured,
    refetch,
  } = useChatwootMetrics({
    dateFrom: dateRange?.from || startOfDay(subDays(new Date(), 7)),
    dateTo: dateRange?.to || endOfDay(new Date()),
    inboxId: channel !== 'all' ? getInboxIdFromChannel(channel) : undefined,
    enablePolling: true,
    pollingInterval: 30000,
  });

  // Helper to map channel name to inbox ID (will be dynamic when we have real inboxes)
  function getInboxIdFromChannel(channelName: string): number | undefined {
    const channelMap: Record<string, number> = {
      whatsapp: 1,
      instagram: 2,
      webchat: 3,
    };
    return channelMap[channelName];
  }

  // Handle period change from filters
  const handlePeriodChange = (newPeriod: string, range?: DateRange) => {
    setPeriod(newPeriod);
    if (range) {
      // Normalize to full-day boundaries
      setDateRange({
        from: range.from ? startOfDay(range.from) : range.from,
        to: range.to ? endOfDay(range.to) : range.to,
      });
    } else if (newPeriod === '7d') {
      setDateRange({ from: startOfDay(subDays(new Date(), 7)), to: endOfDay(new Date()) });
    } else if (newPeriod === '30d') {
      setDateRange({ from: startOfDay(subDays(new Date(), 30)), to: endOfDay(new Date()) });
    }
  };

  // Calculate appointments counts based on role, selected agent, and period
  const totalAppointments = useMemo(() => {
    const start = dateRange?.from || subDays(new Date(), 7);
    const end = dateRange?.to || new Date();
    
    const periodEvents = events.filter(event => {
      const eventDate = parseISO(event.start);
      return isWithinInterval(eventDate, { start, end }) &&
             (event.type === 'meeting' || event.type === 'appointment');
    });
    
    let filteredEvents = periodEvents;
    
    if (!isAdmin) {
      filteredEvents = periodEvents.filter(event => event.createdBy === user?.id);
    } else if (selectedAgentFromTable) {
      filteredEvents = periodEvents.filter(event => event.createdBy === selectedAgentFromTable);
    } else if (selectedAgent !== 'all') {
      filteredEvents = periodEvents.filter(event => event.createdBy === selectedAgent);
    }
    
    return filteredEvents.length;
  }, [events, isAdmin, user?.id, selectedAgent, selectedAgentFromTable, dateRange]);

  // Get displayed data from real metrics or defaults
  const displayedData = useMemo(() => {
    if (!metricsData) {
      return {
        kpis: {
          totalLeads: 0,
          conversasAtivas: 0,
          retornosNoPeriodo: 0,
          atendimentosIA: 0,
          atendimentosHumano: 0,
          atendimentosClassificados: 0,
          percentualIA: 0,
          percentualHumano: 0,
          tempoMedioPrimeiraResposta: '0s',
          tempoMedioResolucao: '0s',
          taxaTransbordo: '0%',
        },
        atendimento: {
          total: 0,
          ia: 0,
          humano: 0,
          semAssignee: 0,
        },
        resolucao: {
          total: 0,
          ia: { total: 0, explicito: 0, botNativo: 0, inferido: 0 },
          humano: { total: 0, explicito: 0, inferido: 0 },
          naoClassificado: 0,
          transbordoFinalizado: 0,
        },
        taxas: {
          resolucaoIA: '0%',
          resolucaoHumano: '0%',
          transbordo: '0%',
          eficienciaIA: '0%',
        },
        picoPorHora: [],
        backlog: { ate15min: 0, de15a60min: 0, acima60min: 0 },
        qualidade: { conversasSemResposta: 0, taxaAtendimentoVenda: '0%' },
        agentes: [],
      };
    }

    // If agent is selected from table, filter by that agent
    if (selectedAgentFromTable) {
      const agentData = metricsData.agentes.find(
        a => a.agentName === selectedAgentFromTable
      );
      if (agentData) {
        // Return agent-specific view (simplified for now)
        return {
          kpis: {
          totalLeads: agentData.atendimentosAssumidos,
          conversasAtivas: Math.round(agentData.atendimentosAssumidos * 0.1),
          retornosNoPeriodo: 0,
          percentualIA: metricsData.percentualIA,
            percentualHumano: metricsData.percentualHumano,
            tempoMedioPrimeiraResposta: agentData.tempoMedioResposta,
            tempoMedioResolucao: metricsData.tempoMedioResolucao,
            taxaTransbordo: metricsData.taxaTransbordo,
          },
          atendimento: metricsData.atendimento,
          resolucao: metricsData.resolucao,
          taxas: metricsData.taxas,
          picoPorHora: metricsData.picoPorHora,
          backlog: metricsData.backlog,
          qualidade: metricsData.qualidade,
          agentes: metricsData.agentes,
        };
      }
    }

    return {
      kpis: {
        totalLeads: metricsData.totalLeads,
        conversasAtivas: metricsData.conversasAtivas,
        retornosNoPeriodo: metricsData.retornosNoPeriodo ?? 0,
        atendimentosIA: metricsData.atendimentosIA ?? 0,
        atendimentosHumano: metricsData.atendimentosHumano ?? 0,
        atendimentosClassificados: metricsData.atendimentosClassificados ?? 0,
        percentualIA: metricsData.percentualIA,
        percentualHumano: metricsData.percentualHumano,
        tempoMedioPrimeiraResposta: metricsData.tempoMedioPrimeiraResposta,
        tempoMedioResolucao: metricsData.tempoMedioResolucao,
        taxaTransbordo: metricsData.taxaTransbordo,
      },
      atendimento: metricsData.atendimento,
      resolucao: metricsData.resolucao,
      taxas: metricsData.taxas,
      picoPorHora: metricsData.picoPorHora,
      backlog: metricsData.backlog,
      qualidade: metricsData.qualidade,
      agentes: metricsData.agentes,
    };
  }, [metricsData, selectedAgentFromTable]);

  // Format agents for the performance table
  const agentPerformanceData = useMemo(() => {
    return displayedData.agentes.map(agent => ({
      agentName: agent.agentName,
      atendimentosAssumidos: agent.atendimentosAssumidos,
      atendimentosResolvidos: agent.atendimentosResolvidos,
      tempoMedioResposta: agent.tempoMedioResposta,
      taxaResolucao: agent.taxaResolucao,
    }));
  }, [displayedData.agentes]);

  // Helper for subtitle context
  const getAgentContextSubtitle = (defaultText: string) => {
    if (selectedAgentFromTable) {
      return `Dados de ${selectedAgentFromTable}`;
    }
    return defaultText;
  };

  return (
    <div className="page-container">
      {/* Header */}
      <div className="page-header">
        <div className="min-w-0 flex-1">
          <h1 className="title-responsive text-foreground">Dashboard de Atendimento</h1>
          <p className="text-responsive-sm text-muted-foreground">
            Métricas operacionais e estratégicas do atendimento
          </p>
        </div>
        {isConfigured && (
          <SyncIndicatorWithButton
            isSyncing={isSyncing}
            lastSyncAt={lastSyncAt}
            isTabActive={isTabActive}
            error={metricsError ? new Error(metricsError) : null}
            onRefresh={refetch}
            refreshLabel="Atualizar"
          />
        )}
      </div>

      {/* Chatwoot Not Configured Alert */}
      {!isConfigured && (
        <Alert variant="destructive" className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Chatwoot não configurado</AlertTitle>
          <AlertDescription>
            A integração com Chatwoot não está configurada para esta conta. 
            Entre em contato com o administrador para configurar as credenciais.
          </AlertDescription>
        </Alert>
      )}

      {/* Error Alert */}
      {metricsError && isConfigured && (
        <Alert variant="destructive" className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Erro ao carregar métricas</AlertTitle>
          <AlertDescription className="flex items-center justify-between">
            <span>{metricsError}</span>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Tentar novamente
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Global Filters */}
      <DashboardFilters
        onPeriodChange={handlePeriodChange}
        onChannelChange={setChannel}
        onAgentChange={setSelectedAgent}
        showAgentFilter={false}
        showChannelFilter={true}
        showTypeFilter={false}
      />

      {/* Agent Filter Active Banner */}
      {selectedAgentFromTable && (
        <div className="flex items-center justify-between p-3 rounded-lg bg-primary/10 border border-primary/20">
          <span className="text-sm">
            Visualizando dados de <strong>{selectedAgentFromTable}</strong>
          </span>
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={() => setSelectedAgentFromTable(null)}
            className="h-7 text-xs"
          >
            <X className="w-3 h-3 mr-1" /> Limpar filtro
          </Button>
        </div>
      )}

      {/* KPI Cards - Row 1 */}
      <div className="kpi-grid-6">
        <KPICard
          title="Total de Leads"
          subtitle={getAgentContextSubtitle('Contatos únicos')}
          value={displayedData.kpis.totalLeads}
          icon={Users}
          iconColor="text-primary"
          iconBgColor="bg-primary/10"
          isLoading={isLoading}
        />
        <KPICard
          title="Novos Leads"
          subtitle={getAgentContextSubtitle('Primeiro contato no período')}
          value={displayedData.kpis.conversasAtivas}
          icon={UserPlus}
          iconColor="text-success"
          iconBgColor="bg-success/10"
          isLoading={isLoading}
        />
        <KPICard
          title="Retornos no Período"
          subtitle={getAgentContextSubtitle('Reentraram em contato')}
          value={displayedData.kpis.retornosNoPeriodo}
          icon={RefreshCw}
          iconColor="text-warning"
          iconBgColor="bg-warning/10"
          isLoading={isLoading}
        />
        <KPICard
          title="Agendamentos"
          subtitle={selectedAgentFromTable 
            ? `Dados de ${selectedAgentFromTable}` 
            : (isAdmin ? (selectedAgent !== 'all' ? 'Agente selecionado' : 'Visão geral') : 'Seus agendamentos')}
          value={totalAppointments}
          icon={CalendarCheck}
          iconColor="text-success"
          iconBgColor="bg-success/10"
          isLoading={isLoading}
        />
        <KPICard
          title="Tempo Médio Resposta"
          subtitle={getAgentContextSubtitle('Primeira resposta')}
          value={displayedData.kpis.tempoMedioPrimeiraResposta}
          icon={Clock}
          iconColor="text-primary"
          iconBgColor="bg-primary/10"
          isLoading={isLoading}
        />
        <KPICard
          title="Taxa de Transbordo"
          subtitle={getAgentContextSubtitle('IA → Humano')}
          value={displayedData.kpis.taxaTransbordo}
          icon={ArrowRightLeft}
          iconColor="text-warning"
          iconBgColor="bg-warning/10"
          isLoading={isLoading}
        />
      </div>

      {/* DUAS CAMADAS: Atendimento (Tempo Real) + Resolução (Histórico) */}
      <div className="chart-grid">
        <AtendimentoRealtimeCard
          data={displayedData.atendimento}
          isLoading={isLoading}
        />
        <ResolucaoCard
          resolucao={displayedData.resolucao}
          taxas={displayedData.taxas}
          isLoading={isLoading}
        />
      </div>

      {/* Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <HourlyPeakChart data={displayedData.picoPorHora} isLoading={isLoading} />
        <BacklogCard data={displayedData.backlog} isLoading={isLoading} />
      </div>

      {/* Agent Performance Table */}
      <AgentPerformanceTable 
        data={agentPerformanceData} 
        isLoading={isLoading}
        selectedAgentName={selectedAgentFromTable}
        onAgentSelect={setSelectedAgentFromTable}
      />

      {/* Quality & Conversion Cards */}
      <QualityCards data={displayedData.qualidade} isLoading={isLoading} />
    </div>
  );
}

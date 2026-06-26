import { useMemo, useState } from 'react';
import { DashboardFilters } from '@/components/dashboard/DashboardFilters';
import {
  FinanceKPICards,
  RevenueChart,
  PaymentMethodChart,
  FunnelConversionChart,
  SalesTable,
  CreateSaleDialog,
} from '@/components/finance';
import type { FinanceFilters } from '@/hooks/useFilteredFinanceKPIs';

export default function AdminFinancePage() {
  const [period, setPeriod] = useState('7d');
  const [channel, setChannel] = useState('all');
  const [type, setType] = useState('all');
  const [selectedAgent, setSelectedAgent] = useState('all');

  const isLoading = false;

  // H-DASH-2: agora os filtros chegam de fato aos KPI cards / charts.
  // Antes do fix os setters existiam mas o state não era consumido — filtros
  // eram puramente cosméticos.
  const filters: FinanceFilters = useMemo(
    () => ({ period, channel, type, agent: selectedAgent }),
    [period, channel, type, selectedAgent]
  );

  return (
    <div className="page-container">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-foreground">Dashboard Financeiro</h1>
          <p className="text-xs sm:text-sm text-muted-foreground">
            Métricas financeiras e gestão de vendas
          </p>
        </div>

        <CreateSaleDialog />
      </div>

      {/* Global Filters - Agent filter removed from Finance */}
      <DashboardFilters
        onPeriodChange={setPeriod}
        onChannelChange={setChannel}
        onTypeChange={setType}
        onAgentChange={setSelectedAgent}
        showAgentFilter={false}
      />

      {/* KPI Cards */}
      <FinanceKPICards isLoading={isLoading} filters={filters} />

      {/* Charts Section */}
      <div className="chart-grid">
        <RevenueChart isLoading={isLoading} filters={filters} />
        <PaymentMethodChart isLoading={isLoading} filters={filters} />
      </div>

      {/* Funnel Conversion */}
      <FunnelConversionChart isLoading={isLoading} />

      {/* Sales Table */}
      <SalesTable isLoading={isLoading} />
    </div>
  );
}

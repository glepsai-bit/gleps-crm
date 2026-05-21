import { useState } from 'react';
import { DashboardFilters } from '@/components/dashboard/DashboardFilters';
import { EmptyState } from '@/components/dashboard/EmptyState';
import {
  FinanceKPICards,
  RevenueChart,
  PaymentMethodChart,
  FunnelConversionChart,
  SalesTable,
  CreateSaleDialog,
} from '@/components/finance';

export default function AdminFinancePage() {
  const [period, setPeriod] = useState('7d');
  const [channel, setChannel] = useState('all');
  const [type, setType] = useState('all');
  const [selectedAgent, setSelectedAgent] = useState('all');

  const isLoading = false;

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
      <FinanceKPICards isLoading={isLoading} />

      {/* Charts Section */}
      <div className="chart-grid">
        <RevenueChart isLoading={isLoading} />
        <PaymentMethodChart isLoading={isLoading} />
      </div>

      {/* Funnel Conversion */}
      <FunnelConversionChart isLoading={isLoading} />

      {/* Sales Table */}
      <SalesTable isLoading={isLoading} />
    </div>
  );
}

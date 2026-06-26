/**
 * useFilteredFinanceKPIs — H-DASH-2
 *
 * Hook que filtra `sales` do FinanceContext pelos filtros do DashboardFilters
 * (período, canal/origem, tipo, agente) e devolve KPIs derivados já no formato
 * esperado pelos componentes (FinanceKPICards, RevenueChart, PaymentMethodChart).
 *
 * Antes deste hook, o AdminFinancePage apenas mantinha state dos filtros sem
 * propagar pros KPIs — selecionar "30 dias" ou um canal não mudava nada na UI.
 *
 * Filtros suportados:
 *   - period: '7d' | '30d' | 'custom' — recortado por `created_at`
 *   - channel: 'all' | 'whatsapp' | 'instagram' | 'site' | 'indicacao' | 'outro'
 *     (mapeado via Contact.origem do contato dono da venda)
 *   - type: 'all' | 'ia' | 'human' — para o módulo financeiro não temos
 *     atribuição IA/Humano por venda; mantemos como no-op (todas vendas são
 *     consideradas humanas). Filtro fica preservado pra futuro.
 *   - agent: 'all' | <userId> — filtra por `responsavel_id`
 *
 * Mantemos a forma de KPIs igual ao FinanceContextType.kpis pra os componentes
 * existentes continuarem funcionando sem mudança de contrato.
 */

import { useMemo } from 'react';
import { subDays } from 'date-fns';
import { useFinance } from '@/contexts/FinanceContext';
import type { PaymentMethod, Sale } from '@/types/crm';

export interface FinanceFilters {
  period: string; // '7d' | '30d' | 'custom'
  channel: string; // 'all' | ContactOrigin
  type: string; // 'all' | 'ia' | 'human' — no-op por enquanto
  agent: string; // 'all' | userId
}

export interface FilteredFinanceKPIs {
  faturamentoBruto: number;
  ticketMedio: number;
  totalVendas: number;
  vendasPagas: { count: number; valor: number };
  vendasPendentes: { count: number; valor: number };
  vendasCanceladas: { count: number; valor: number };
  vendasEstornadas: { count: number; valor: number };
  porMetodoPagamento: {
    method: PaymentMethod | 'none';
    count: number;
    valor: number;
  }[];
  faturamentoPorDia: { date: string; valor: number }[];
}

function periodToDays(period: string): number {
  if (period === '30d') return 30;
  if (period === '7d') return 7;
  // custom — não recorta por padrão (component pai poderia injetar range exato
  // depois; mantemos comportamento conservador: tudo)
  return 0;
}

export function useFilteredFinanceKPIs(filters: FinanceFilters): FilteredFinanceKPIs {
  const { sales, getContactById } = useFinance();

  return useMemo(() => {
    // --- Filtro de período (created_at >= hoje - N dias) ---
    const days = periodToDays(filters.period);
    const fromDate = days > 0 ? subDays(new Date(), days).getTime() : null;

    // --- Aplica filtros sobre o array bruto de vendas ---
    const matchesChannel = (sale: Sale): boolean => {
      if (filters.channel === 'all') return true;
      const contact = getContactById(sale.contact_id);
      return contact?.origem === filters.channel;
    };

    const matchesAgent = (sale: Sale): boolean => {
      if (filters.agent === 'all') return true;
      return sale.responsavel_id === filters.agent;
    };

    const matchesPeriod = (sale: Sale): boolean => {
      if (fromDate === null) return true;
      const createdMs = new Date(sale.created_at).getTime();
      return createdMs >= fromDate;
    };

    const filteredSales = sales.filter(
      (s) => matchesPeriod(s) && matchesChannel(s) && matchesAgent(s)
    );

    const paidSales = filteredSales.filter((s) => s.status === 'paid');
    const pendingSales = filteredSales.filter((s) => s.status === 'pending');
    const refundedSales = filteredSales.filter((s) => s.status === 'refunded');

    const faturamentoBruto = paidSales.reduce((sum, s) => sum + s.valor, 0);
    const ticketMedio =
      paidSales.length > 0 ? faturamentoBruto / paidSales.length : 0;

    // Por método de pagamento
    const methodsMap = new Map<
      PaymentMethod | 'none',
      { count: number; valor: number }
    >();
    paidSales.forEach((s) => {
      const method = (s.metodo_pagamento || 'none') as PaymentMethod | 'none';
      const current = methodsMap.get(method) || { count: 0, valor: 0 };
      methodsMap.set(method, {
        count: current.count + 1,
        valor: current.valor + s.valor,
      });
    });
    const porMetodoPagamento = Array.from(methodsMap.entries()).map(
      ([method, data]) => ({
        method,
        ...data,
      })
    );

    // Faturamento por dia — janela depende do period:
    //   '7d'  → últimos 7 dias
    //   '30d' → últimos 30 dias (gráfico fica mais legível em 7 buckets de 7d
    //           se quisermos no futuro; por ora mantemos diário)
    //   'custom' → últimos 7 dias como fallback (sem range explícito ainda)
    const bucketCount = days > 0 ? Math.min(days, 30) : 7;
    const today = new Date();
    const faturamentoPorDia: { date: string; valor: number }[] = [];
    for (let i = bucketCount - 1; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const dayRevenue = paidSales
        .filter((s) => s.paid_at && s.paid_at.startsWith(dateStr))
        .reduce((sum, s) => sum + s.valor, 0);
      faturamentoPorDia.push({
        date: date.toLocaleDateString('pt-BR', {
          day: '2-digit',
          month: '2-digit',
        }),
        valor: dayRevenue,
      });
    }

    return {
      faturamentoBruto,
      ticketMedio,
      totalVendas: filteredSales.length,
      vendasPagas: { count: paidSales.length, valor: faturamentoBruto },
      vendasPendentes: {
        count: pendingSales.length,
        valor: pendingSales.reduce((sum, s) => sum + s.valor, 0),
      },
      vendasCanceladas: { count: 0, valor: 0 },
      vendasEstornadas: {
        count: refundedSales.length,
        valor: refundedSales.reduce((sum, s) => sum + s.valor, 0),
      },
      porMetodoPagamento,
      faturamentoPorDia,
    };
  }, [sales, getContactById, filters.period, filters.channel, filters.agent]);
}

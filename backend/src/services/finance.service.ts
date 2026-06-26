import { prisma } from '../config/database';
import { PaymentMethod } from '@prisma/client';
import { DateRangeFilter } from '../types';
import { startOfDay, endOfDay, eachDayOfInterval, eachWeekOfInterval, eachMonthOfInterval, subDays, format } from 'date-fns';

type Granularity = 'day' | 'week' | 'month';

export interface FinanceKpiExtraFilters {
  responsavelId?: string;
  metodoPagamento?: PaymentMethod;
}

/**
 * L-VEN-2 — Escopo do módulo financeiro
 * --------------------------------------------------------------------------
 * Hoje o "Financeiro" é um agregador de dados DERIVADOS das vendas
 * (Sale): KPIs, gráficos, métodos de pagamento e funil. Não existe um CRUD
 * de "lançamentos" (entries) — receitas/despesas avulsas, transferências,
 * categorização contábil etc. — porque o módulo nasceu para servir o caso
 * de uso atual (FitPark / SaaS B2B leve).
 *
 * Caso surja demanda real para um livro-caixa completo (POST /entries,
 * GET /entries, PATCH, DELETE, categorização, anexo de comprovante,
 * conciliação bancária), criar:
 *   - model FinanceEntry no schema.prisma (id, accountId, tipo, valor,
 *     categoria, descricao, data, comprovanteUrl, criadoPor, ...)
 *   - financeEntryService (CRUD + agregações)
 *   - rotas REST em finance.routes.ts (sob requirePermission('finance'))
 *   - integrar nos KPIs (totalRevenue passaria a somar entries.tipo=receita
 *     + sales.paid; despesas viram outro KPI)
 *
 * Até lá, o controller responde 501 NOT_IMPLEMENTED para a rota stub
 * `POST /finance/entries` deixando claro pro frontend/integrador que o
 * recurso existe no roadmap mas ainda não foi implementado.
 */

class FinanceService {
  /**
   * Get finance KPIs
   */
  async getKPIs(
    accountId: string,
    filters: DateRangeFilter,
    extraFilters: FinanceKpiExtraFilters = {}
  ) {
    const where: any = { accountId };

    if (extraFilters.responsavelId) {
      where.responsavelId = extraFilters.responsavelId;
    }

    if (extraFilters.metodoPagamento) {
      where.metodoPagamento = extraFilters.metodoPagamento;
    }

    if (filters.startDate || filters.endDate) {
      where.createdAt = {};
      if (filters.startDate) {
        where.createdAt.gte = filters.startDate;
      }
      if (filters.endDate) {
        where.createdAt.lte = filters.endDate;
      }
    }

    // L-VEN-1: SOURCE OF TRUTH — `totalSales` é igual a `paidSales` (vendas
    // com status='paid'). Mantemos `allSales` como total bruto (todos os
    // statuses) para uso opcional, mas o KPI principal de "vendas" usado
    // pelo dashboard e pelo financeiro deve sempre vir de paidSales.
    // Antes desse ajuste, /dashboard/kpis.totalSales (todos os status) podia
    // divergir de /finance/kpis.totalSales — agora os dois batem.
    const [
      allSales,
      paidSales,
      pendingSales,
      refundedSales,
      totalRevenue,
      pendingRevenue,
      refundedRevenue,
      avgTicket,
      recurringSales,
    ] = await Promise.all([
      prisma.sale.count({ where }),
      prisma.sale.count({ where: { ...where, status: 'paid' } }),
      prisma.sale.count({ where: { ...where, status: 'pending' } }),
      prisma.sale.count({ where: { ...where, status: { in: ['refunded', 'partial_refund'] } } }),
      prisma.sale.aggregate({
        where: { ...where, status: 'paid' },
        _sum: { valor: true },
      }),
      prisma.sale.aggregate({
        where: { ...where, status: 'pending' },
        _sum: { valor: true },
      }),
      prisma.sale.aggregate({
        where: { ...where, status: { in: ['refunded', 'partial_refund'] } },
        _sum: { valor: true },
      }),
      prisma.sale.aggregate({
        where: { ...where, status: 'paid' },
        _avg: { valor: true },
      }),
      prisma.sale.count({ where: { ...where, status: 'paid', isRecurring: true } }),
    ]);

    const recurringRateRaw = paidSales > 0 ? (recurringSales / paidSales) * 100 : 0;
    const recurringRate = Math.min(100, Math.round(recurringRateRaw * 100) / 100);

    const totalSales = paidSales;

    return {
      totalSales,
      allSales,
      paidSales,
      pendingSales,
      refundedSales,
      recurringSales,
      totalRevenue: Number(totalRevenue._sum.valor || 0),
      pendingRevenue: Number(pendingRevenue._sum.valor || 0),
      refundedRevenue: Number(refundedRevenue._sum.valor || 0),
      avgTicket: Number(avgTicket._avg.valor || 0),
      conversionRate: allSales > 0 ? Math.round((paidSales / allSales) * 100) : 0,
      recurringRate,
    };
  }

  /**
   * Get revenue chart data
   */
  async getRevenueChart(accountId: string, filters: DateRangeFilter, granularity: Granularity = 'day') {
    const startDate = filters.startDate || subDays(new Date(), 30);
    const endDate = filters.endDate || new Date();

    const sales = await prisma.sale.findMany({
      where: {
        accountId,
        status: 'paid',
        paidAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      select: {
        paidAt: true,
        valor: true,
      },
    });

    let intervals: Date[];
    let formatStr: string;

    switch (granularity) {
      case 'week':
        intervals = eachWeekOfInterval({ start: startDate, end: endDate });
        formatStr = 'yyyy-\'W\'ww';
        break;
      case 'month':
        intervals = eachMonthOfInterval({ start: startDate, end: endDate });
        formatStr = 'yyyy-MM';
        break;
      default:
        intervals = eachDayOfInterval({ start: startDate, end: endDate });
        formatStr = 'yyyy-MM-dd';
    }

    return intervals.map(date => {
      const dateStart = startOfDay(date);
      let dateEnd: Date;

      switch (granularity) {
        case 'week':
          dateEnd = endOfDay(new Date(date.getTime() + 6 * 24 * 60 * 60 * 1000));
          break;
        case 'month':
          dateEnd = endOfDay(new Date(date.getFullYear(), date.getMonth() + 1, 0));
          break;
        default:
          dateEnd = endOfDay(date);
      }

      const periodSales = sales.filter(
        s => s.paidAt && s.paidAt >= dateStart && s.paidAt <= dateEnd
      );

      return {
        date: format(date, formatStr),
        revenue: periodSales.reduce((sum, s) => sum + Number(s.valor), 0),
        count: periodSales.length,
      };
    });
  }

  /**
   * Get payment methods distribution
   */
  async getPaymentMethods(accountId: string, filters: DateRangeFilter) {
    const where: any = { accountId, status: 'paid' };

    if (filters.startDate || filters.endDate) {
      where.paidAt = {};
      if (filters.startDate) {
        where.paidAt.gte = filters.startDate;
      }
      if (filters.endDate) {
        where.paidAt.lte = filters.endDate;
      }
    }

    const result = await prisma.sale.groupBy({
      by: ['metodoPagamento'],
      where,
      _count: { id: true },
      _sum: { valor: true },
    });

    const total = result.reduce((sum, r) => sum + r._count.id, 0);

    return result.map(r => ({
      method: r.metodoPagamento,
      count: r._count.id,
      revenue: Number(r._sum.valor || 0),
      percentage: total > 0 ? Math.round((r._count.id / total) * 100) : 0,
    }));
  }

  /**
   * Get funnel conversion data
   */
  async getFunnelConversion(accountId: string, filters: DateRangeFilter) {
    // Get stages
    const stages = await prisma.tag.findMany({
      where: {
        accountId,
        type: 'stage',
        ativo: true,
      },
      orderBy: { ordem: 'asc' },
      include: {
        _count: {
          select: { leadTags: true },
        },
      },
    });

    // Get stage history for conversion tracking
    const where: any = { accountId };
    if (filters.startDate || filters.endDate) {
      where.createdAt = {};
      if (filters.startDate) {
        where.createdAt.gte = filters.startDate;
      }
      if (filters.endDate) {
        where.createdAt.lte = filters.endDate;
      }
    }

    const contacts = await prisma.contact.count({ where: { accountId } });
    const sales = await prisma.sale.count({
      where: {
        accountId,
        status: 'paid',
        ...(filters.startDate || filters.endDate ? {
          createdAt: {
            gte: filters.startDate,
            lte: filters.endDate,
          },
        } : {}),
      },
    });

    return {
      stages: stages.map(s => ({
        id: s.id,
        name: s.name,
        color: s.color,
        leadsCount: s._count.leadTags,
      })),
      totalContacts: contacts,
      totalSales: sales,
      overallConversion: contacts > 0 ? Math.round((sales / contacts) * 100) : 0,
    };
  }
}

export const financeService = new FinanceService();

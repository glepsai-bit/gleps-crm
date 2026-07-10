import { prisma } from '../config/database';
import { DateRangeFilter } from '../types';
import { subDays } from 'date-fns';
import { metricsCollector } from './metrics-collector';
import { chatMetricsService } from './chat-metrics.service';

class DashboardService {
  /**
   * Get KPIs for Admin Dashboard
   */
  async getAdminKPIs(accountId: string, filters: DateRangeFilter, agentId?: string) {
    const where: any = { accountId };

    if (agentId) {
      where.responsavelId = agentId;
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

    // L-VEN-1: SOURCE OF TRUTH — `totalSales` em todos os KPIs de venda
    // (dashboard.getAdminKPIs e finance.getKPIs) conta apenas vendas com
    // status='paid'. Vendas em `pending` / `refunded` / `partial_refund` NÃO
    // entram em totalSales para evitar divergência entre widgets do dashboard
    // e do financeiro (ex.: dashboard.totalSales=13 vs finance.totalSales=11).
    // Quem precisar do total bruto (todas as vendas independente de status)
    // deve usar `allSales` (vide abaixo) ou contagens dedicadas.
    const [
      totalLeads,
      newLeads,
      allSales,
      paidSales,
      totalRevenue,
    ] = await Promise.all([
      prisma.contact.count({ where: { accountId } }),
      prisma.contact.count({ where: { accountId, createdAt: where.createdAt } }),
      prisma.sale.count({ where }),
      prisma.sale.count({ where: { ...where, status: 'paid' } }),
      prisma.sale.aggregate({
        where: { ...where, status: 'paid' },
        _sum: { valor: true },
      }),
    ]);

    // totalSales == paidSales (source of truth). allSales fica disponível para
    // o frontend que quiser exibir o universo completo (paid + pending + refunds).
    const totalSales = paidSales;

    return {
      totalLeads,
      newLeads,
      totalSales,
      allSales,
      paidSales,
      totalRevenue: Number(totalRevenue._sum.valor || 0),
      conversionRate: allSales > 0 ? Math.round((paidSales / allSales) * 100) : 0,
    };
  }

  /**
   * Get Super Admin KPIs (global platform metrics)
   */
  async getSuperAdminKPIs() {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const [
      totalAccounts,
      activeAccounts,
      pausedAccounts,
      totalUsers,
      activeUsers,
      totalContacts,
      totalSales,
      totalRevenue,
      apiUsageLogs,
    ] = await Promise.all([
      prisma.account.count(),
      prisma.account.count({ where: { status: 'active' } }),
      prisma.account.count({ where: { status: 'paused' } }),
      prisma.user.count(),
      prisma.user.count({ where: { status: 'active' } }),
      prisma.contact.count(),
      prisma.sale.count({ where: { status: 'paid' } }),
      prisma.sale.aggregate({
        where: { status: 'paid' },
        _sum: { valor: true },
      }),
      prisma.apiUsageLog.findMany({
        where: { month: currentMonth },
        select: { requestsCount: true },
      }),
    ]);

    const totalApiRequests = apiUsageLogs.reduce((sum, r) => sum + r.requestsCount, 0);

    return {
      totalAccounts,
      activeAccounts,
      pausedAccounts,
      totalUsers,
      activeUsers,
      totalContacts,
      totalPaidSales: totalSales,
      totalRevenue: Number(totalRevenue._sum.valor || 0),
      totalApiRequests,
      apiMonth: currentMonth,
    };
  }

  /**
   * Get hourly peak data
   */
  async getHourlyPeak(accountId: string, filters: DateRangeFilter) {
    const startDate = filters.startDate || subDays(new Date(), 7);
    const endDate = filters.endDate || new Date();

    // Get events by hour
    const events = await prisma.event.findMany({
      where: {
        accountId,
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      select: {
        createdAt: true,
      },
    });

    // Group by hour
    const hourlyData: Record<number, number> = {};
    for (let i = 0; i < 24; i++) {
      hourlyData[i] = 0;
    }

    for (const event of events) {
      const hour = event.createdAt.getHours();
      hourlyData[hour]++;
    }

    return Object.entries(hourlyData).map(([hour, count]) => ({
      hour: parseInt(hour),
      count,
    }));
  }

  /**
   * Get backlog metrics
   */
  async getBacklog(accountId: string) {
    const pendingSales = await prisma.sale.count({
      where: { accountId, status: 'pending' },
    });

    const pendingLeads = await prisma.contact.count({
      where: {
        accountId,
        leadTags: {
          none: {
            tag: { type: 'stage' },
          },
        },
      },
    });

    return {
      pendingSales,
      pendingLeads,
      totalPending: pendingSales + pendingLeads,
    };
  }

  /**
   * Get agent performance
   */
  async getAgentPerformance(accountId: string, filters: DateRangeFilter) {
    const where: any = { accountId, role: { in: ['admin', 'agent'] } };

    const users = await prisma.user.findMany({
      where,
      select: {
        id: true,
        nome: true,
        email: true,
        role: true,
      },
    });

    const saleWhere: any = { accountId };
    if (filters.startDate || filters.endDate) {
      saleWhere.createdAt = {};
      if (filters.startDate) {
        saleWhere.createdAt.gte = filters.startDate;
      }
      if (filters.endDate) {
        saleWhere.createdAt.lte = filters.endDate;
      }
    }

    // AUDIT-DASH-N1: antes eram 3 queries POR usuário (3×N round-trips a
    // cada carga do dashboard). Um único groupBy por (responsavelId, status)
    // traz contagem e soma; cruzamos em memória com a lista de usuários.
    const grouped = await prisma.sale.groupBy({
      by: ['responsavelId', 'status'],
      where: { ...saleWhere, responsavelId: { in: users.map((u) => u.id) } },
      _count: { _all: true },
      _sum: { valor: true },
    });

    const byUser = new Map<
      string,
      { total: number; paid: number; revenue: number }
    >();
    for (const row of grouped) {
      if (!row.responsavelId) continue;
      const agg = byUser.get(row.responsavelId) ?? {
        total: 0,
        paid: 0,
        revenue: 0,
      };
      agg.total += row._count._all;
      if (row.status === 'paid') {
        agg.paid += row._count._all;
        agg.revenue += Number(row._sum.valor || 0);
      }
      byUser.set(row.responsavelId, agg);
    }

    const performance = users.map((user) => {
      const agg = byUser.get(user.id) ?? { total: 0, paid: 0, revenue: 0 };
      return {
        user: {
          id: user.id,
          nome: user.nome,
          email: user.email,
          role: user.role,
        },
        totalSales: agg.total,
        paidSales: agg.paid,
        totalRevenue: agg.revenue,
        conversionRate:
          agg.total > 0 ? Math.round((agg.paid / agg.total) * 100) : 0,
      };
    });

    return performance.sort((a, b) => b.totalRevenue - a.totalRevenue);
  }

  /**
   * Get IA vs Human metrics — H-DASH-4
   *
   * Lê dados REAIS de ConversationCycle via chatMetricsService (mesma fonte
   * usada pelo Dashboard de Chat) ao invés do placeholder hardcoded antigo.
   *
   * Numerador (resolvedByAi/Human) e denominador (soma dos dois) ficam no
   * mesmo domínio (ciclos resolvidos) — evita o bug "800%" causado por
   * misturar contagem de ciclos com count de Conversation.
   *
   * Filtros: respeita janela [startDate, endDate] do request. Sem datas
   * informadas, usa últimos 30 dias como default razoável p/ widget.
   */
  async getIAvsHuman(accountId: string, filters: DateRangeFilter) {
    const toDate = filters.endDate ?? new Date();
    const fromDate = filters.startDate ?? subDays(toDate, 30);

    const metrics = await chatMetricsService.getMetrics(accountId, {
      fromDate,
      toDate,
    });

    const iaInteractions = metrics.resolvedByAi;
    const humanInteractions = metrics.resolvedByHuman;
    const totalInteractions = iaInteractions + humanInteractions;

    const iaPercentage =
      totalInteractions > 0
        ? Math.round((iaInteractions / totalInteractions) * 1000) / 10
        : 0;
    const humanPercentage =
      totalInteractions > 0
        ? Math.round((humanInteractions / totalInteractions) * 1000) / 10
        : 0;

    return {
      totalInteractions,
      iaInteractions,
      humanInteractions,
      iaPercentage,
      humanPercentage,
    };
  }

  /**
   * Get server resources (Super Admin only) - Real metrics
   */
  async getServerResources() {
    return metricsCollector.getCurrentResources();
  }

  /**
   * Get consumption history (Super Admin only) - Real metrics
   */
  async getConsumptionHistory(period: '24h' | '7d' | '30d') {
    return metricsCollector.getHistory(period);
  }

  /**
   * Get weekly consumption averages (Super Admin only)
   */
  async getWeeklyConsumption() {
    return metricsCollector.getWeeklyConsumption();
  }
}

export const dashboardService = new DashboardService();

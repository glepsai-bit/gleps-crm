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

    const [
      totalLeads,
      newLeads,
      totalSales,
      paidSales,
      totalRevenue,
      conversionRate,
    ] = await Promise.all([
      prisma.contact.count({ where: { accountId } }),
      prisma.contact.count({ where: { accountId, createdAt: where.createdAt } }),
      prisma.sale.count({ where }),
      prisma.sale.count({ where: { ...where, status: 'paid' } }),
      prisma.sale.aggregate({
        where: { ...where, status: 'paid' },
        _sum: { valor: true },
      }),
      Promise.resolve(null), // Will calculate below
    ]);

    return {
      totalLeads,
      newLeads,
      totalSales,
      paidSales,
      totalRevenue: Number(totalRevenue._sum.valor || 0),
      conversionRate: totalSales > 0 ? Math.round((paidSales / totalSales) * 100) : 0,
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

    // Get performance data for each agent
    const performance = await Promise.all(
      users.map(async (user) => {
        const [totalSales, paidSales, totalRevenue] = await Promise.all([
          prisma.sale.count({ where: { ...saleWhere, responsavelId: user.id } }),
          prisma.sale.count({ where: { ...saleWhere, responsavelId: user.id, status: 'paid' } }),
          prisma.sale.aggregate({
            where: { ...saleWhere, responsavelId: user.id, status: 'paid' },
            _sum: { valor: true },
          }),
        ]);

        return {
          user: {
            id: user.id,
            nome: user.nome,
            email: user.email,
            role: user.role,
          },
          totalSales,
          paidSales,
          totalRevenue: Number(totalRevenue._sum.valor || 0),
          conversionRate: totalSales > 0 ? Math.round((paidSales / totalSales) * 100) : 0,
        };
      })
    );

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

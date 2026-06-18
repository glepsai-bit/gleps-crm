import { prisma } from '../config/database';
import { DateRangeFilter } from '../types';
import { subDays } from 'date-fns';
import { metricsCollector } from './metrics-collector';

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
   * Get IA vs Human metrics (placeholder - would integrate with Chatwoot)
   */
  async getIAvsHuman(accountId: string, filters: DateRangeFilter) {
    // This would typically integrate with Chatwoot to get actual bot vs human metrics
    // For now, return placeholder data
    return {
      totalInteractions: 100,
      iaInteractions: 40,
      humanInteractions: 60,
      iaPercentage: 40,
      humanPercentage: 60,
    };
  }

  /**
   * Get "Dinheiro na Mesa" (T-017)
   * Soma orcamentos pendentes (outcomeValue) por outcome, em uma janela.
   * Retorna no formato esperado pelo frontend (RespostaDinheiroMesa):
   *   { totalCents, count, breakdown: [{ outcome, count, sumCents }] }
   *
   * Mapeamento outcome -> string snake_case (compativel com o front).
   */
  async getDinheiroMesa(accountId: string, range: '7d' | '30d' | '90d') {
    const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;
    const since = subDays(new Date(), days);

    // Considera apenas appointments com outcome registrado e valor informado.
    // PENDING e NULL ficam de fora — sem outcome decidido, nao ha "dinheiro na mesa".
    const events = await prisma.calendarEvent.findMany({
      where: {
        accountId,
        type: 'appointment',
        endTime: { gte: since },
        outcomeValue: { not: null },
        outcome: { in: ['CLOSED', 'CONSIDERING', 'NOT_INTERESTED', 'RETURN_REQUESTED'] },
      },
      select: { outcome: true, outcomeValue: true },
    });

    // Mapa enum Prisma -> chave snake_case do front
    const outcomeKey: Record<string, string> = {
      CLOSED: 'fechou_tratamento',
      CONSIDERING: 'vai_pensar',
      NOT_INTERESTED: 'sem_interesse',
      RETURN_REQUESTED: 'pediu_retorno',
    };

    const grouped = new Map<string, { count: number; sumCents: number }>();
    let totalCents = 0;
    let count = 0;

    for (const e of events) {
      const key = outcomeKey[e.outcome as string];
      if (!key) continue;
      // outcomeValue eh Decimal(12,2) em reais — converte para centavos.
      const cents = Math.round(Number(e.outcomeValue) * 100);
      const cur = grouped.get(key) ?? { count: 0, sumCents: 0 };
      cur.count += 1;
      cur.sumCents += cents;
      grouped.set(key, cur);
      totalCents += cents;
      count += 1;
    }

    const breakdown = Array.from(grouped.entries())
      .map(([outcome, v]) => ({ outcome, count: v.count, sumCents: v.sumCents }))
      .sort((a, b) => b.sumCents - a.sumCents);

    return { totalCents, count, breakdown };
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

import { prisma } from '../config/database';
import { DateRangeFilter } from '../types';
import { startOfDay, endOfDay, eachDayOfInterval, eachWeekOfInterval, eachMonthOfInterval, subDays, format } from 'date-fns';

type Granularity = 'day' | 'week' | 'month';

class FinanceService {
  /**
   * Get finance KPIs
   */
  async getKPIs(accountId: string, filters: DateRangeFilter) {
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

    const [
      totalSales,
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
      prisma.sale.count({ where: { ...where, isRecurring: true } }),
    ]);

    return {
      totalSales,
      paidSales,
      pendingSales,
      refundedSales,
      recurringSales,
      totalRevenue: Number(totalRevenue._sum.valor || 0),
      pendingRevenue: Number(pendingRevenue._sum.valor || 0),
      refundedRevenue: Number(refundedRevenue._sum.valor || 0),
      avgTicket: Number(avgTicket._avg.valor || 0),
      conversionRate: totalSales > 0 ? Math.round((paidSales / totalSales) * 100) : 0,
      recurringRate: paidSales > 0 ? Math.round((recurringSales / paidSales) * 100) : 0,
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

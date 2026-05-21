import { prisma } from '../config/database';
import { DateRangeFilter } from '../types';
import { subDays } from 'date-fns';

class InsightsService {
  /**
   * Get insights KPIs
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
      totalLeads,
      totalSales,
      totalRevenue,
      avgTicket,
      uniqueProducts,
    ] = await Promise.all([
      prisma.contact.count({ where: { accountId, createdAt: where.createdAt } }),
      prisma.sale.count({ where: { ...where, status: 'paid' } }),
      prisma.sale.aggregate({
        where: { ...where, status: 'paid' },
        _sum: { valor: true },
      }),
      prisma.sale.aggregate({
        where: { ...where, status: 'paid' },
        _avg: { valor: true },
      }),
      prisma.saleItem.findMany({
        where: {
          sale: { ...where, status: 'paid' },
        },
        select: { productId: true },
        distinct: ['productId'],
      }),
    ]);

    return {
      totalLeads,
      totalSales,
      totalRevenue: Number(totalRevenue._sum.valor || 0),
      avgTicket: Number(avgTicket._avg.valor || 0),
      uniqueProductsSold: uniqueProducts.length,
      leadsToSalesConversion: totalLeads > 0 ? Math.round((totalSales / totalLeads) * 100) : 0,
    };
  }

  /**
   * Get product analysis
   */
  async getProductAnalysis(accountId: string, filters: DateRangeFilter) {
    const where: any = {
      sale: {
        accountId,
        status: 'paid',
      },
    };

    if (filters.startDate || filters.endDate) {
      where.sale.paidAt = {};
      if (filters.startDate) {
        where.sale.paidAt.gte = filters.startDate;
      }
      if (filters.endDate) {
        where.sale.paidAt.lte = filters.endDate;
      }
    }

    const products = await prisma.product.findMany({
      where: { accountId },
      include: {
        saleItems: {
          where,
          select: {
            quantidade: true,
            valorTotal: true,
            refunded: true,
          },
        },
      },
    });

    const analysis = products.map(product => {
      const soldItems = product.saleItems.filter(i => !i.refunded);
      const totalQuantity = soldItems.reduce((sum, i) => sum + i.quantidade, 0);
      const totalRevenue = soldItems.reduce((sum, i) => sum + Number(i.valorTotal), 0);
      const refundedItems = product.saleItems.filter(i => i.refunded);
      const refundedQuantity = refundedItems.reduce((sum, i) => sum + i.quantidade, 0);

      return {
        id: product.id,
        nome: product.nome,
        valorPadrao: Number(product.valorPadrao),
        ativo: product.ativo,
        totalQuantity,
        totalRevenue,
        avgPrice: totalQuantity > 0 ? totalRevenue / totalQuantity : 0,
        refundedQuantity,
        refundRate: totalQuantity > 0 ? Math.round((refundedQuantity / (totalQuantity + refundedQuantity)) * 100) : 0,
      };
    });

    return analysis.sort((a, b) => b.totalRevenue - a.totalRevenue);
  }

  /**
   * Get temporal analysis
   */
  async getTemporalAnalysis(accountId: string, filters: DateRangeFilter) {
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

    // Analyze by day of week
    const dayOfWeek: Record<number, { count: number; revenue: number }> = {};
    for (let i = 0; i < 7; i++) {
      dayOfWeek[i] = { count: 0, revenue: 0 };
    }

    // Analyze by hour
    const hourOfDay: Record<number, { count: number; revenue: number }> = {};
    for (let i = 0; i < 24; i++) {
      hourOfDay[i] = { count: 0, revenue: 0 };
    }

    for (const sale of sales) {
      if (sale.paidAt) {
        const day = sale.paidAt.getDay();
        const hour = sale.paidAt.getHours();
        const valor = Number(sale.valor);

        dayOfWeek[day].count++;
        dayOfWeek[day].revenue += valor;

        hourOfDay[hour].count++;
        hourOfDay[hour].revenue += valor;
      }
    }

    const dayNames = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

    return {
      byDayOfWeek: Object.entries(dayOfWeek).map(([day, data]) => ({
        day: parseInt(day),
        dayName: dayNames[parseInt(day)],
        ...data,
      })),
      byHourOfDay: Object.entries(hourOfDay).map(([hour, data]) => ({
        hour: parseInt(hour),
        ...data,
      })),
      peakDay: dayNames[
        Object.entries(dayOfWeek).reduce((max, [day, data]) =>
          data.count > dayOfWeek[max].count ? parseInt(day) : max, 0)
      ],
      peakHour: Object.entries(hourOfDay).reduce((max, [hour, data]) =>
        data.count > hourOfDay[parseInt(max)].count ? hour : max, '0'),
    };
  }

  /**
   * Get marketing metrics (lead origins)
   */
  async getMarketingMetrics(accountId: string, filters: DateRangeFilter) {
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

    const byOrigin = await prisma.contact.groupBy({
      by: ['origem'],
      where,
      _count: { id: true },
    });

    const total = byOrigin.reduce((sum, o) => sum + o._count.id, 0);

    // Get conversion by origin
    const originConversion = await Promise.all(
      byOrigin.map(async (origin) => {
        const contactsWithSales = await prisma.contact.count({
          where: {
            accountId,
            origem: origin.origem,
            sales: { some: { status: 'paid' } },
          },
        });

        return {
          origem: origin.origem || 'não informado',
          count: origin._count.id,
          percentage: total > 0 ? Math.round((origin._count.id / total) * 100) : 0,
          conversions: contactsWithSales,
          conversionRate: origin._count.id > 0
            ? Math.round((contactsWithSales / origin._count.id) * 100)
            : 0,
        };
      })
    );

    return {
      byOrigin: originConversion,
      totalLeads: total,
      bestOrigin: originConversion.reduce((best, current) =>
        current.conversionRate > (best?.conversionRate || 0) ? current : best, originConversion[0]),
    };
  }

  /**
   * Get payment methods analysis
   */
  async getPaymentMethodsAnalysis(accountId: string, filters: DateRangeFilter) {
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

    const byMethod = await prisma.sale.groupBy({
      by: ['metodoPagamento'],
      where,
      _count: { id: true },
      _sum: { valor: true },
      _avg: { valor: true },
    });

    const total = byMethod.reduce((sum, m) => sum + m._count.id, 0);
    const totalRevenue = byMethod.reduce((sum, m) => sum + Number(m._sum.valor || 0), 0);

    return byMethod.map(m => ({
      method: m.metodoPagamento,
      count: m._count.id,
      revenue: Number(m._sum.valor || 0),
      avgTicket: Number(m._avg.valor || 0),
      countPercentage: total > 0 ? Math.round((m._count.id / total) * 100) : 0,
      revenuePercentage: totalRevenue > 0 ? Math.round((Number(m._sum.valor || 0) / totalRevenue) * 100) : 0,
    }));
  }

  /**
   * Get automatic insights (AI-generated suggestions)
   */
  async getAutomaticInsights(accountId: string, filters: DateRangeFilter) {
    const insights: Array<{
      type: 'success' | 'warning' | 'info';
      title: string;
      description: string;
      metric?: string;
    }> = [];

    // Get current period data
    const kpis = await this.getKPIs(accountId, filters);
    const products = await this.getProductAnalysis(accountId, filters);
    const temporal = await this.getTemporalAnalysis(accountId, filters);
    const marketing = await this.getMarketingMetrics(accountId, filters);

    // Generate insights based on data

    // Conversion insight
    if (kpis.leadsToSalesConversion > 30) {
      insights.push({
        type: 'success',
        title: 'Boa taxa de conversão',
        description: `Sua taxa de conversão de ${kpis.leadsToSalesConversion}% está acima da média.`,
        metric: `${kpis.leadsToSalesConversion}%`,
      });
    } else if (kpis.leadsToSalesConversion < 10) {
      insights.push({
        type: 'warning',
        title: 'Taxa de conversão baixa',
        description: 'Considere revisar o processo de vendas para melhorar a conversão.',
        metric: `${kpis.leadsToSalesConversion}%`,
      });
    }

    // Best product insight
    if (products.length > 0) {
      const bestProduct = products[0];
      insights.push({
        type: 'info',
        title: 'Produto mais vendido',
        description: `"${bestProduct.nome}" lidera com ${bestProduct.totalQuantity} vendas.`,
        metric: `R$ ${bestProduct.totalRevenue.toFixed(2)}`,
      });
    }

    // Peak time insight
    insights.push({
      type: 'info',
      title: 'Horário de pico',
      description: `O melhor horário para vendas é às ${temporal.peakHour}h.`,
      metric: temporal.peakDay,
    });

    // Best origin insight
    if (marketing.bestOrigin) {
      insights.push({
        type: 'success',
        title: 'Melhor canal de aquisição',
        description: `${marketing.bestOrigin.origem} tem a melhor taxa de conversão.`,
        metric: `${marketing.bestOrigin.conversionRate}%`,
      });
    }

    // High refund alert
    const highRefundProducts = products.filter(p => p.refundRate > 20);
    if (highRefundProducts.length > 0) {
      insights.push({
        type: 'warning',
        title: 'Produtos com alto estorno',
        description: `${highRefundProducts.length} produto(s) têm taxa de estorno acima de 20%.`,
        metric: `${highRefundProducts.length} produtos`,
      });
    }

    return insights;
  }

  /**
   * Get agents ranking
   */
  async getAgentsRanking(accountId: string, filters: DateRangeFilter) {
    const users = await prisma.user.findMany({
      where: {
        accountId,
        role: { in: ['admin', 'agent'] },
        status: 'active',
      },
      select: {
        id: true,
        nome: true,
        email: true,
        role: true,
      },
    });

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

    const ranking = await Promise.all(
      users.map(async (user) => {
        const [salesCount, revenue, avgTicket] = await Promise.all([
          prisma.sale.count({ where: { ...where, responsavelId: user.id } }),
          prisma.sale.aggregate({
            where: { ...where, responsavelId: user.id },
            _sum: { valor: true },
          }),
          prisma.sale.aggregate({
            where: { ...where, responsavelId: user.id },
            _avg: { valor: true },
          }),
        ]);

        return {
          user,
          salesCount,
          revenue: Number(revenue._sum.valor || 0),
          avgTicket: Number(avgTicket._avg.valor || 0),
        };
      })
    );

    return ranking.sort((a, b) => b.revenue - a.revenue).map((r, index) => ({
      ...r,
      rank: index + 1,
    }));
  }
}

export const insightsService = new InsightsService();

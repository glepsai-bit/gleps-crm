import { prisma } from '../config/database';

export interface AudienceLeadInput {
  name: string;
  phone?: string | null;
  address?: string | null;
  rating?: number | null;
  website?: string | null;
  category?: string | null;
  rawData?: any;
}

class ProspectingAudienceService {
  /**
   * List saved audiences for an account
   */
  async list(accountId: string) {
    return prisma.prospectingAudience.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        keyword: true,
        location: true,
        totalLeads: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  /**
   * Create a new audience with its leads
   */
  async create(
    accountId: string,
    createdBy: string | null,
    data: { name: string; description?: string; keyword?: string; location?: string; leads: AudienceLeadInput[] }
  ) {
    const audience = await prisma.prospectingAudience.create({
      data: {
        accountId,
        createdBy,
        name: data.name,
        description: data.description || null,
        keyword: data.keyword || null,
        location: data.location || null,
        totalLeads: data.leads.length,
        leads: {
          createMany: {
            data: data.leads.map((l) => ({
              name: l.name,
              phone: l.phone || null,
              address: l.address || null,
              rating: l.rating != null ? l.rating : null,
              website: l.website || null,
              category: l.category || null,
              rawData: l.rawData ?? null,
            })),
          },
        },
      },
      select: { id: true, name: true, totalLeads: true },
    });
    return audience;
  }

  /**
   * Get audience details + leads
   */
  async getWithLeads(accountId: string, audienceId: string) {
    const audience = await prisma.prospectingAudience.findFirst({
      where: { id: audienceId, accountId },
      include: {
        leads: { orderBy: { createdAt: 'asc' } },
      },
    });
    return audience;
  }

  /**
   * Delete an audience (cascades leads)
   */
  async delete(accountId: string, audienceId: string) {
    await prisma.prospectingAudience.deleteMany({
      where: { id: audienceId, accountId },
    });
  }
}

export const prospectingAudienceService = new ProspectingAudienceService();

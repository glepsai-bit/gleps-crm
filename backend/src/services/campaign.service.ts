import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function ensureAudienceBelongsToAccount(audienceId: string | null | undefined, accountId: string) {
  if (!audienceId) return;

  const audience = await prisma.emailAudience.findFirst({
    where: { id: audienceId, accountId },
    select: { id: true },
  });

  if (!audience) {
    throw new Error('Público não encontrado para esta conta');
  }
}

async function ensureCampaignBelongsToAccount(id: string, accountId: string) {
  const campaign = await prisma.emailCampaign.findFirst({
    where: { id, accountId },
    select: { id: true },
  });

  if (!campaign) {
    throw new Error('Campanha não encontrada');
  }
}

export const campaignService = {
  async list(accountId: string) {
    return prisma.emailCampaign.findMany({
      where: { accountId },
      include: {
        audience: { select: { id: true, name: true } },
        cadences: {
          include: { steps: { orderBy: { ordem: 'asc' } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  },

  async get(id: string, accountId: string) {
    return prisma.emailCampaign.findFirst({
      where: { id, accountId },
      include: {
        audience: { select: { id: true, name: true } },
        cadences: {
          include: {
            steps: { orderBy: { ordem: 'asc' } },
            enrollments: { select: { id: true, status: true } },
          },
        },
      },
    });
  },

  async create(data: { accountId: string; name: string; description?: string; createdBy?: string; audienceId?: string | null }) {
    await ensureAudienceBelongsToAccount(data.audienceId, data.accountId);

    return prisma.emailCampaign.create({
      data: {
        accountId: data.accountId,
        name: data.name,
        description: data.description,
        createdBy: data.createdBy,
        audienceId: data.audienceId ?? null,
      },
      include: {
        audience: { select: { id: true, name: true } },
        cadences: { include: { steps: { orderBy: { ordem: 'asc' } } } },
      },
    });
  },

  async update(id: string, accountId: string, data: { name?: string; description?: string; active?: boolean; audienceId?: string | null }) {
    await ensureCampaignBelongsToAccount(id, accountId);
    await ensureAudienceBelongsToAccount(data.audienceId, accountId);

    return prisma.emailCampaign.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.active !== undefined && { active: data.active }),
        ...(data.audienceId !== undefined && { audienceId: data.audienceId }),
      },
      include: {
        audience: { select: { id: true, name: true } },
        cadences: { include: { steps: { orderBy: { ordem: 'asc' } } } },
      },
    });
  },

  async delete(id: string, accountId: string) {
    await ensureCampaignBelongsToAccount(id, accountId);

    // Unlink cadences first
    await prisma.emailCadence.updateMany({
      where: { campaignId: id, accountId },
      data: { campaignId: null },
    });

    return prisma.emailCampaign.delete({ where: { id } });
  },

  async addCadence(campaignId: string, cadenceId: string, accountId: string) {
    await ensureCampaignBelongsToAccount(campaignId, accountId);

    const cadence = await prisma.emailCadence.findFirst({
      where: { id: cadenceId, accountId },
      select: { id: true },
    });

    if (!cadence) {
      throw new Error('Cadência não encontrada');
    }

    return prisma.emailCadence.update({
      where: { id: cadenceId },
      data: { campaignId },
    });
  },

  async removeCadence(campaignId: string, cadenceId: string, accountId: string) {
    await ensureCampaignBelongsToAccount(campaignId, accountId);

    const cadence = await prisma.emailCadence.findFirst({
      where: { id: cadenceId, accountId, campaignId },
      select: { id: true },
    });

    if (!cadence) {
      throw new Error('Cadência não encontrada');
    }

    return prisma.emailCadence.update({
      where: { id: cadenceId },
      data: { campaignId: null },
    });
  },

  async getStats(campaignId: string, accountId: string) {
    await ensureCampaignBelongsToAccount(campaignId, accountId);

    const cadences = await prisma.emailCadence.findMany({
      where: { campaignId, accountId },
      select: { id: true },
    });
    const cadenceIds = cadences.map(c => c.id);
    if (cadenceIds.length === 0) return { total: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, failed: 0, enrollments: 0 };

     // Conta envios pelo status atual; eventos cumulam hierarquicamente.
     const [total, sentOnly, deliveredOnly, openedOnly, clickedOnly, bounced, failed, distinctEnrollments] = await Promise.all([
       prisma.emailSend.count({ where: { enrollment: { cadenceId: { in: cadenceIds } } } }),
       prisma.emailSend.count({ where: { enrollment: { cadenceId: { in: cadenceIds } }, status: 'sent' } }),
       prisma.emailSend.count({ where: { enrollment: { cadenceId: { in: cadenceIds } }, status: 'delivered' } }),
       prisma.emailSend.count({ where: { enrollment: { cadenceId: { in: cadenceIds } }, status: 'opened' } }),
       prisma.emailSend.count({ where: { enrollment: { cadenceId: { in: cadenceIds } }, status: 'clicked' } }),
       prisma.emailSend.count({ where: { enrollment: { cadenceId: { in: cadenceIds } }, status: 'bounced' } }),
       prisma.emailSend.count({ where: { enrollment: { cadenceId: { in: cadenceIds } }, status: 'failed' } }),
       // Contatos únicos inscritos (não enrollments duplicados de re-disparos)
       prisma.emailEnrollment.findMany({
         where: { cadenceId: { in: cadenceIds } },
         distinct: ['contactId'],
         select: { contactId: true },
       }),
     ]);

     // Métricas cumulativas: quem clicou também abriu, quem abriu também recebeu, quem recebeu também foi enviado.
     const clicked = clickedOnly;
     const opened = openedOnly + clickedOnly;
     const delivered = deliveredOnly + opened;
     const sent = sentOnly + delivered;
     const enrollments = distinctEnrollments.length;

     return { total, sent, delivered, opened, clicked, bounced, failed, enrollments };
  },

  /**
   * Dispatch the campaign immediately:
   * 1) Pick the cadence (provided or first linked one).
   * 2) Enroll all contacts from the campaign's audience that aren't already enrolled.
   *    Each new enrollment is set with nextSendAt = now so the processor sends Step 1 immediately.
   * 3) Process the queue right away.
   */
  async dispatchNow(campaignId: string, accountId: string, cadenceId?: string) {
    await ensureCampaignBelongsToAccount(campaignId, accountId);

    const campaign = await prisma.emailCampaign.findFirst({
      where: { id: campaignId, accountId },
      include: {
        cadences: { include: { steps: { orderBy: { ordem: 'asc' } } } },
      },
    });
    if (!campaign) throw new Error('Campanha não encontrada');
    if (!campaign.audienceId) throw new Error('Vincule um público à campanha antes de disparar');

    const cadences = campaign.cadences || [];
    if (cadences.length === 0) throw new Error('Crie ao menos uma cadência nesta campanha');

    const cadence = cadenceId
      ? cadences.find(c => c.id === cadenceId)
      : cadences[0];
    if (!cadence) throw new Error('Cadência não encontrada nesta campanha');
    if (!cadence.steps.length) throw new Error('A cadência selecionada não possui steps');

    // Load audience contacts with email
    const audienceLinks = await prisma.emailAudienceContact.findMany({
      where: { audienceId: campaign.audienceId },
      include: { contact: { select: { id: true, email: true } } },
    });
    const eligibleContactIds = audienceLinks
      .filter(l => !!l.contact?.email)
      .map(l => l.contactId);

    if (eligibleContactIds.length === 0) {
      throw new Error('Nenhum contato com e-mail no público vinculado');
    }

    // Skip contatos que já passaram pela cadência: active, paused E completed.
    // Sem isso, cada clique em "Disparar agora" criava um enrollment novo para o mesmo
    // contato, inflando os números (ex.: público de 1 contato com 3 inscritos / 3 envios).
    const existing = await prisma.emailEnrollment.findMany({
      where: {
        cadenceId: cadence.id,
        contactId: { in: eligibleContactIds },
        status: { in: ['active', 'paused', 'completed'] },
      },
      select: { contactId: true },
    });
    const skip = new Set(existing.map(e => e.contactId));
    const toEnroll = eligibleContactIds.filter(id => !skip.has(id));

    const now = new Date();
    if (toEnroll.length > 0) {
      await prisma.emailEnrollment.createMany({
        data: toEnroll.map(contactId => ({
          accountId,
          cadenceId: cadence.id,
          contactId,
          currentStep: 0,
          status: 'active' as const,
          enrolledAt: now,
          nextSendAt: now, // send immediately
        })),
      });
    }

    // Trigger immediate processing
    const { emailService } = await import('./email.service');

    // Quota check: avisa (mas não bloqueia o enroll) se cota estourar
    const quota = await emailService.checkEmailQuota(accountId);
    if (!quota.canSend) {
      const reason = quota.daily.remaining <= 0
        ? `Limite diário de e-mails (${quota.daily.limit}) atingido. Os envios serão retomados após ${new Date(quota.daily.resetAt).toLocaleString('pt-BR')}.`
        : `Limite mensal de e-mails (${quota.monthly.limit}) atingido. Os envios serão retomados após ${new Date(quota.monthly.resetAt).toLocaleString('pt-BR')}.`;
      throw new Error(reason);
    }

    const processed = await emailService.processCadenceQueue();

    return {
      enrolled: toEnroll.length,
      skipped: skip.size,
      processed,
      cadenceId: cadence.id,
      cadenceName: cadence.name,
    };
  },
};

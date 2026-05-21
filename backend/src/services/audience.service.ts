import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const audienceService = {
  async list(accountId: string) {
    const audiences = await prisma.emailAudience.findMany({
      where: { accountId },
      include: {
        _count: { select: { contacts: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return audiences.map(a => ({
      ...a,
      contact_count: a._count.contacts,
      _count: undefined,
    }));
  },

  async get(id: string, accountId: string) {
    return prisma.emailAudience.findFirst({
      where: { id, accountId },
      include: {
        _count: { select: { contacts: true } },
      },
    });
  },

  async create(data: { accountId: string; name: string; description?: string; createdBy?: string }) {
    return prisma.emailAudience.create({
      data: {
        accountId: data.accountId,
        name: data.name,
        description: data.description || null,
        createdBy: data.createdBy || null,
      },
    });
  },

  async update(id: string, accountId: string, data: { name?: string; description?: string }) {
    return prisma.emailAudience.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
      },
    });
  },

  async delete(id: string, accountId: string) {
    // Verify ownership
    const audience = await prisma.emailAudience.findFirst({ where: { id, accountId } });
    if (!audience) throw new Error('Público não encontrado');
    await prisma.emailAudience.delete({ where: { id } });
  },

  async listContacts(audienceId: string, accountId: string) {
    // Verify ownership
    const audience = await prisma.emailAudience.findFirst({ where: { id: audienceId, accountId } });
    if (!audience) throw new Error('Público não encontrado');

    const links = await prisma.emailAudienceContact.findMany({
      where: { audienceId },
      include: {
        contact: { select: { id: true, nome: true, email: true, telefone: true } },
      },
    });
    return links.map(l => l.contact);
  },

  async addContacts(audienceId: string, accountId: string, contactIds: string[]) {
    const audience = await prisma.emailAudience.findFirst({ where: { id: audienceId, accountId } });
    if (!audience) throw new Error('Público não encontrado');

    const inserts = contactIds.map(contactId => ({
      audienceId,
      contactId,
    }));

    // Use skipDuplicates to handle already-added contacts
    await prisma.emailAudienceContact.createMany({
      data: inserts,
      skipDuplicates: true,
    });

    return { added: contactIds.length };
  },

  async removeContact(audienceId: string, accountId: string, contactId: string) {
    const audience = await prisma.emailAudience.findFirst({ where: { id: audienceId, accountId } });
    if (!audience) throw new Error('Público não encontrado');

    await prisma.emailAudienceContact.deleteMany({
      where: { audienceId, contactId },
    });
  },

  async importContacts(audienceId: string, accountId: string, rows: { nome?: string; email: string }[]) {
    const audience = await prisma.emailAudience.findFirst({ where: { id: audienceId, accountId } });
    if (!audience) throw new Error('Público não encontrado');

    let added = 0;
    for (const row of rows) {
      // Find or create contact
      let contact = await prisma.contact.findFirst({
        where: { accountId, email: { equals: row.email, mode: 'insensitive' } },
      });

      if (!contact) {
        contact = await prisma.contact.create({
          data: { accountId, nome: row.nome || null, email: row.email },
        });
      }

      // Link to audience
      try {
        await prisma.emailAudienceContact.create({
          data: { audienceId, contactId: contact.id },
        });
        added++;
      } catch {
        // Skip duplicates
      }
    }

    return { added };
  },
};

import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

export const inboxService = {
  async listMessages(accountId: string, filters?: { read?: boolean; contactId?: string; limit?: number; offset?: number }) {
    const where: any = { accountId };
    if (filters?.read !== undefined) where.read = filters.read;
    if (filters?.contactId) where.contactId = filters.contactId;

    return prisma.emailInboxMessage.findMany({
      where,
      include: { contact: { select: { id: true, nome: true, email: true } } },
      orderBy: { receivedAt: 'desc' },
      take: filters?.limit || 50,
      skip: filters?.offset || 0,
    });
  },

  async getMessage(id: string) {
    return prisma.emailInboxMessage.findUnique({
      where: { id },
      include: {
        contact: { select: { id: true, nome: true, email: true } },
        enrollment: { include: { cadence: { select: { id: true, name: true } } } },
      },
    });
  },

  async markRead(id: string) {
    return prisma.emailInboxMessage.update({
      where: { id },
      data: { read: true },
    });
  },

  async getUnreadCount(accountId: string) {
    return prisma.emailInboxMessage.count({ where: { accountId, read: false } });
  },

  /**
   * Process an inbound email (from SendGrid Inbound Parse).
   * Auto-pauses the associated enrollment if one is found.
   */
  async processInboundEmail(data: {
    fromEmail: string;
    toEmail: string;
    subject: string;
    bodyText?: string;
    bodyHtml?: string;
    inReplyTo?: string;
  }) {
    try {
      // Find contact by email
      const contact = await prisma.contact.findFirst({
        where: { email: data.fromEmail.toLowerCase() },
        include: {
          emailEnrollments: {
            where: { status: 'active' },
            include: { cadence: { select: { accountId: true } } },
          },
        },
      });

      if (!contact) {
        logger.info(`[Inbox] No contact found for ${data.fromEmail}, skipping.`);
        return null;
      }

      const activeEnrollment = contact.emailEnrollments[0];
      const accountId = contact.accountId;

      // Create inbox message
      const message = await prisma.emailInboxMessage.create({
        data: {
          accountId,
          contactId: contact.id,
          fromEmail: data.fromEmail,
          toEmail: data.toEmail,
          subject: data.subject,
          bodyText: data.bodyText,
          bodyHtml: data.bodyHtml,
          inReplyTo: data.inReplyTo,
          enrollmentId: activeEnrollment?.id,
        },
      });

      // Auto-pause enrollment on reply
      if (activeEnrollment) {
        await prisma.emailEnrollment.update({
          where: { id: activeEnrollment.id },
          data: { status: 'paused' },
        });
        logger.info(`[Inbox] Auto-paused enrollment ${activeEnrollment.id} for contact ${contact.id} (reply detected)`);
      }

      return message;
    } catch (error: any) {
      logger.error(`[Inbox] Error processing inbound email: ${error.message}`);
      throw error;
    }
  },
};

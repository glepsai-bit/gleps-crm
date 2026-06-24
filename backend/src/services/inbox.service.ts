import type { Inbox } from '@prisma/client';
import { prisma as sharedPrisma } from '../config/database';
import { NotFoundError, ConflictError, ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';
import { evolutionService, type QrCodeResult } from './evolution.service';

// Reuse a single Prisma pool (singleton from config/database).
// Não criar new PrismaClient() aqui — vaza connection pool (H1).
const prisma = sharedPrisma;

// ============================================
// Email Inbox (mensagens recebidas via SendGrid Inbound Parse)
// ============================================
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
      // H2 fix: rotear primeiro pelo toEmail (alias do tenant em
      // sendgridFromEmail) pra evitar vazamento multi-tenant.
      // Sem accountId derivado do toEmail, um findFirst só por email
      // pode atribuir a mensagem (e auto-pausar enrollment) ao tenant errado.
      const toEmail = (data.toEmail || '').trim().toLowerCase();
      if (!toEmail) {
        logger.warn('[Inbox] Inbound email sem toEmail — não dá pra rotear por tenant. Skipping.');
        return null;
      }

      const account = await prisma.account.findFirst({
        where: { sendgridFromEmail: toEmail },
        select: { id: true },
      });

      if (!account) {
        logger.info(`[Inbox] Nenhuma conta encontrada para toEmail=${toEmail}. Skipping.`);
        return null;
      }

      const accountId = account.id;

      // Agora sim — busca contato escopado pelo accountId do tenant.
      const contact = await prisma.contact.findFirst({
        where: {
          accountId,
          email: data.fromEmail.toLowerCase(),
        },
        include: {
          emailEnrollments: {
            where: { status: 'active' },
            include: { cadence: { select: { accountId: true } } },
          },
        },
      });

      if (!contact) {
        logger.info(`[Inbox] No contact found for ${data.fromEmail} dentro da conta ${accountId}, skipping.`);
        return null;
      }

      const activeEnrollment = contact.emailEnrollments[0];

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

// ============================================
// Inbox (canais — WhatsApp/Email/Facebook/Instagram)
// Modelo Prisma `Inbox` — usado pelo motor de conversas estilo Chatwoot (T-022).
// ============================================

export interface CreateInboxInput {
  name: string;
  channelType: string; // 'whatsapp' | 'email' | 'facebook' | 'instagram'
  evolutionInstance?: string | null;
  greeting?: string | null;
  businessHours?: any;
  defaultTeamId?: string | null;
}

export interface UpdateInboxInput {
  name?: string;
  channelType?: string;
  evolutionInstance?: string | null;
  greeting?: string | null;
  businessHours?: any;
  defaultTeamId?: string | null;
  active?: boolean;
}

class InboxService {
  /**
   * Lista todos os inboxes (canais) da conta.
   */
  async list(accountId: string): Promise<Inbox[]> {
    return sharedPrisma.inbox.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Busca um inbox específico, garantindo escopo de accountId.
   */
  async get(id: string, accountId: string): Promise<Inbox> {
    const inbox = await sharedPrisma.inbox.findFirst({
      where: { id, accountId },
    });

    if (!inbox) {
      throw new NotFoundError('Inbox');
    }

    return inbox;
  }

  /**
   * Cria um novo inbox (canal de atendimento).
   * Para channelType='whatsapp', evolutionInstance deve ser único por accountId.
   */
  async create(accountId: string, input: CreateInboxInput): Promise<Inbox> {
    if (input.channelType === 'whatsapp' && input.evolutionInstance) {
      const existing = await this.listByEvolutionInstance(
        accountId,
        input.evolutionInstance
      );
      if (existing) {
        throw new ConflictError(
          'Já existe um inbox para esta instância Evolution nesta conta'
        );
      }
    }

    return sharedPrisma.inbox.create({
      data: {
        accountId,
        name: input.name,
        channelType: input.channelType,
        evolutionInstance: input.evolutionInstance ?? null,
        greeting: input.greeting ?? null,
        businessHours: input.businessHours ?? undefined,
        defaultTeamId: input.defaultTeamId ?? null,
      },
    });
  }

  /**
   * Atualiza um inbox existente, garantindo escopo de accountId.
   * Valida unicidade de evolutionInstance se alterada.
   */
  async update(
    id: string,
    accountId: string,
    input: UpdateInboxInput
  ): Promise<Inbox> {
    const existing = await this.get(id, accountId);

    if (
      input.evolutionInstance !== undefined &&
      input.evolutionInstance &&
      input.evolutionInstance !== existing.evolutionInstance
    ) {
      const dup = await this.listByEvolutionInstance(
        accountId,
        input.evolutionInstance
      );
      if (dup && dup.id !== id) {
        throw new ConflictError(
          'Já existe um inbox para esta instância Evolution nesta conta'
        );
      }
    }

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.channelType !== undefined) data.channelType = input.channelType;
    if (input.evolutionInstance !== undefined)
      data.evolutionInstance = input.evolutionInstance;
    if (input.greeting !== undefined) data.greeting = input.greeting;
    if (input.businessHours !== undefined)
      data.businessHours = input.businessHours;
    if (input.defaultTeamId !== undefined)
      data.defaultTeamId = input.defaultTeamId;
    if (input.active !== undefined) data.active = input.active;

    return sharedPrisma.inbox.update({
      where: { id },
      data,
    });
  }

  /**
   * Remove um inbox (hard delete), garantindo escopo de accountId.
   * Cascade do Prisma cuida das conversations relacionadas.
   */
  async delete(id: string, accountId: string): Promise<void> {
    await this.get(id, accountId);
    await sharedPrisma.inbox.delete({ where: { id } });
  }

  /**
   * Busca um inbox pela instância Evolution dentro de uma conta.
   * Usado pelo webhook receiver (evolution.controller) pra rotear
   * mensagens recebidas pro inbox correto.
   */
  async listByEvolutionInstance(
    accountId: string,
    instance: string
  ): Promise<Inbox | null> {
    return sharedPrisma.inbox.findFirst({
      where: {
        accountId,
        evolutionInstance: instance,
      },
    });
  }

  /**
   * Garante que o Inbox tenha uma instance Evolution criada e retorna o QR code
   * pronto pra pareamento.
   *
   * Fluxo:
   *  1. Carrega o Inbox (com escopo de accountId).
   *  2. Valida channelType === 'whatsapp'.
   *  3. Se `evolutionInstance` ainda não está persistido, gera nome único
   *     (`acc-<8>-inb-<8>`), chama `evolutionService.createInstance` (resolve
   *     credenciais via SystemSettings global + fallback per-account) e persiste
   *     o nome no Inbox. O create já costuma vir com QR code no body.
   *  4. Se já existe instance, apenas chama `evolutionService.getQrCode` pra
   *     buscar um QR fresco (caso o anterior tenha expirado).
   *
   * Idempotente: chamar 2x não duplica instance — só re-emite QR.
   */
  async ensureEvolutionInstance(
    inboxId: string,
    accountId: string
  ): Promise<{ inbox: Inbox; qrcode: QrCodeResult }> {
    const inbox = await this.get(inboxId, accountId);

    if (inbox.channelType !== 'whatsapp') {
      throw new ValidationError(
        `Inbox ${inboxId} não é WhatsApp (channelType=${inbox.channelType})`
      );
    }

    // Caso 1: ainda não tem instance criada na Evolution — cria agora.
    if (!inbox.evolutionInstance) {
      const generatedInstance = `acc-${accountId.slice(0, 8)}-inb-${inboxId.slice(0, 8)}`;

      logger.info('[Inbox] criando instance Evolution', {
        accountId,
        inboxId,
        instance: generatedInstance,
      });

      const created = await evolutionService.createInstance(accountId, {
        instance: generatedInstance,
      });

      const updated = await sharedPrisma.inbox.update({
        where: { id: inboxId },
        data: { evolutionInstance: generatedInstance },
      });

      return {
        inbox: updated,
        qrcode: {
          qrcodeBase64: created.qrcodeBase64,
          code: created.code,
          raw: created.raw,
        },
      };
    }

    // Caso 2: instance já existe — só pede QR code fresco.
    const qrcode = await evolutionService.getQrCode(
      accountId,
      inbox.evolutionInstance
    );

    return { inbox, qrcode };
  }
}

export const inboxChannelService = new InboxService();

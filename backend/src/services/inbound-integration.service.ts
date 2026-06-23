import crypto from 'crypto';
import type { InboundIntegration } from '@prisma/client';
import { prisma } from '../config/database';
import { contactService } from './contact.service';
import { whatsappCampaignService } from './whatsapp-campaign.service';
import { eventService } from './event.service';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
} from '../utils/errors';
import { logger } from '../utils/logger';

// ============================================
// Types
// ============================================

export type InboundHandler = 'contact_upsert' | 'tag_apply' | 'campaign_trigger';

const ALLOWED_HANDLERS: InboundHandler[] = [
  'contact_upsert',
  'tag_apply',
  'campaign_trigger',
];

const SLUG_REGEX = /^[a-z0-9-]{2,80}$/;

export interface CreateInboundIntegrationInput {
  slug: string;
  handler: InboundHandler | string;
  config?: Record<string, any>;
  secret?: string;
}

export interface WebhookResult {
  handled: boolean;
  result?: any;
}

// ----- handler payload shapes -----

interface ContactUpsertPayload {
  nome?: string;
  telefone?: string;
  email?: string;
  tags?: string[]; // tag ids OR slugs
  customAttributes?: Record<string, any>;
}

interface TagApplyPayload {
  contactPhone?: string;
  contactId?: string;
  tagName?: string;
  tagId?: string;
  action?: 'add' | 'remove';
}

interface CampaignTriggerPayload {
  contactIds?: string[];
  phones?: string[] | { phone: string; name?: string; variables?: Record<string, string> }[];
  templateId?: string;
  content?: string;
  triggerName?: string;
  defaultVariables?: Record<string, string>;
  delaySeconds?: number;
  scheduledAt?: string | Date;
  metadata?: Record<string, any>;
}

// ============================================
// Helpers
// ============================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: string): boolean {
  return UUID_REGEX.test(v);
}

function normalizeEmail(email?: string): string | undefined {
  if (!email) return undefined;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePhone(phone?: string): string | undefined {
  if (!phone) return undefined;
  const trimmed = phone.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ============================================
// Service
// ============================================

class InboundIntegrationService {
  // ----------------------------------------
  // CRUD
  // ----------------------------------------

  async list(accountId: string): Promise<InboundIntegration[]> {
    return prisma.inboundIntegration.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(slug: string, accountId: string): Promise<InboundIntegration> {
    const integration = await prisma.inboundIntegration.findFirst({
      where: { accountId, slug },
    });
    if (!integration) {
      throw new NotFoundError('Integração de webhook');
    }
    return integration;
  }

  async create(
    accountId: string,
    input: CreateInboundIntegrationInput
  ): Promise<InboundIntegration> {
    const slug = (input.slug ?? '').trim().toLowerCase();

    if (!SLUG_REGEX.test(slug)) {
      throw new ValidationError(
        'Slug inválido: use 2-80 caracteres lowercase, alfanuméricos e hífen'
      );
    }

    if (!ALLOWED_HANDLERS.includes(input.handler as InboundHandler)) {
      throw new ValidationError(
        `Handler inválido: ${input.handler}. Permitidos: ${ALLOWED_HANDLERS.join(', ')}`
      );
    }

    const existing = await prisma.inboundIntegration.findFirst({
      where: { accountId, slug },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictError(
        `Já existe uma integração com slug "${slug}" para esta conta`
      );
    }

    const integration = await prisma.inboundIntegration.create({
      data: {
        accountId,
        slug,
        handler: input.handler,
        config: (input.config ?? {}) as any,
        secret: input.secret ?? null,
        active: true,
      },
    });

    await eventService.create({
      eventType: 'integration.inbound.created',
      accountId,
      actorType: 'system',
      entityType: 'inbound_integration',
      entityId: integration.id,
      payload: { slug: integration.slug, handler: integration.handler },
    });

    logger.info('[inbound-integration] criada', {
      accountId,
      slug,
      handler: integration.handler,
    });

    return integration;
  }

  async delete(slug: string, accountId: string): Promise<void> {
    const integration = await this.get(slug, accountId);

    await prisma.inboundIntegration.delete({
      where: { id: integration.id },
    });

    await eventService.create({
      eventType: 'integration.inbound.deleted',
      accountId,
      actorType: 'system',
      entityType: 'inbound_integration',
      entityId: integration.id,
      payload: { slug },
    });

    logger.info('[inbound-integration] removida', { accountId, slug });
  }

  // ----------------------------------------
  // Webhook processing
  // ----------------------------------------

  async processWebhook(
    accountId: string,
    slug: string,
    body: any,
    headers: Record<string, any>
  ): Promise<WebhookResult> {
    const integration = await prisma.inboundIntegration.findFirst({
      where: { accountId, slug, active: true },
    });

    if (!integration) {
      throw new NotFoundError('Integração de webhook ativa');
    }

    // HMAC validation when secret is configured
    if (integration.secret) {
      const signatureHeader =
        (headers['x-webhook-signature'] as string | undefined) ??
        (headers['X-Webhook-Signature'] as string | undefined);

      if (!signatureHeader) {
        throw new ValidationError('Assinatura HMAC ausente (x-webhook-signature)');
      }

      const expected = crypto
        .createHmac('sha256', integration.secret)
        .update(JSON.stringify(body))
        .digest('hex');

      const provided = signatureHeader.trim();
      const expectedBuf = Buffer.from(expected, 'utf8');
      const providedBuf = Buffer.from(provided, 'utf8');

      if (
        expectedBuf.length !== providedBuf.length ||
        !crypto.timingSafeEqual(expectedBuf, providedBuf)
      ) {
        logger.warn('[inbound-integration] HMAC inválido', {
          accountId,
          slug,
        });
        throw new ValidationError('Assinatura HMAC inválida');
      }
    }

    if (!body || typeof body !== 'object') {
      throw new ValidationError('Payload do webhook deve ser um objeto JSON');
    }

    let result: any;
    try {
      switch (integration.handler) {
        case 'contact_upsert':
          result = await this.handleContactUpsert(accountId, body as ContactUpsertPayload);
          break;
        case 'tag_apply':
          result = await this.handleTagApply(accountId, body as TagApplyPayload);
          break;
        case 'campaign_trigger':
          result = await this.handleCampaignTrigger(
            accountId,
            body as CampaignTriggerPayload
          );
          break;
        default:
          throw new ValidationError(
            `Handler desconhecido: ${integration.handler}`
          );
      }
    } catch (err: any) {
      logger.error('[inbound-integration] handler falhou', err, {
        accountId,
        slug,
        handler: integration.handler,
      });
      throw err;
    }

    await eventService.create({
      eventType: 'integration.inbound.received',
      accountId,
      actorType: 'system',
      entityType: 'inbound_integration',
      entityId: integration.id,
      payload: {
        slug,
        handler: integration.handler,
        result,
      },
    });

    return { handled: true, result };
  }

  // ----------------------------------------
  // Handlers
  // ----------------------------------------

  private async handleContactUpsert(
    accountId: string,
    payload: ContactUpsertPayload
  ): Promise<{ contactId: string; created: boolean; tagsApplied: number }> {
    const telefone = normalizePhone(payload.telefone);
    const email = normalizeEmail(payload.email);

    if (!telefone && !email) {
      throw new ValidationError(
        'contact_upsert requer telefone ou email para identificar o contato'
      );
    }

    // Busca por telefone OU email, escopado por accountId
    const orClauses: any[] = [];
    if (telefone) orClauses.push({ telefone });
    if (email) orClauses.push({ email });

    const existing = await prisma.contact.findFirst({
      where: {
        accountId,
        OR: orClauses,
      },
      select: { id: true },
    });

    let contactId: string;
    let created = false;

    if (existing) {
      const updated = await prisma.contact.update({
        where: { id: existing.id },
        data: {
          nome: payload.nome ?? undefined,
          telefone: telefone ?? undefined,
          email: email ?? undefined,
        },
        select: { id: true },
      });
      contactId = updated.id;
    } else {
      const newContact = await contactService.create({
        accountId,
        nome: payload.nome,
        telefone,
        email,
      });
      contactId = newContact.id;
      created = true;
    }

    // TODO: Contact.customAttributes (jsonb) ainda não existe no schema
    // — payload aceito por compatibilidade, mas ignorado por ora.
    if (payload.customAttributes && Object.keys(payload.customAttributes).length > 0) {
      logger.warn(
        '[inbound-integration] customAttributes ignorado — Contact.customAttributes não existe no schema',
        { accountId, contactId, keys: Object.keys(payload.customAttributes) }
      );
    }

    let tagsApplied = 0;
    if (Array.isArray(payload.tags) && payload.tags.length > 0) {
      for (const tagRef of payload.tags) {
        const tagId = await this.resolveTagId(accountId, tagRef);
        if (!tagId) {
          logger.warn('[inbound-integration] tag não encontrada, ignorada', {
            accountId,
            tagRef,
          });
          continue;
        }
        try {
          await contactService.applyTag(contactId, accountId, tagId, 'api');
          tagsApplied++;
        } catch (err: any) {
          logger.warn('[inbound-integration] falha ao aplicar tag', {
            accountId,
            contactId,
            tagId,
            error: err?.message ?? String(err),
          });
        }
      }
    }

    return { contactId, created, tagsApplied };
  }

  private async handleTagApply(
    accountId: string,
    payload: TagApplyPayload
  ): Promise<{ contactId: string; tagId: string; action: 'add' | 'remove' }> {
    const action: 'add' | 'remove' = payload.action === 'remove' ? 'remove' : 'add';

    // Resolve contact
    let contactId: string | undefined = payload.contactId;
    if (!contactId) {
      const phone = normalizePhone(payload.contactPhone);
      if (!phone) {
        throw new ValidationError(
          'tag_apply requer contactId ou contactPhone para identificar o contato'
        );
      }
      const contact = await prisma.contact.findFirst({
        where: { accountId, telefone: phone },
        select: { id: true },
      });
      if (!contact) {
        throw new NotFoundError('Contato (por telefone)');
      }
      contactId = contact.id;
    } else {
      // valida que o contato pertence à conta
      const owned = await prisma.contact.findFirst({
        where: { id: contactId, accountId },
        select: { id: true },
      });
      if (!owned) {
        throw new NotFoundError('Contato');
      }
    }

    // Resolve tag
    let tagId: string | undefined;
    if (payload.tagId) {
      tagId = payload.tagId;
    } else if (payload.tagName) {
      const resolved = await this.resolveTagId(accountId, payload.tagName);
      if (!resolved) {
        throw new NotFoundError('Tag');
      }
      tagId = resolved;
    } else {
      throw new ValidationError('tag_apply requer tagId ou tagName');
    }

    if (action === 'add') {
      await contactService.applyTag(contactId, accountId, tagId, 'api');
    } else {
      await contactService.removeTag(contactId, accountId, tagId, 'api');
    }

    return { contactId, tagId, action };
  }

  private async handleCampaignTrigger(
    accountId: string,
    payload: CampaignTriggerPayload
  ): Promise<{ batchId: string; totalContacts: number; scheduled: boolean }> {
    if (
      (!payload.contactIds || payload.contactIds.length === 0) &&
      (!payload.phones || payload.phones.length === 0)
    ) {
      throw new ValidationError(
        'campaign_trigger requer contactIds ou phones'
      );
    }
    if (!payload.templateId && !payload.content) {
      throw new ValidationError(
        'campaign_trigger requer templateId ou content'
      );
    }

    // Normaliza phones: aceita string[] ou objeto rico
    let phonesParam: { phone: string; name?: string; variables?: Record<string, string> }[] | undefined;
    if (payload.phones && payload.phones.length > 0) {
      phonesParam = payload.phones.map(p => {
        if (typeof p === 'string') return { phone: p };
        return { phone: p.phone, name: p.name, variables: p.variables };
      });
    }

    const scheduledAt =
      payload.scheduledAt
        ? payload.scheduledAt instanceof Date
          ? payload.scheduledAt
          : new Date(payload.scheduledAt)
        : undefined;

    const result = await whatsappCampaignService.sendBatch(accountId, {
      contactIds: payload.contactIds,
      phones: phonesParam,
      templateId: payload.templateId,
      content: payload.content,
      defaultVariables: payload.defaultVariables,
      delaySeconds: payload.delaySeconds,
      scheduledAt,
      source: 'integration',
      triggerName: payload.triggerName,
      metadata: payload.metadata,
    });

    return result;
  }

  // ----------------------------------------
  // Internal helpers
  // ----------------------------------------

  private async resolveTagId(accountId: string, ref: string): Promise<string | undefined> {
    if (!ref) return undefined;
    if (isUuid(ref)) {
      const byId = await prisma.tag.findFirst({
        where: { id: ref, accountId },
        select: { id: true },
      });
      return byId?.id;
    }

    // Tenta por slug primeiro, depois por nome
    const lower = ref.toLowerCase();
    const bySlug = await prisma.tag.findFirst({
      where: { accountId, slug: lower },
      select: { id: true },
    });
    if (bySlug) return bySlug.id;

    const byName = await prisma.tag.findFirst({
      where: { accountId, name: ref },
      select: { id: true },
    });
    return byName?.id;
  }
}

export const inboundIntegrationService = new InboundIntegrationService();

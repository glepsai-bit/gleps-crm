import type { DispatchBatch, DispatchLog } from '@prisma/client';
import { prisma } from '../config/database';
import { evolutionService } from './evolution.service';
import { whatsappTemplateService } from './whatsapp-template.service';
import { NotFoundError, ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';

// ============================================
// Types
// ============================================

export type CampaignSource = 'manual' | 'manual_scheduled' | 'n8n' | 'api' | 'integration';

export interface CampaignRecipient {
  phone: string;
  name?: string;
  contactId?: string;
  variables?: Record<string, string>;
}

export interface SendSingleParams {
  contactId?: string;
  phone?: string;
  contactName?: string;
  templateId?: string;
  content?: string;
  variables?: Record<string, string>;
  source: CampaignSource;
  triggerName?: string;
  metadata?: Record<string, any>;
}

export interface SendSingleResult {
  batchId: string;
  messageId?: string;
  status: 'sent' | 'failed';
  error?: string;
}

export interface SendBatchParams {
  contactIds?: string[];
  phones?: { phone: string; name?: string; variables?: Record<string, string> }[];
  templateId?: string;
  content?: string;
  defaultVariables?: Record<string, string>;
  scheduledAt?: Date;
  delaySeconds?: number;
  source: CampaignSource;
  triggerName?: string;
  metadata?: Record<string, any>;
}

export interface SendBatchResult {
  batchId: string;
  totalContacts: number;
  scheduled: boolean;
}

export interface ListBatchesFilters {
  status?: string;
  source?: CampaignSource;
  triggerName?: string;
  fromDate?: Date;
  toDate?: Date;
}

// ============================================
// Helpers
// ============================================

const DEFAULT_DELAY_SECONDS = 30;
const MIN_DELAY_MS = 1000;

function renderTemplate(content: string, variables: Record<string, string> = {}): string {
  if (!content) return '';
  return content.replace(/\{\{?\s*([\w.]+)\s*\}?\}/g, (_match, key) => {
    const value = variables[key];
    return value !== undefined && value !== null ? String(value) : '';
  });
}

class WhatsappCampaignService {
  // ============================================
  // sendSingle
  // ============================================

  async sendSingle(accountId: string, params: SendSingleParams): Promise<SendSingleResult> {
    if (!params.contactId && !params.phone) {
      throw new ValidationError('Informe contactId ou phone para enviar mensagem');
    }
    if (!params.templateId && !params.content) {
      throw new ValidationError('Informe templateId ou content para enviar mensagem');
    }

    // Resolve recipient (phone + name)
    let phone = params.phone ?? '';
    let contactName = params.contactName ?? '';

    if (params.contactId) {
      const contact = await prisma.contact.findFirst({
        where: { id: params.contactId, accountId },
        select: { id: true, nome: true, telefone: true },
      });
      if (!contact) throw new NotFoundError('Contato');
      if (!contact.telefone) {
        throw new ValidationError(`Contato ${contact.id} não possui telefone cadastrado`);
      }
      phone = contact.telefone;
      contactName = contact.nome ?? contactName;
    }

    if (!phone) {
      throw new ValidationError('Telefone do destinatário é obrigatório');
    }

    // Resolve content (template or direct)
    const variables: Record<string, string> = {
      nome: contactName,
      ...(params.variables ?? {}),
    };

    let resolvedContent = params.content ?? '';
    let templateIdForBatch: string | undefined = params.templateId;

    if (params.templateId) {
      const template = await whatsappTemplateService.get(params.templateId, accountId);
      resolvedContent = renderTemplate(template.content, variables);
    } else {
      resolvedContent = renderTemplate(resolvedContent, variables);
    }

    if (!resolvedContent.trim()) {
      throw new ValidationError('Conteúdo da mensagem está vazio após renderização');
    }

    // Create batch (running)
    const batch = await prisma.dispatchBatch.create({
      data: {
        accountId,
        totalContacts: 1,
        status: 'running',
        delaySeconds: 0,
        source: params.source,
        triggerName: params.triggerName ?? null,
        templateId: templateIdForBatch ?? null,
        metadata: {
          ...(params.metadata ?? {}),
          recipients: [
            {
              phone,
              name: contactName || null,
              contactId: params.contactId ?? null,
              variables,
            },
          ],
          single: true,
        } as any,
      },
    });

    // Send + log
    let messageId: string | undefined;
    let status: 'sent' | 'failed' = 'sent';
    let errorMessage: string | undefined;

    try {
      const result = await evolutionService.sendText(accountId, {
        number: phone,
        text: resolvedContent,
      });
      messageId = result.messageId || undefined;

      await prisma.dispatchLog.create({
        data: {
          batchId: batch.id,
          contactName: contactName || phone,
          phone,
          inboxId: 0,
          inboxName: 'evolution',
          status: 'sent',
          sentAt: new Date(),
        },
      });

      await prisma.dispatchBatch.update({
        where: { id: batch.id },
        data: {
          sentCount: 1,
          failedCount: 0,
          status: 'completed',
          completedAt: new Date(),
        },
      });
    } catch (err: any) {
      status = 'failed';
      errorMessage = err?.message ?? String(err);
      logger.error('[whatsapp-campaign] sendSingle failed', {
        accountId,
        batchId: batch.id,
        phone,
        error: errorMessage,
      });

      await prisma.dispatchLog.create({
        data: {
          batchId: batch.id,
          contactName: contactName || phone,
          phone,
          inboxId: 0,
          inboxName: 'evolution',
          status: 'failed',
          errorMessage,
          sentAt: new Date(),
        },
      });

      await prisma.dispatchBatch.update({
        where: { id: batch.id },
        data: {
          sentCount: 0,
          failedCount: 1,
          status: 'failed',
          completedAt: new Date(),
        },
      });
    }

    return {
      batchId: batch.id,
      messageId,
      status,
      error: errorMessage,
    };
  }

  // ============================================
  // sendBatch
  // ============================================

  async sendBatch(accountId: string, params: SendBatchParams): Promise<SendBatchResult> {
    if ((!params.contactIds || params.contactIds.length === 0) && (!params.phones || params.phones.length === 0)) {
      throw new ValidationError('Informe contactIds ou phones para o disparo em massa');
    }
    if (!params.templateId && !params.content) {
      throw new ValidationError('Informe templateId ou content para o disparo em massa');
    }

    // Resolve recipients
    const recipients: CampaignRecipient[] = [];

    if (params.contactIds && params.contactIds.length > 0) {
      const contacts = await prisma.contact.findMany({
        where: { id: { in: params.contactIds }, accountId },
        select: { id: true, nome: true, telefone: true },
      });

      for (const c of contacts) {
        if (!c.telefone) {
          logger.warn('[whatsapp-campaign] contato sem telefone ignorado', {
            accountId,
            contactId: c.id,
          });
          continue;
        }
        recipients.push({
          contactId: c.id,
          phone: c.telefone,
          name: c.nome ?? undefined,
          variables: {},
        });
      }
    }

    if (params.phones && params.phones.length > 0) {
      for (const p of params.phones) {
        if (!p.phone) continue;
        recipients.push({
          phone: p.phone,
          name: p.name,
          variables: p.variables ?? {},
        });
      }
    }

    if (recipients.length === 0) {
      throw new ValidationError('Nenhum destinatário válido encontrado para o disparo');
    }

    // Validate template existence early (throws NotFoundError se ausente)
    if (params.templateId) {
      await whatsappTemplateService.get(params.templateId, accountId);
    }

    const delaySeconds = params.delaySeconds ?? DEFAULT_DELAY_SECONDS;
    const isScheduled = !!(params.scheduledAt && params.scheduledAt.getTime() > Date.now());

    const baseMetadata: Record<string, any> = {
      ...(params.metadata ?? {}),
      recipients: recipients.map(r => ({
        contactId: r.contactId ?? null,
        phone: r.phone,
        name: r.name ?? null,
        variables: r.variables ?? {},
      })),
      defaultVariables: params.defaultVariables ?? {},
      content: params.content ?? null,
    };

    const batch = await prisma.dispatchBatch.create({
      data: {
        accountId,
        totalContacts: recipients.length,
        status: isScheduled ? 'scheduled' : 'running',
        delaySeconds,
        scheduledAt: params.scheduledAt ?? null,
        source: params.source,
        triggerName: params.triggerName ?? null,
        templateId: params.templateId ?? null,
        metadata: baseMetadata as any,
      },
    });

    if (!isScheduled) {
      // Fire and forget — process in background
      this.processBatchInBackground(batch.id).catch(err => {
        logger.error('[whatsapp-campaign] background processing failed', {
          batchId: batch.id,
          error: err?.message ?? String(err),
        });
        prisma.dispatchBatch
          .update({
            where: { id: batch.id },
            data: { status: 'failed', completedAt: new Date() },
          })
          .catch(() => {});
      });
    }

    return {
      batchId: batch.id,
      totalContacts: recipients.length,
      scheduled: isScheduled,
    };
  }

  // ============================================
  // processBatchInBackground
  // ============================================

  async processBatchInBackground(batchId: string): Promise<void> {
    const batch = await prisma.dispatchBatch.findUnique({ where: { id: batchId } });
    if (!batch) {
      logger.error('[whatsapp-campaign] batch não encontrado', { batchId });
      return;
    }

    if (batch.status !== 'running') {
      // Marca como running se foi disparado a partir da fila agendada
      await prisma.dispatchBatch.update({
        where: { id: batchId },
        data: { status: 'running' },
      });
    }

    const metadata = (batch.metadata as Record<string, any> | null) ?? {};
    const recipients: CampaignRecipient[] = Array.isArray(metadata.recipients) ? metadata.recipients : [];
    const defaultVariables: Record<string, string> =
      (metadata.defaultVariables as Record<string, string>) ?? {};
    const directContent: string | null = metadata.content ?? null;

    if (recipients.length === 0) {
      logger.warn('[whatsapp-campaign] batch sem destinatários', { batchId });
      await prisma.dispatchBatch.update({
        where: { id: batchId },
        data: { status: 'completed', completedAt: new Date() },
      });
      return;
    }

    // Resolve template once
    let templateContent: string | null = null;
    if (batch.templateId) {
      try {
        const template = await whatsappTemplateService.get(batch.templateId, batch.accountId);
        templateContent = template.content;
      } catch (err: any) {
        logger.error('[whatsapp-campaign] template não encontrado', {
          batchId,
          templateId: batch.templateId,
          error: err?.message ?? String(err),
        });
        await prisma.dispatchBatch.update({
          where: { id: batchId },
          data: { status: 'failed', completedAt: new Date() },
        });
        return;
      }
    }

    const delayMs = Math.max((batch.delaySeconds || DEFAULT_DELAY_SECONDS) * 1000, MIN_DELAY_MS);

    let sentCount = 0;
    let failedCount = 0;

    for (let i = 0; i < recipients.length; i++) {
      // Cancellation check
      const fresh = await prisma.dispatchBatch.findUnique({
        where: { id: batchId },
        select: { status: true },
      });
      if (fresh?.status === 'cancelled') {
        logger.info('[whatsapp-campaign] batch cancelado, abortando', { batchId });
        return;
      }

      const recipient = recipients[i];
      const variables: Record<string, string> = {
        nome: recipient.name ?? '',
        ...defaultVariables,
        ...(recipient.variables ?? {}),
      };

      const rawContent = templateContent ?? directContent ?? '';
      const message = renderTemplate(rawContent, variables);

      try {
        if (!recipient.phone) throw new Error('Telefone vazio');
        if (!message.trim()) throw new Error('Mensagem vazia após renderização');

        await evolutionService.sendText(batch.accountId, {
          number: recipient.phone,
          text: message,
        });

        sentCount++;
        await prisma.dispatchLog.create({
          data: {
            batchId,
            contactName: recipient.name || recipient.phone,
            phone: recipient.phone,
            inboxId: 0,
            inboxName: 'evolution',
            status: 'sent',
            sentAt: new Date(),
          },
        });
      } catch (err: any) {
        failedCount++;
        const errorMessage = err?.message ?? String(err);
        logger.error('[whatsapp-campaign] envio falhou', {
          batchId,
          phone: recipient.phone,
          error: errorMessage,
        });
        await prisma.dispatchLog.create({
          data: {
            batchId,
            contactName: recipient.name || recipient.phone || 'desconhecido',
            phone: recipient.phone || '',
            inboxId: 0,
            inboxName: 'evolution',
            status: 'failed',
            errorMessage,
            sentAt: new Date(),
          },
        });
      }

      await prisma.dispatchBatch.update({
        where: { id: batchId },
        data: { sentCount, failedCount },
      });

      if (i < recipients.length - 1) {
        await this.sleep(delayMs);
      }
    }

    const finalCheck = await prisma.dispatchBatch.findUnique({
      where: { id: batchId },
      select: { status: true },
    });
    if (finalCheck?.status === 'cancelled') return;

    const finalStatus = failedCount === recipients.length ? 'failed' : 'completed';
    await prisma.dispatchBatch.update({
      where: { id: batchId },
      data: {
        status: finalStatus,
        sentCount,
        failedCount,
        completedAt: new Date(),
      },
    });

    logger.info('[whatsapp-campaign] batch finalizado', {
      batchId,
      status: finalStatus,
      sentCount,
      failedCount,
      total: recipients.length,
    });
  }

  // ============================================
  // processScheduledQueue
  // ============================================

  async processScheduledQueue(): Promise<{ processed: number; failed: number }> {
    const now = new Date();
    const batches = await prisma.dispatchBatch.findMany({
      where: {
        status: 'scheduled',
        scheduledAt: { lte: now },
      },
      orderBy: { scheduledAt: 'asc' },
      take: 50,
    });

    if (batches.length === 0) {
      return { processed: 0, failed: 0 };
    }

    let processed = 0;
    let failed = 0;

    for (const batch of batches) {
      try {
        const updated = await prisma.dispatchBatch.updateMany({
          where: { id: batch.id, status: 'scheduled' },
          data: { status: 'running' },
        });

        if (updated.count === 0) {
          // Outro worker pegou primeiro
          continue;
        }

        processed++;

        // Não bloqueia o loop
        this.processBatchInBackground(batch.id).catch(err => {
          logger.error('[whatsapp-campaign] scheduled batch background error', {
            batchId: batch.id,
            error: err?.message ?? String(err),
          });
          prisma.dispatchBatch
            .update({
              where: { id: batch.id },
              data: { status: 'failed', completedAt: new Date() },
            })
            .catch(() => {});
        });
      } catch (err: any) {
        failed++;
        logger.error('[whatsapp-campaign] erro ao despachar batch agendado', {
          batchId: batch.id,
          error: err?.message ?? String(err),
        });
      }
    }

    logger.info('[whatsapp-campaign] processScheduledQueue', {
      processed,
      failed,
      candidates: batches.length,
    });

    return { processed, failed };
  }

  // ============================================
  // listBatches
  // ============================================

  async listBatches(accountId: string, filters: ListBatchesFilters = {}): Promise<DispatchBatch[]> {
    const where: any = { accountId };

    if (filters.status) where.status = filters.status;
    if (filters.source) where.source = filters.source;
    if (filters.triggerName) where.triggerName = filters.triggerName;

    if (filters.fromDate || filters.toDate) {
      where.createdAt = {};
      if (filters.fromDate) where.createdAt.gte = filters.fromDate;
      if (filters.toDate) where.createdAt.lte = filters.toDate;
    }

    return prisma.dispatchBatch.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  // ============================================
  // getBatch
  // ============================================

  async getBatch(id: string, accountId: string): Promise<DispatchBatch & { logs: DispatchLog[] }> {
    const batch = await prisma.dispatchBatch.findFirst({
      where: { id, accountId },
      include: {
        logs: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!batch) throw new NotFoundError('Disparo');

    return batch;
  }

  // ============================================
  // cancelScheduled
  // ============================================

  async cancelScheduled(id: string, accountId: string): Promise<void> {
    const batch = await prisma.dispatchBatch.findFirst({
      where: { id, accountId },
      select: { id: true, status: true },
    });

    if (!batch) throw new NotFoundError('Disparo');

    if (batch.status !== 'scheduled') {
      throw new ValidationError(
        `Apenas disparos agendados podem ser cancelados (status atual: ${batch.status})`
      );
    }

    await prisma.dispatchBatch.update({
      where: { id },
      data: {
        status: 'cancelled',
        completedAt: new Date(),
      },
    });

    logger.info('[whatsapp-campaign] disparo agendado cancelado', { batchId: id });
  }

  // ============================================
  // Helpers privados
  // ============================================

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const whatsappCampaignService = new WhatsappCampaignService();

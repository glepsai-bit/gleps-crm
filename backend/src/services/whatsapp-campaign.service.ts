import type { DispatchBatch, DispatchLog } from '@prisma/client';
import { prisma } from '../config/database';
import { evolutionService } from './evolution.service';
import { renderTemplate, whatsappTemplateService } from './whatsapp-template.service';
import { whatsappConsentService } from './whatsapp-consent.service';
import { whatsappRateLimitService } from './whatsapp-rate-limit.service';
import { webhookOutboundService } from './webhook-outbound.service';
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

    // BUG-061: inboxName usa o slug da instância Evolution da conta
    const accountForInbox = await prisma.account.findUnique({
      where: { id: accountId },
      select: { evolutionInstance: true },
    });
    const inboxNameForLogs = `evolution:${accountForInbox?.evolutionInstance ?? 'unknown'}`;

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

    // T-022 Sprint 3 — Compliance + Rate limit
    const normalizedPhone = whatsappConsentService.normalizePhone(phone);

    const hasConsent = await whatsappConsentService.hasConsent(accountId, normalizedPhone);
    if (!hasConsent) {
      errorMessage = 'Contato com opt-out';
      await prisma.dispatchLog.create({
        data: {
          accountId,
          batchId: batch.id,
          contactName: contactName || phone,
          phone,
          inboxName: inboxNameForLogs,
          status: 'blocked_optout',
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

      // Mesmo bloqueado, batch foi finalizado — emite evento
      webhookOutboundService
        .emit(accountId, 'campaign.completed', {
          batchId: batch.id,
          totalContacts: 1,
          sentCount: 0,
          failedCount: 1,
          reason: 'blocked_optout',
        })
        .catch(err =>
          logger.warn('[whatsapp-campaign] falha ao emitir campaign.completed', {
            batchId: batch.id,
            error: err?.message ?? String(err),
          })
        );

      return { batchId: batch.id, status: 'failed', error: errorMessage };
    }

    // T-022 Sprint 3 — tryAcquire é atômico (reserva o slot); evita TOCTOU
    const rl = whatsappRateLimitService.tryAcquire(accountId, normalizedPhone);
    if (!rl.allowed) {
      errorMessage = rl.reason ?? 'rate_limited';
      await prisma.dispatchLog.create({
        data: {
          accountId,
          batchId: batch.id,
          contactName: contactName || phone,
          phone,
          inboxName: inboxNameForLogs,
          status: 'rate_limited',
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

      webhookOutboundService
        .emit(accountId, 'campaign.completed', {
          batchId: batch.id,
          totalContacts: 1,
          sentCount: 0,
          failedCount: 1,
          reason: 'rate_limited',
        })
        .catch(err =>
          logger.warn('[whatsapp-campaign] falha ao emitir campaign.completed', {
            batchId: batch.id,
            error: err?.message ?? String(err),
          })
        );

      return { batchId: batch.id, status: 'failed', error: errorMessage };
    }

    try {
      const result = await evolutionService.sendText(accountId, {
        number: phone,
        text: resolvedContent,
      });
      messageId = result.messageId || undefined;
      // rate limit já registrado em tryAcquire acima

      await prisma.dispatchLog.create({
        data: {
          accountId,
          batchId: batch.id,
          contactName: contactName || phone,
          phone,
          inboxName: inboxNameForLogs,
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

      // T-022 Sprint 3 — evento de finalização (sucesso)
      webhookOutboundService
        .emit(accountId, 'campaign.completed', {
          batchId: batch.id,
          totalContacts: 1,
          sentCount: 1,
          failedCount: 0,
        })
        .catch(err =>
          logger.warn('[whatsapp-campaign] falha ao emitir campaign.completed', {
            batchId: batch.id,
            error: err?.message ?? String(err),
          })
        );
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
          accountId,
          batchId: batch.id,
          contactName: contactName || phone,
          phone,
          inboxName: inboxNameForLogs,
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

      // T-022 Sprint 3 — evento de finalização (falha)
      webhookOutboundService
        .emit(accountId, 'campaign.completed', {
          batchId: batch.id,
          totalContacts: 1,
          sentCount: 0,
          failedCount: 1,
          error: errorMessage,
        })
        .catch(emitErr =>
          logger.warn('[whatsapp-campaign] falha ao emitir campaign.completed', {
            batchId: batch.id,
            error: emitErr?.message ?? String(emitErr),
          })
        );
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

    // H-DISP-A: scheduledAt no passado deve falhar explicitamente.
    // Antes (BUG-029): convertia para envio imediato com warn, o que fazia
    // n8n/integracoes externas dispararem sem aviso quando enviavam timestamps
    // antigos por bug de clock skew ou retry. Agora bloqueia com 400.
    const effectiveScheduledAt: Date | undefined = params.scheduledAt ?? undefined;
    if (effectiveScheduledAt && effectiveScheduledAt.getTime() < Date.now()) {
      throw new ValidationError('scheduledAt deve ser futuro');
    }

    // BUG-061: inboxName usa o slug da instância Evolution da conta
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { evolutionInstance: true },
    });
    const inboxNameForLogs = `evolution:${account?.evolutionInstance ?? 'unknown'}`;

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

    // BUG-040: phones vazios viram entrada totalContacts + DispatchLog skipped_invalid_phone
    const skippedPhones: { name?: string; variables?: Record<string, string> }[] = [];
    if (params.phones && params.phones.length > 0) {
      for (const p of params.phones) {
        if (!p.phone) {
          skippedPhones.push({ name: p.name, variables: p.variables });
          continue;
        }
        recipients.push({
          phone: p.phone,
          name: p.name,
          variables: p.variables ?? {},
        });
      }
    }

    if (skippedPhones.length > 0) {
      logger.warn('[whatsapp-campaign] phones vazios ignorados no batch', {
        accountId,
        count: skippedPhones.length,
      });
    }

    if (recipients.length === 0 && skippedPhones.length === 0) {
      throw new ValidationError('Nenhum destinatário válido encontrado para o disparo');
    }

    // Validate template existence early (throws NotFoundError se ausente)
    if (params.templateId) {
      await whatsappTemplateService.get(params.templateId, accountId);
    }

    const delaySeconds = params.delaySeconds ?? DEFAULT_DELAY_SECONDS;
    const isScheduled = !!(effectiveScheduledAt && effectiveScheduledAt.getTime() > Date.now());

    // BUG-040: totalContacts reflete a entrada (recipients válidos + skipped),
    // pra deixar visível na UI quantos foram descartados.
    const totalContacts = recipients.length + skippedPhones.length;

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
      ...(skippedPhones.length > 0 ? { skippedInvalidPhones: skippedPhones.length } : {}),
    };

    const batch = await prisma.dispatchBatch.create({
      data: {
        accountId,
        totalContacts,
        status: isScheduled ? 'scheduled' : 'running',
        delaySeconds,
        scheduledAt: effectiveScheduledAt ?? null,
        source: params.source,
        triggerName: params.triggerName ?? null,
        templateId: params.templateId ?? null,
        metadata: baseMetadata as any,
      },
    });

    // BUG-040: registra DispatchLog para cada phone vazio descartado
    if (skippedPhones.length > 0) {
      await Promise.all(
        skippedPhones.map(sp =>
          prisma.dispatchLog
            .create({
              data: {
                accountId,
                batchId: batch.id,
                contactName: sp.name || 'desconhecido',
                phone: '',
                inboxName: inboxNameForLogs,
                status: 'skipped_invalid_phone',
                errorMessage: 'Telefone vazio',
                sentAt: new Date(),
              },
            })
            .catch(err =>
              logger.warn('[whatsapp-campaign] falha ao gravar log de phone invalido', {
                batchId: batch.id,
                error: err?.message ?? String(err),
              })
            )
        )
      );

      // Reflete os skipped no contador de falhas do batch
      await prisma.dispatchBatch
        .update({
          where: { id: batch.id },
          data: { failedCount: skippedPhones.length },
        })
        .catch(() => {});
    }

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
      totalContacts,
      scheduled: isScheduled,
    };
  }

  // ============================================
  // processBatchInBackground
  // ============================================

  async processBatchInBackground(batchId: string): Promise<void> {
    // Pre-check: aborta se batch ja terminal. Promove scheduled/paused -> running
    // sem rejeitar status='running' (sendBatch e processScheduledQueue ja criam/
    // promovem antes de chamar este metodo — guard estrito quebrava ambos).
    //
    // Atomicidade contra double-runner real eh garantida por:
    //  (a) updateMany WHERE status='paused' em resumeBatchFromPause (prospecting)
    //  (b) updateMany WHERE status='scheduled' em processScheduledQueue
    //  (c) sendBatch cria batch UMA unica vez, sem retry
    //  (d) counters de sentCount/failedCount usam { increment: 1 } atomico
    //  (e) finalCheck usa updateMany WHERE status='running' (LENS1-005)
    const pre = await prisma.dispatchBatch.findUnique({
      where: { id: batchId },
      select: { status: true },
    });
    if (!pre) {
      logger.error('[whatsapp-campaign] batch nao encontrado', { batchId });
      return;
    }
    if (['completed', 'failed', 'cancelled'].includes(pre.status)) {
      logger.info('[whatsapp-campaign] batch ja finalizado, ignorando', {
        batchId,
        status: pre.status,
      });
      return;
    }
    if (pre.status === 'scheduled' || pre.status === 'paused') {
      // Promove atomicamente. Se outro caller ja promoveu (claim.count=0),
      // seguimos mesmo assim — counters sao increment atomicos.
      await prisma.dispatchBatch.updateMany({
        where: { id: batchId, status: { in: ['scheduled', 'paused'] } },
        data: { status: 'running', startedAt: new Date() },
      });
    }

    const batch = await prisma.dispatchBatch.findUnique({ where: { id: batchId } });
    if (!batch) {
      logger.error('[whatsapp-campaign] batch não encontrado após claim', { batchId });
      return;
    }

    // BUG-061: inboxName usa o slug da instância Evolution da conta
    const accountForInbox = await prisma.account.findUnique({
      where: { id: batch.accountId },
      select: { evolutionInstance: true },
    });
    const inboxNameForLogs = `evolution:${accountForInbox?.evolutionInstance ?? 'unknown'}`;

    const metadata = (batch.metadata as Record<string, any> | null) ?? {};
    const recipients: CampaignRecipient[] = Array.isArray(metadata.recipients) ? metadata.recipients : [];
    const defaultVariables: Record<string, string> =
      (metadata.defaultVariables as Record<string, string>) ?? {};
    const directContent: string | null = metadata.content ?? null;

    if (recipients.length === 0) {
      logger.warn('[whatsapp-campaign] batch sem destinatários', { batchId });
      // Preserva failedCount inicial (ex.: skippedPhones de sendBatch)
      const initialFailed = batch.failedCount || 0;
      const finalStatus = initialFailed > 0 ? 'failed' : 'completed';
      await prisma.dispatchBatch.update({
        where: { id: batchId },
        data: { status: finalStatus, completedAt: new Date() },
      });

      // T-022 Sprint 3 — evento de finalização (early return: sem destinatários)
      webhookOutboundService
        .emit(batch.accountId, 'campaign.completed', {
          batchId,
          totalContacts: batch.totalContacts,
          sentCount: 0,
          failedCount: initialFailed,
          status: finalStatus,
          reason: 'no_recipients',
        })
        .catch(err =>
          logger.warn('[whatsapp-campaign] falha ao emitir campaign.completed', {
            batchId,
            error: err?.message ?? String(err),
          })
        );
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

        // T-022 Sprint 3 — evento de finalização (early return: template ausente)
        webhookOutboundService
          .emit(batch.accountId, 'campaign.completed', {
            batchId,
            totalContacts: batch.totalContacts,
            sentCount: 0,
            failedCount: batch.failedCount || 0,
            status: 'failed',
            reason: 'template_not_found',
            error: err?.message ?? String(err),
          })
          .catch(emitErr =>
            logger.warn('[whatsapp-campaign] falha ao emitir campaign.completed', {
              batchId,
              error: emitErr?.message ?? String(emitErr),
            })
          );
        return;
      }
    }

    const delayMs = Math.max((batch.delaySeconds || DEFAULT_DELAY_SECONDS) * 1000, MIN_DELAY_MS);

    // Resume-safe: evita reenviar pra contatos que ja foram processados num run
    // anterior (pause -> resume). Lemos os logs nao-pending desse batch e
    // pulamos os phones que ja receberam dispatch (sent/failed/blocked_optout/
    // cancelled). Sem isso, resume duplicava mensagens nos primeiros recipients
    // toda vez que o batch retomava.
    // LENS1-002: rate_limited eh transiente (janela de rate-limit expira); deve
    // ser retentavel num resume. opt-out/sent/failed/cancelled mantem skip.
    const processedLogs = await prisma.dispatchLog.findMany({
      where: { batchId, status: { notIn: ['pending', 'rate_limited'] } },
      select: { phone: true },
    });
    const alreadyProcessed = new Set(processedLogs.map(l => l.phone));

    let sentCount = batch.sentCount || 0;
    // Preserva failedCount inicial do batch (ex.: skippedPhones registrados em sendBatch).
    // O acumulador local representa o total (skipped + falhas durante o loop).
    let failedCount = batch.failedCount || 0;

    for (let i = 0; i < recipients.length; i++) {
      // Resume-skip: pula recipient ja processado em run anterior
      if (alreadyProcessed.has(recipients[i].phone)) continue;

      // Cancellation check
      const fresh = await prisma.dispatchBatch.findUnique({
        where: { id: batchId },
        select: { status: true },
      });
      if (fresh?.status === 'cancelled' || fresh?.status === 'paused') {
        logger.info('[whatsapp-campaign] Batch interrompido', {
          batchId,
          status: fresh.status,
          sentCount,
          failedCount,
        });
        return; // NAO mexer em completedAt — preserva snapshot pra resume
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

        // T-022 Sprint 3 — Compliance + Rate limit por destinatário
        const normalizedPhone = whatsappConsentService.normalizePhone(recipient.phone);

        const hasConsent = await whatsappConsentService.hasConsent(
          batch.accountId,
          normalizedPhone
        );
        if (!hasConsent) {
          failedCount++;
          await prisma.dispatchLog.create({
            data: {
              accountId: batch.accountId,
              batchId,
              contactName: recipient.name || recipient.phone,
              phone: recipient.phone,
              inboxName: inboxNameForLogs,
              status: 'blocked_optout',
              errorMessage: 'Contato com opt-out',
              sentAt: new Date(),
            },
          });
          // LENS1-003: increment atomico (SET nao-atomico causava last-writer-wins)
          await prisma.dispatchBatch.update({
            where: { id: batchId },
            data: { failedCount: { increment: 1 } },
          });
          // BUG-017: opt-out não consome envio real — pular delay
          continue;
        }

        // T-022 Sprint 3 — tryAcquire é atômico (reserva o slot); evita TOCTOU
        const rl = whatsappRateLimitService.tryAcquire(batch.accountId, normalizedPhone);
        if (!rl.allowed) {
          failedCount++;
          await prisma.dispatchLog.create({
            data: {
              accountId: batch.accountId,
              batchId,
              contactName: recipient.name || recipient.phone,
              phone: recipient.phone,
              inboxName: inboxNameForLogs,
              status: 'rate_limited',
              errorMessage: rl.reason ?? 'rate_limited',
              sentAt: new Date(),
            },
          });
          // LENS1-003: increment atomico
          await prisma.dispatchBatch.update({
            where: { id: batchId },
            data: { failedCount: { increment: 1 } },
          });
          // BUG-017: rate-limited não consome envio real — pular delay
          continue;
        }

        await evolutionService.sendText(batch.accountId, {
          number: recipient.phone,
          text: message,
        });
        // rate limit já registrado em tryAcquire acima

        sentCount++;
        await prisma.dispatchLog.create({
          data: {
            accountId: batch.accountId,
            batchId,
            contactName: recipient.name || recipient.phone,
            phone: recipient.phone,
            inboxName: inboxNameForLogs,
            status: 'sent',
            sentAt: new Date(),
          },
        });
        // LENS1-003: increment atomico (substitui SET com last-writer-wins)
        await prisma.dispatchBatch.update({
          where: { id: batchId },
          data: { sentCount: { increment: 1 } },
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
            accountId: batch.accountId,
            batchId,
            contactName: recipient.name || recipient.phone || 'desconhecido',
            phone: recipient.phone || '',
            inboxName: inboxNameForLogs,
            status: 'failed',
            errorMessage,
            sentAt: new Date(),
          },
        });
        // LENS1-003: increment atomico
        await prisma.dispatchBatch.update({
          where: { id: batchId },
          data: { failedCount: { increment: 1 } },
        });
      }

      if (i < recipients.length - 1) {
        await this.sleep(delayMs);
      }
    }

    const finalCheck = await prisma.dispatchBatch.findUnique({
      where: { id: batchId },
      select: { status: true },
    });
    if (finalCheck?.status === 'cancelled' || finalCheck?.status === 'paused') return;

    // LENS1-003: le o estado atualizado (counters foram incrementados atomicamente
    // ao longo do loop, nao podem ser sobrescritos com variaveis locais).
    const finalState = await prisma.dispatchBatch.findUnique({
      where: { id: batchId },
      select: { sentCount: true, failedCount: true },
    });
    const finalSent = finalState?.sentCount ?? 0;
    const finalFailed = finalState?.failedCount ?? 0;

    // failedCount inclui skippedPhones do sendBatch; usar sentCount como sinal de sucesso
    const finalStatus = finalSent === 0 ? 'failed' : 'completed';
    // LENS1-005: updateMany com WHERE status='running' (nao update direto) — evita
    // sobrescrever status se outro fluxo (pause/cancel) chegou primeiro.
    await prisma.dispatchBatch.updateMany({
      where: { id: batchId, status: 'running' },
      data: {
        status: finalStatus,
        completedAt: new Date(),
      },
    });

    logger.info('[whatsapp-campaign] batch finalizado', {
      batchId,
      status: finalStatus,
      sentCount: finalSent,
      failedCount: finalFailed,
      total: recipients.length,
    });

    // T-022 Sprint 3 — evento de finalização do batch
    webhookOutboundService
      .emit(batch.accountId, 'campaign.completed', {
        batchId,
        totalContacts: batch.totalContacts,
        sentCount: finalSent,
        failedCount: finalFailed,
        status: finalStatus,
      })
      .catch(err =>
        logger.warn('[whatsapp-campaign] falha ao emitir campaign.completed', {
          batchId,
          error: err?.message ?? String(err),
        })
      );
  }

  // ============================================
  // recoverOrphanRunningBatches
  // ============================================

  /**
   * H-DISP-B: batches em status 'running' por mais de 30 minutos sao
   * provavelmente orfaos de um restart do backend (processBatchInBackground
   * roda em memoria e nao sobrevive a reboot). Voltamos para 'scheduled'
   * para o cron retomar via processScheduledQueue.
   *
   * Chamado uma vez no bootstrap, antes do cron WhatsApp subir.
   */
  async recoverOrphanRunningBatches(): Promise<{ count: number }> {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000);
    const r = await prisma.dispatchBatch.updateMany({
      where: { status: 'running', startedAt: { lt: cutoff } },
      data: { status: 'scheduled' },
    });
    if (r.count > 0) {
      logger.info('[wa-campaign] recovered orphan running batches', { count: r.count });
    }
    return { count: r.count };
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

    // T-022 Sprint 3 — evento de cancelamento
    webhookOutboundService
      .emit(accountId, 'campaign.cancelled', {
        batchId: id,
        status: 'cancelled',
      })
      .catch(err =>
        logger.warn('[whatsapp-campaign] falha ao emitir campaign.cancelled', {
          batchId: id,
          error: err?.message ?? String(err),
        })
      );
  }

  // ============================================
  // Helpers privados
  // ============================================

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const whatsappCampaignService = new WhatsappCampaignService();

import { PrismaClient, EmailSendStatus } from '@prisma/client';
import { sendgridService } from './sendgrid.service';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

// Utility: delay
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================
// EMAIL QUOTA HELPERS (mensal + diário)
// ============================================
// Statuses considerados "envio que efetivamente saiu" (consomem cota).
// 'queued' e 'failed' NÃO contam; respeitando a regra: cota só é consumida
// quando o e-mail realmente foi entregue ao SendGrid com sucesso.
const COUNTABLE_SEND_STATUSES: EmailSendStatus[] = ['sent', 'delivered', 'opened', 'clicked', 'bounced'] as EmailSendStatus[];

/**
 * Retorna o início do dia atual no timezone informado (em UTC) e o início do próximo dia.
 */
function getDailyWindow(timezone: string = 'America/Sao_Paulo'): { start: Date; resetAt: Date } {
  const now = new Date();
  // Pega a data local (YYYY-MM-DD) no timezone alvo
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const localDate = fmt.format(now); // "2026-04-24"
  // Pega o offset atual do timezone em minutos relativo ao UTC
  const tzNow = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
  const utcNow = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMs = tzNow.getTime() - utcNow.getTime();
  // Início do dia local em UTC
  const start = new Date(`${localDate}T00:00:00Z`);
  start.setTime(start.getTime() - offsetMs);
  const resetAt = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, resetAt };
}

/**
 * Retorna o início do mês atual no timezone informado e o início do próximo mês.
 */
function getMonthlyWindow(timezone: string = 'America/Sao_Paulo'): { start: Date; resetAt: Date } {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [year, month] = fmt.format(now).split('-').map(Number);
  const tzNow = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
  const utcNow = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMs = tzNow.getTime() - utcNow.getTime();
  const start = new Date(`${year}-${String(month).padStart(2, '0')}-01T00:00:00Z`);
  start.setTime(start.getTime() - offsetMs);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const resetAt = new Date(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00Z`);
  resetAt.setTime(resetAt.getTime() - offsetMs);
  return { start, resetAt };
}

/**
 * Calculate nextSendAt based on startDate, dayNumber, and sendAtTime (HH:MM).
 * Day 1 = startDate, Day 2 = startDate + 1 day, etc.
 * If the calculated date+time is in the past, returns the date anyway (processor will send immediately).
 */
function calculateNextSendAt(dayNumber: number, sendAtTime: string, timezone: string = 'America/Sao_Paulo', startDate?: Date | string): Date {
  const [hours, minutes] = (sendAtTime || '09:00').split(':').map(Number);

  // Base date: use startDate if provided, otherwise today
  const base = startDate ? new Date(startDate) : new Date();
  
  // Day 1 = base date, Day 2 = base + 1, etc.
  const daysOffset = Math.max(0, dayNumber - 1);
  
  const targetDate = new Date(base);
  targetDate.setDate(targetDate.getDate() + daysOffset);
  
  // Use Intl to get current timezone offset for targetDate
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = formatter.formatToParts(targetDate);
  const getPart = (type: string) => parts.find(p => p.type === type)?.value || '0';
  
  const currentLocalHour = parseInt(getPart('hour'));
  const currentLocalMinute = parseInt(getPart('minute'));
  const hourDiff = hours - currentLocalHour;
  const minuteDiff = minutes - currentLocalMinute;
  
  const result = new Date(targetDate);
  result.setHours(result.getHours() + hourDiff);
  result.setMinutes(result.getMinutes() + minuteDiff);
  result.setSeconds(0);
  result.setMilliseconds(0);
  
  return result;
}

// Utility: exponential backoff
async function withBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 1000
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const is429 = error?.status === 429 || error?.message?.includes('429');
      if (!is429 || attempt === maxRetries) throw error;
      const waitMs = baseDelayMs * Math.pow(2, attempt);
      logger.warn(`[EmailProcessor] Rate limited (429), retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`);
      await delay(waitMs);
    }
  }
  throw new Error('Unreachable');
}

export const emailService = {
  // ==================== CADENCES ====================

  // ==================== QUOTA ====================

  /**
   * Verifica a cota mensal e diária de envio de e-mails da conta.
   * Retorna o uso atual, limite, restante e quando reseta.
   * canSend = true apenas se AMBOS (mensal e diário) tiverem saldo > 0.
   */
  async checkEmailQuota(accountId: string) {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: {
        timezone: true,
        monthlyEmailLimit: true,
        dailyEmailLimit: true,
      },
    });

    const tz = account?.timezone || 'America/Sao_Paulo';
    const monthlyLimit = account?.monthlyEmailLimit ?? 3000;
    const dailyLimit = account?.dailyEmailLimit ?? 100;

    const { start: monthStart, resetAt: monthReset } = getMonthlyWindow(tz);
    const { start: dayStart, resetAt: dayReset } = getDailyWindow(tz);

    const [monthlyUsed, dailyUsed] = await Promise.all([
      prisma.emailSend.count({
        where: {
          accountId,
          status: { in: COUNTABLE_SEND_STATUSES },
          createdAt: { gte: monthStart },
        },
      }),
      prisma.emailSend.count({
        where: {
          accountId,
          status: { in: COUNTABLE_SEND_STATUSES },
          createdAt: { gte: dayStart },
        },
      }),
    ]);

    const monthlyRemaining = Math.max(0, monthlyLimit - monthlyUsed);
    const dailyRemaining = Math.max(0, dailyLimit - dailyUsed);

    return {
      monthly: {
        used: monthlyUsed,
        limit: monthlyLimit,
        remaining: monthlyRemaining,
        resetAt: monthReset.toISOString(),
      },
      daily: {
        used: dailyUsed,
        limit: dailyLimit,
        remaining: dailyRemaining,
        resetAt: dayReset.toISOString(),
      },
      canSend: monthlyRemaining > 0 && dailyRemaining > 0,
      timezone: tz,
    };
  },

  async listCadences(accountId: string) {
    return prisma.emailCadence.findMany({
      where: { accountId },
      include: {
        steps: { orderBy: { ordem: 'asc' } },
        rulesFrom: { include: { targetCadence: { select: { id: true, name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
  },

  async getCadence(id: string, accountId: string) {
    return prisma.emailCadence.findFirst({
      where: { id, accountId },
      include: {
        steps: { orderBy: { ordem: 'asc' } },
        enrollments: { include: { contact: true } },
        rulesFrom: { include: { targetCadence: { select: { id: true, name: true } } } },
      },
    });
  },

  async createCadence(data: {
    accountId: string;
    name: string;
    description?: string;
    targetStageIds?: string[];
    createdBy?: string;
    sendAtTime?: string;
    startDate?: string;
  }) {
    return prisma.emailCadence.create({
      data: {
        accountId: data.accountId,
        name: data.name,
        description: data.description,
        targetStageIds: data.targetStageIds || [],
        createdBy: data.createdBy,
        sendAtTime: data.sendAtTime || '09:00',
        startDate: data.startDate ? new Date(data.startDate) : new Date(),
      },
      include: { steps: true },
    });
  },

  async updateCadence(id: string, accountId: string, data: {
    name?: string;
    description?: string;
    targetStageIds?: string[];
    active?: boolean;
    sendAtTime?: string;
    startDate?: string;
  }) {
    const updateData: any = { ...data };
    if (data.startDate) {
      updateData.startDate = new Date(data.startDate);
    }
    return prisma.emailCadence.update({
      where: { id },
      data: updateData,
      include: { steps: { orderBy: { ordem: 'asc' } } },
    });
  },

  async deleteCadence(id: string, accountId: string) {
    return prisma.emailCadence.delete({ where: { id } });
  },

  // ==================== CADENCE RULES ====================

  async listRules(cadenceId: string) {
    return prisma.emailCadenceRule.findMany({
      where: { cadenceId },
      include: { targetCadence: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
  },

  async createRule(data: {
    cadenceId: string;
    triggerEvent: string;
    targetCadenceId: string;
    delayHours?: number;
    timeoutHours?: number;
  }) {
    return prisma.emailCadenceRule.create({
      data: {
        cadenceId: data.cadenceId,
        triggerEvent: data.triggerEvent,
        targetCadenceId: data.targetCadenceId,
        delayHours: data.delayHours || 0,
        timeoutHours: data.timeoutHours || 48,
      },
      include: { targetCadence: { select: { id: true, name: true } } },
    });
  },

  async updateRule(id: string, data: {
    triggerEvent?: string;
    targetCadenceId?: string;
    delayHours?: number;
    timeoutHours?: number;
    active?: boolean;
  }) {
    return prisma.emailCadenceRule.update({
      where: { id },
      data,
      include: { targetCadence: { select: { id: true, name: true } } },
    });
  },

  async deleteRule(id: string) {
    return prisma.emailCadenceRule.delete({ where: { id } });
  },

  // ==================== STEPS ====================

  async createStep(cadenceId: string, data: {
    dayNumber: number;
    subject: string;
    bodyHtml: string;
    bodyText?: string;
    ordem?: number;
    templateId?: string | null;
  }) {
    // If a template is selected, snapshot subject/body from it as a starting point
    let subject = data.subject;
    let bodyHtml = data.bodyHtml;
    let bodyText = data.bodyText;
    if (data.templateId) {
      const tpl = await prisma.emailTemplate.findUnique({ where: { id: data.templateId } });
      if (tpl) {
        subject = subject || tpl.subject;
        bodyHtml = bodyHtml || tpl.bodyHtml;
        bodyText = bodyText ?? tpl.bodyText ?? undefined;
      }
    }
    return prisma.emailCadenceStep.create({
      data: {
        cadenceId,
        dayNumber: data.dayNumber,
        subject,
        bodyHtml,
        bodyText,
        ordem: data.ordem || 0,
        templateId: data.templateId || null,
      },
    });
  },

  async updateStep(id: string, data: {
    dayNumber?: number;
    subject?: string;
    bodyHtml?: string;
    bodyText?: string;
    active?: boolean;
    ordem?: number;
    templateId?: string | null;
  }) {
    return prisma.emailCadenceStep.update({ where: { id }, data });
  },

  async deleteStep(id: string) {
    return prisma.emailCadenceStep.delete({ where: { id } });
  },

  // ==================== TEMPLATES ====================

  async listTemplates(accountId: string) {
    return prisma.emailTemplate.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
    });
  },

  async createTemplate(data: {
    accountId: string;
    name: string;
    subject: string;
    bodyHtml: string;
    bodyText?: string;
    category?: string;
    createdBy?: string;
  }) {
    return prisma.emailTemplate.create({ data });
  },

  async updateTemplate(id: string, data: {
    name?: string;
    subject?: string;
    bodyHtml?: string;
    bodyText?: string;
    category?: string;
  }) {
    return prisma.emailTemplate.update({ where: { id }, data });
  },

  async deleteTemplate(id: string) {
    return prisma.emailTemplate.delete({ where: { id } });
  },

  // ==================== ENROLLMENTS ====================

  async enrollContacts(data: {
    accountId: string;
    cadenceId: string;
    contactIds: string[];
  }) {
    const cadence = await prisma.emailCadence.findUnique({
      where: { id: data.cadenceId },
      include: { steps: { orderBy: { ordem: 'asc' }, take: 1 }, account: { select: { timezone: true } } },
    });

    if (!cadence) throw new Error('Cadência não encontrada');

    const firstStep = cadence.steps[0];
    const timezone = cadence.account?.timezone || 'America/Sao_Paulo';
    const nextSendAt = firstStep
      ? calculateNextSendAt(firstStep.dayNumber, cadence.sendAtTime, timezone, cadence.startDate)
      : null;

    const enrollments = await Promise.all(
      data.contactIds.map(async (contactId) => {
        const existing = await prisma.emailEnrollment.findFirst({
          where: {
            cadenceId: data.cadenceId,
            contactId,
            status: 'active',
          },
        });
        if (existing) return existing;

        return prisma.emailEnrollment.create({
          data: {
            accountId: data.accountId,
            cadenceId: data.cadenceId,
            contactId,
            nextSendAt,
          },
        });
      })
    );

    return enrollments;
  },

  async unenrollContacts(cadenceId: string, contactIds: string[]) {
    return prisma.emailEnrollment.updateMany({
      where: {
        cadenceId,
        contactId: { in: contactIds },
        status: 'active',
      },
      data: { status: 'paused' },
    });
  },

  async listEnrollments(accountId: string, cadenceId?: string) {
    return prisma.emailEnrollment.findMany({
      where: {
        accountId,
        ...(cadenceId ? { cadenceId } : {}),
      },
      include: { contact: true, cadence: true },
      orderBy: { enrolledAt: 'desc' },
    });
  },

  // ==================== SENDS ====================

  async listSends(accountId: string, filters?: {
    cadenceId?: string;
    contactId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }) {
    const where: any = { accountId };
    if (filters?.contactId) where.contactId = filters.contactId;
    if (filters?.status) where.status = filters.status;
    if (filters?.cadenceId) {
      where.enrollment = { cadenceId: filters.cadenceId };
    }

    return prisma.emailSend.findMany({
      where,
      include: { contact: true, step: true },
      orderBy: { createdAt: 'desc' },
      take: filters?.limit || 50,
      skip: filters?.offset || 0,
    });
  },

  async getSendStats(accountId: string) {
   const [total, sentOnly, deliveredOnly, openedOnly, clickedOnly, bounced, failed] = await Promise.all([
     prisma.emailSend.count({ where: { accountId } }),
     prisma.emailSend.count({ where: { accountId, status: 'sent' } }),
     prisma.emailSend.count({ where: { accountId, status: 'delivered' } }),
     prisma.emailSend.count({ where: { accountId, status: 'opened' } }),
     prisma.emailSend.count({ where: { accountId, status: 'clicked' } }),
     prisma.emailSend.count({ where: { accountId, status: 'bounced' } }),
     prisma.emailSend.count({ where: { accountId, status: 'failed' } }),
   ]);
 
   // Cumulative metrics: Sent includes anything that reached the destination or beyond
   const opened = openedOnly + clickedOnly;
   const delivered = deliveredOnly + opened;
   const sent = sentOnly + delivered;
 
   return { total, sent, delivered, opened, clicked: clickedOnly, bounced, failed };
  },

  // ==================== CADENCE PROCESSOR (with rate limiting) ====================

  async processCadenceQueue() {
    const now = new Date();

    // Find active enrollments ready to send
    const readyEnrollments = await prisma.emailEnrollment.findMany({
      where: {
        status: 'active',
        nextSendAt: { lte: now },
      },
      include: {
        cadence: {
          include: {
            steps: { orderBy: { ordem: 'asc' } },
            rulesFrom: { where: { active: true } },
          },
        },
        contact: true,
      },
      take: 100, // Global batch limit
    });

    logger.info(`[EmailProcessor] Found ${readyEnrollments.length} enrollments to process`);

    // Group by account for rate limiting
    const byAccount = new Map<string, typeof readyEnrollments>();
    for (const enrollment of readyEnrollments) {
      const list = byAccount.get(enrollment.accountId) || [];
      list.push(enrollment);
      byAccount.set(enrollment.accountId, list);
    }

    let totalProcessed = 0;

    for (const [accountId, enrollments] of byAccount) {
      // Get account-specific rate limit config
      const account = await prisma.account.findUnique({
        where: { id: accountId },
        select: {
          emailBatchSize: true,
          emailDelayMs: true,
          sendgridApiKey: true,
          sendgridFromEmail: true,
          sendgridFromName: true,
        },
      });

      if (!account?.sendgridApiKey || !account?.sendgridFromEmail) {
        logger.warn(`[EmailProcessor] No SendGrid credentials for account ${accountId}`);
        continue;
      }

      const batchSize = account.emailBatchSize || 100;
      const delayMs = account.emailDelayMs || 500;
      const creds = {
        apiKey: account.sendgridApiKey,
        fromEmail: account.sendgridFromEmail,
        fromName: account.sendgridFromName || 'GoodLeads CRM',
      };

      // ---- QUOTA CHECK (mensal + diário) ----
      const quota = await this.checkEmailQuota(accountId);
      if (!quota.canSend) {
        const reason = quota.daily.remaining <= 0
          ? `Limite diário (${quota.daily.limit}) atingido. Reset em ${new Date(quota.daily.resetAt).toLocaleString('pt-BR')}.`
          : `Limite mensal (${quota.monthly.limit}) atingido. Reset em ${new Date(quota.monthly.resetAt).toLocaleString('pt-BR')}.`;
        logger.warn(`[EmailProcessor] Quota esgotada para conta ${accountId}: ${reason}`);

        // Reagenda enrollments para o próximo reset (diário ou mensal, o mais cedo)
        const nextReset = new Date(Math.min(
          new Date(quota.daily.resetAt).getTime(),
          new Date(quota.monthly.resetAt).getTime(),
        ));
        await prisma.emailEnrollment.updateMany({
          where: { id: { in: enrollments.map(e => e.id) } },
          data: { nextSendAt: nextReset },
        });
        continue;
      }

      // Limita o lote ao MENOR entre: batchSize, restante diário e restante mensal
      const allowedByQuota = Math.min(quota.daily.remaining, quota.monthly.remaining);
      const effectiveBatchSize = Math.min(batchSize, allowedByQuota);
      const batch = enrollments.slice(0, effectiveBatchSize);

      // Reagenda os que ficaram fora do lote por causa da cota diária
      if (enrollments.length > batch.length) {
        const overflow = enrollments.slice(batch.length);
        const dayResetAt = new Date(quota.daily.resetAt);
        await prisma.emailEnrollment.updateMany({
          where: { id: { in: overflow.map(e => e.id) } },
          data: { nextSendAt: dayResetAt },
        });
        logger.info(`[EmailProcessor] ${overflow.length} envios reagendados para ${dayResetAt.toISOString()} (cota diária)`);
      }

      for (const enrollment of batch) {
        try {
          const steps = enrollment.cadence.steps.filter(s => s.active);
          const currentStep = steps[enrollment.currentStep];

          if (!currentStep || !enrollment.contact.email) {
            await prisma.emailEnrollment.update({
              where: { id: enrollment.id },
              data: { status: 'completed', completedAt: now },
            });
            continue;
          }

          // Resolve content: if step has a templateId, use the latest template content (so editing the template propagates)
          let stepSubject = currentStep.subject;
          let stepBodyHtml = currentStep.bodyHtml;
          let stepBodyText = currentStep.bodyText;
          if ((currentStep as any).templateId) {
            const tpl = await prisma.emailTemplate.findUnique({ where: { id: (currentStep as any).templateId } });
            if (tpl) {
              stepSubject = tpl.subject;
              stepBodyHtml = tpl.bodyHtml;
              stepBodyText = tpl.bodyText;
            }
          }

          // Replace variables
          const replacements: Record<string, string> = {
            '{nome}': enrollment.contact.nome || '',
            '{email}': enrollment.contact.email || '',
          };

          let subject = stepSubject;
          let bodyHtml = stepBodyHtml;
          for (const [key, val] of Object.entries(replacements)) {
            subject = subject.replace(new RegExp(key.replace(/[{}]/g, '\\$&'), 'g'), val);
            bodyHtml = bodyHtml.replace(new RegExp(key.replace(/[{}]/g, '\\$&'), 'g'), val);
          }

          // Create send record
          const emailSend = await prisma.emailSend.create({
            data: {
              accountId: enrollment.accountId,
              enrollmentId: enrollment.id,
              stepId: currentStep.id,
              contactId: enrollment.contactId,
              toEmail: enrollment.contact.email,
              subject,
              status: 'queued',
            },
          });

          // Send with exponential backoff on 429
          const result = await withBackoff(() =>
            sendgridService.sendEmail({
              to: enrollment.contact.email!,
              subject,
              html: bodyHtml,
              text: stepBodyText || undefined,
              fromEmail: creds.fromEmail,
              fromName: creds.fromName,
              apiKey: creds.apiKey,
            })
          );

          if (result.success) {
            await prisma.emailSend.update({
              where: { id: emailSend.id },
              data: {
                status: 'sent',
                sentAt: now,
                sendgridMessageId: result.messageId,
              },
            });

            // Advance to next step
            const nextStepIndex = enrollment.currentStep + 1;
            const nextStep = steps[nextStepIndex];

            if (nextStep) {
              const timezone = (await prisma.account.findUnique({ where: { id: enrollment.accountId }, select: { timezone: true } }))?.timezone || 'America/Sao_Paulo';
              const nextSendAt = calculateNextSendAt(nextStep.dayNumber, enrollment.cadence.sendAtTime, timezone, enrollment.cadence.startDate);
              await prisma.emailEnrollment.update({
                where: { id: enrollment.id },
                data: { currentStep: nextStepIndex, nextSendAt },
              });
            } else {
              await prisma.emailEnrollment.update({
                where: { id: enrollment.id },
                data: { status: 'completed', completedAt: now },
              });
            }

            totalProcessed++;
          } else {
            await prisma.emailSend.update({
              where: { id: emailSend.id },
              data: { status: 'failed', errorMessage: result.error },
            });
          }

          // Rate limit delay between sends
          await delay(delayMs);
        } catch (error: any) {
          logger.error(`[EmailProcessor] Error processing enrollment ${enrollment.id}: ${error.message}`);
        }
      }
    }

    // Process not_opened timeout rules during cron cycle
    await this.processNotOpenedRules();

    return totalProcessed;
  },

  // ==================== BRANCHING: REAL-TIME (called from webhook) ====================

  /**
   * Evaluate branching rules for a specific email send event in real-time.
   * Called directly from the SendGrid webhook handler.
   */
  async evaluateRulesForSend(sendId: string, triggerEvent: 'opened' | 'clicked' | 'bounced') {
    try {
      const send = await prisma.emailSend.findUnique({
        where: { id: sendId },
        include: {
          enrollment: {
            include: {
              cadence: {
                include: { rulesFrom: { where: { active: true } } },
              },
            },
          },
        },
      });

       // NOTE: We intentionally do NOT require status === 'active' here.
       // Single-step cadences mark the enrollment as 'completed' as soon as the
       // only step is sent. The 'opened' / 'clicked' / 'bounced' events naturally
       // arrive AFTER that completion, so requiring an active enrollment would
       // make the rule never fire for completed enrollments. Duplicate enrollment
       // protection is already handled inside applyBranchingRule().
       if (!send?.enrollment || !send.enrollment.cadence?.rulesFrom?.length) return;
       if (send.enrollment.status === 'unsubscribed' || send.enrollment.status === 'paused') return;

      const matchingRule = send.enrollment.cadence.rulesFrom.find(
        r => r.triggerEvent === triggerEvent
      );

      if (!matchingRule) return;

      await this.applyBranchingRule(matchingRule, send.enrollment, send.accountId);
    } catch (error: any) {
      logger.error(`[Branching RT] Error evaluating rules for send ${sendId}: ${error.message}`);
    }
  },

  /**
   * Apply a branching rule: complete current enrollment and create new one with proper delay.
   */
  async applyBranchingRule(
    rule: { targetCadenceId: string; delayHours: number; triggerEvent: string },
    enrollment: { id: string; contactId: string },
    accountId: string
  ) {
    // Avoid creating a duplicate enrollment if the contact is already running
    // (or paused, awaiting resume) in the target cadence. Completed/unsubscribed
    // enrollments do NOT block re-entering — the rule should be able to move
    // the contact in again on a new event.
    const existing = await prisma.emailEnrollment.findFirst({
      where: {
        cadenceId: rule.targetCadenceId,
        contactId: enrollment.contactId,
        status: { in: ['active', 'paused'] },
      },
    });

    if (existing) return;

    // Complete current enrollment
    await prisma.emailEnrollment.update({
      where: { id: enrollment.id },
      data: { status: 'completed', completedAt: new Date() },
    });

    // Calculate proper nextSendAt using target cadence's settings + delay_hours
    const targetCadence = await prisma.emailCadence.findUnique({
      where: { id: rule.targetCadenceId },
      include: {
        steps: { orderBy: { ordem: 'asc' }, take: 1 },
        account: { select: { timezone: true } },
      },
    });

     let nextSendAt: Date;
     if (rule.delayHours > 0) {
       // Apply delay_hours from now
       nextSendAt = new Date(Date.now() + rule.delayHours * 60 * 60 * 1000);
     } else {
       // Immediate move: set nextSendAt to now so it's picked up in the next cron cycle (or right away)
       nextSendAt = new Date();
     }

    await prisma.emailEnrollment.create({
      data: {
        accountId,
        cadenceId: rule.targetCadenceId,
        contactId: enrollment.contactId,
        nextSendAt,
      },
    });

    logger.info(`[Branching] Contact ${enrollment.contactId} → cadence ${rule.targetCadenceId} (trigger: ${rule.triggerEvent}, delay: ${rule.delayHours}h)`);
  },

  // ==================== BRANCHING: NOT_OPENED TIMEOUT (called from cron) ====================

  /**
   * Process not_opened rules: check sends that were sent X hours ago
   * and were never opened. Runs during the cron cycle.
   */
  async processNotOpenedRules() {
    try {
      // Find all active not_opened rules
      const notOpenedRules = await prisma.emailCadenceRule.findMany({
        where: { triggerEvent: 'not_opened', active: true },
        include: {
          cadence: { select: { id: true, accountId: true } },
        },
      });

      for (const rule of notOpenedRules) {
        const timeoutMs = (rule.timeoutHours || 48) * 60 * 60 * 1000;
        const cutoffDate = new Date(Date.now() - timeoutMs);

        // Find sends from this cadence that were sent before cutoff and never opened
        const unopenedSends = await prisma.emailSend.findMany({
          where: {
            status: { in: ['sent', 'delivered'] },
            sentAt: { lte: cutoffDate },
            openedAt: null,
            clickedAt: null,
            enrollmentId: { not: null },
            enrollment: {
              cadenceId: rule.cadenceId,
              status: 'active',
            },
          },
          include: {
            enrollment: true,
          },
          take: 50,
        });

        for (const send of unopenedSends) {
          if (!send.enrollment) continue;
          await this.applyBranchingRule(rule, send.enrollment, send.accountId);
        }

        if (unopenedSends.length > 0) {
          logger.info(`[Branching] Processed ${unopenedSends.length} not_opened sends for cadence ${rule.cadenceId} (timeout: ${rule.timeoutHours}h)`);
        }
      }
    } catch (error: any) {
      logger.error(`[Branching] Error processing not_opened rules: ${error.message}`);
    }
  },
};

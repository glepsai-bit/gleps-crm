import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { emailService } from '../services/email.service';
import { emailAiService } from '../services/email-ai.service';
import { sendgridService } from '../services/sendgrid.service';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

// Helper to extract accountId/userId from authenticated request
function getAccountId(req: Request): string {
  return (req as any).user?.accountId;
}
function getUserId(req: Request): string {
  return (req as any).user?.id;
}

/**
 * Log a test-send to email_sends so it appears in metrics.
 * Best-effort: never throws.
 */
async function logTestSend(
  accountId: string,
  toEmail: string,
  subject: string,
  result: { success: boolean; messageId?: string; error?: string },
) {
  if (!accountId || !toEmail) return;
  try {
    // Find or create a placeholder contact for the test recipient
    let contact = await prisma.contact.findFirst({
      where: { accountId, email: { equals: toEmail, mode: 'insensitive' } },
      select: { id: true },
    });
    if (!contact) {
      contact = await prisma.contact.create({
        data: { accountId, email: toEmail, nome: toEmail.split('@')[0] || 'Teste' },
        select: { id: true },
      });
    }
    await prisma.emailSend.create({
      data: {
        accountId,
        contactId: contact.id,
        toEmail,
        subject,
        status: result.success ? 'sent' : 'failed',
        sentAt: result.success ? new Date() : null,
        sendgridMessageId: result.messageId || null,
        errorMessage: result.success ? null : (result.error || null),
      },
    });
  } catch (err: any) {
    logger.warn(`[testSendEmail] Could not log to email_sends: ${err.message}`);
  }
}

export const emailController = {
  // ==================== CADENCES ====================

  async listCadences(req: Request, res: Response, next: NextFunction) {
    try {
      const accountId = getAccountId(req);
      const cadences = await emailService.listCadences(accountId);
      res.json(cadences);
    } catch (error) { next(error); }
  },

  async getCadence(req: Request, res: Response, next: NextFunction) {
    try {
      const accountId = getAccountId(req);
      const cadence = await emailService.getCadence(req.params.id as string, accountId);
      if (!cadence) return res.status(404).json({ error: 'Cadência não encontrada' });
      res.json(cadence);
    } catch (error) { next(error); }
  },

  async createCadence(req: Request, res: Response, next: NextFunction) {
    try {
      const accountId = getAccountId(req);
      const userId = getUserId(req);
      const cadence = await emailService.createCadence({
        accountId,
        ...req.body,
        createdBy: userId,
      });
      res.status(201).json(cadence);
    } catch (error) { next(error); }
  },

  async updateCadence(req: Request, res: Response, next: NextFunction) {
    try {
      const accountId = getAccountId(req);
      const cadence = await emailService.updateCadence(req.params.id as string, accountId, req.body);
      res.json(cadence);
    } catch (error) { next(error); }
  },

  async deleteCadence(req: Request, res: Response, next: NextFunction) {
    try {
      const accountId = getAccountId(req);
      await emailService.deleteCadence(req.params.id as string, accountId);
      res.json({ success: true });
    } catch (error) { next(error); }
  },

  // ==================== STEPS ====================

  async listSteps(req: Request, res: Response, next: NextFunction) {
    try {
      const cadence = await emailService.getCadence(req.params.id as string, getAccountId(req));
      res.json(cadence?.steps || []);
    } catch (error) { next(error); }
  },

  async createStep(req: Request, res: Response, next: NextFunction) {
    try {
      const step = await emailService.createStep(req.params.id as string, req.body);
      res.status(201).json(step);
    } catch (error) { next(error); }
  },

  async updateStep(req: Request, res: Response, next: NextFunction) {
    try {
      const step = await emailService.updateStep(req.params.id as string, req.body);
      res.json(step);
    } catch (error) { next(error); }
  },

  async deleteStep(req: Request, res: Response, next: NextFunction) {
    try {
      await emailService.deleteStep(req.params.id as string);
      res.json({ success: true });
    } catch (error) { next(error); }
  },

  // ==================== TEMPLATES ====================

  async listTemplates(req: Request, res: Response, next: NextFunction) {
    try {
      const accountId = getAccountId(req);
      const templates = await emailService.listTemplates(accountId);
      res.json(templates);
    } catch (error) { next(error); }
  },

  async createTemplate(req: Request, res: Response, next: NextFunction) {
    try {
      const accountId = getAccountId(req);
      const userId = getUserId(req);
      const template = await emailService.createTemplate({
        accountId,
        ...req.body,
        createdBy: userId,
      });
      res.status(201).json(template);
    } catch (error) { next(error); }
  },

  async updateTemplate(req: Request, res: Response, next: NextFunction) {
    try {
      const template = await emailService.updateTemplate(req.params.id as string, req.body);
      res.json(template);
    } catch (error) { next(error); }
  },

  async deleteTemplate(req: Request, res: Response, next: NextFunction) {
    try {
      await emailService.deleteTemplate(req.params.id as string);
      res.json({ success: true });
    } catch (error) { next(error); }
  },

  // ==================== ENROLLMENTS ====================

  async enroll(req: Request, res: Response, next: NextFunction) {
    try {
      const accountId = getAccountId(req);
      const enrollments = await emailService.enrollContacts({
        accountId,
        cadenceId: req.body.cadenceId,
        contactIds: req.body.contactIds,
      });
      res.status(201).json(enrollments);
    } catch (error) { next(error); }
  },

  async unenroll(req: Request, res: Response, next: NextFunction) {
    try {
      await emailService.unenrollContacts(req.body.cadenceId, req.body.contactIds);
      res.json({ success: true });
    } catch (error) { next(error); }
  },

  async listEnrollments(req: Request, res: Response, next: NextFunction) {
    try {
      const accountId = getAccountId(req);
      const enrollments = await emailService.listEnrollments(accountId, req.query.cadenceId as string);
      res.json(enrollments);
    } catch (error) { next(error); }
  },

  // ==================== SENDS ====================

  async listSends(req: Request, res: Response, next: NextFunction) {
    try {
      const accountId = getAccountId(req);
      const sends = await emailService.listSends(accountId, {
        cadenceId: req.query.cadenceId as string,
        contactId: req.query.contactId as string,
        status: req.query.status as string,
        limit: parseInt(req.query.limit as string) || 50,
        offset: parseInt(req.query.offset as string) || 0,
      });
      res.json(sends);
    } catch (error) { next(error); }
  },

  async getSendStats(req: Request, res: Response, next: NextFunction) {
    try {
      const accountId = getAccountId(req);
      const stats = await emailService.getSendStats(accountId);
      res.json(stats);
    } catch (error) { next(error); }
  },

  // ==================== QUOTA ====================

  async getQuota(req: Request, res: Response, next: NextFunction) {
    try {
      const accountId = getAccountId(req);
      const quota = await emailService.checkEmailQuota(accountId);
      res.json(quota);
    } catch (error) { next(error); }
  },

  // ==================== AI ====================

  async generateEmail(req: Request, res: Response, next: NextFunction) {
    try {
      const accountId = getAccountId(req);
      const result = await emailAiService.generateEmail({
        accountId,
        prompt: req.body.prompt,
        context: req.body.context,
      });
      res.json(result);
    } catch (error) { next(error); }
  },

  // ==================== SETTINGS ====================

  async getSettings(req: Request, res: Response, next: NextFunction) {
    try {
      const accountId = getAccountId(req);
      const acc = await prisma.account.findUnique({
        where: { id: accountId },
        select: {
          openaiApiKey: true,
          sendgridApiKey: true,
          sendgridFromEmail: true,
          sendgridFromName: true,
        },
      });
      res.json({
        hasOpenaiKey: !!acc?.openaiApiKey,
        hasSendgridKey: !!acc?.sendgridApiKey,
        sendgridFromEmail: acc?.sendgridFromEmail || '',
        sendgridFromName: acc?.sendgridFromName || '',
      });
    } catch (error) { next(error); }
  },

  async updateSettings(req: Request, res: Response, next: NextFunction) {
    try {
      const accountId = getAccountId(req);
      const { openaiApiKey, sendgridApiKey, sendgridFromEmail, sendgridFromName } = req.body;
      const data: any = {};
      if (openaiApiKey !== undefined) data.openaiApiKey = openaiApiKey || null;
      if (sendgridApiKey !== undefined) data.sendgridApiKey = sendgridApiKey || null;
      if (sendgridFromEmail !== undefined) data.sendgridFromEmail = sendgridFromEmail || null;
      if (sendgridFromName !== undefined) data.sendgridFromName = sendgridFromName || null;
      await prisma.account.update({ where: { id: accountId }, data });
      res.json({ success: true });
    } catch (error) { next(error); }
  },

  // ==================== PROCESSOR ====================

  async processQueue(req: Request, res: Response, next: NextFunction) {
    try {
      const accountId = getAccountId(req);
      const cadenceId = req.body.cadenceId as string | undefined;

      // If a specific cadence is targeted, only force those enrollments
      const whereClause: any = { accountId, status: 'active', nextSendAt: { not: null } };
      if (cadenceId) {
        whereClause.cadenceId = cadenceId;
      }

      await prisma.emailEnrollment.updateMany({
        where: whereClause,
        data: { nextSendAt: new Date() },
      });
      const processed = await emailService.processCadenceQueue();
      res.json({ success: true, processed });
    } catch (error) { next(error); }
  },

  // ==================== CADENCE RULES ====================

  async listRules(req: Request, res: Response, next: NextFunction) {
    try {
      const rules = await emailService.listRules(req.params.id as string);
      res.json(rules);
    } catch (error) { next(error); }
  },

  async createRule(req: Request, res: Response, next: NextFunction) {
    try {
      const rule = await emailService.createRule({
        cadenceId: req.params.id as string,
        ...req.body,
      });
      res.status(201).json(rule);
    } catch (error) { next(error); }
  },

  async updateRule(req: Request, res: Response, next: NextFunction) {
    try {
      const rule = await emailService.updateRule(req.params.id as string, req.body);
      res.json(rule);
    } catch (error) { next(error); }
  },

  async deleteRule(req: Request, res: Response, next: NextFunction) {
    try {
      await emailService.deleteRule(req.params.id as string);
      res.json({ success: true });
    } catch (error) { next(error); }
  },

  // ==================== CONNECTIONS ====================

  async testSendgrid(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await sendgridService.testConnection(req.body.apiKey);
      res.json(result);
    } catch (error) { next(error); }
  },

  async testSendEmail(req: Request, res: Response, next: NextFunction) {
    try {
      let apiKey = req.body.apiKey;
      let fromEmail = req.body.fromEmail;
      let fromName = req.body.fromName || 'GoodLeads CRM';
      const accountId = getAccountId(req);

      // If using existing credentials from account
      if (apiKey === '__existing__') {
        const creds = await sendgridService.getAccountCredentials(accountId);
        if (!creds) {
          return res.json({ success: false, error: 'Credenciais SendGrid não configuradas na conta.' });
        }
        apiKey = creds.apiKey;
        fromEmail = fromEmail || creds.fromEmail;
        fromName = fromName || creds.fromName;
      }

      const subject = req.body.subject || 'Teste de E-mail - GoodLeads CRM';
      const toEmail = req.body.toEmail;

      // If custom HTML body is provided, send that instead of the default test template
      if (req.body.html) {
        const result = await sendgridService.sendEmail({
          to: toEmail,
          subject,
          html: req.body.html,
          text: req.body.text || undefined,
          fromEmail,
          fromName,
          apiKey,
        });
        await logTestSend(accountId, toEmail, subject, result);
        return res.json(result);
      }

      const result = await sendgridService.sendTestEmail(
        apiKey,
        fromEmail,
        fromName,
        toEmail,
      );
      await logTestSend(accountId, toEmail, 'Teste de Conexão - GoodLeads CRM', result);
      res.json(result);
    } catch (error) { next(error); }
  },

  async testOpenai(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await emailAiService.testConnection(req.body.apiKey);
      res.json(result);
    } catch (error) { next(error); }
  },

  // ==================== SEARCH ====================
  async searchByEmail(req: Request, res: Response, next: NextFunction) {
    try {
      const accountId = getAccountId(req);
      const email = (req.query.email as string || '').toLowerCase().trim();
      if (!email) return res.json({ contact: null, enrollments: [], sends: [] });

      const contact = await prisma.contact.findFirst({
        where: { accountId, email: { contains: email, mode: 'insensitive' } },
      });

      if (!contact) return res.json({ contact: null, enrollments: [], sends: [] });

      const [enrollments, sends] = await Promise.all([
        prisma.emailEnrollment.findMany({
          where: { contactId: contact.id },
          include: { cadence: { select: { id: true, name: true } } },
          orderBy: { enrolledAt: 'desc' },
        }),
        prisma.emailSend.findMany({
          where: { contactId: contact.id },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
      ]);

      res.json({ contact, enrollments, sends });
    } catch (error) { next(error); }
  },
};

// ==================== WEBHOOK (public, no auth) ====================
export const emailWebhookController = {
  async handleSendgridWebhook(req: Request, res: Response, next: NextFunction) {
    try {
      const events = req.body;
      if (!Array.isArray(events)) {
        return res.status(400).json({ error: 'Invalid payload' });
      }
      await sendgridService.processWebhookEvent(events);
      res.status(200).json({ received: true });
    } catch (error) {
      logger.error('[SendGrid Webhook] Error:', error);
      next(error);
    }
  },
};

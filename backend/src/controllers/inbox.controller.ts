import { Request, Response, NextFunction } from 'express';
import { inboxService } from '../services/inbox.service';
import { sendgridService } from '../services/sendgrid.service';
import { emailAiService } from '../services/email-ai.service';
import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

function getAccountId(req: Request): string {
  return (req as any).user?.accountId;
}

export const inboxController = {
  async listMessages(req: Request, res: Response, next: NextFunction) {
    try {
      const filters = {
        read: req.query.read !== undefined ? req.query.read === 'true' : undefined,
        contactId: req.query.contactId as string | undefined,
        limit: parseInt(req.query.limit as string) || 50,
        offset: parseInt(req.query.offset as string) || 0,
      };
      const data = await inboxService.listMessages(getAccountId(req), filters);
      res.json(data);
    } catch (error) { next(error); }
  },

  async getMessage(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await inboxService.getMessage(req.params.id as string);
      if (!data) return res.status(404).json({ error: 'Mensagem não encontrada' });
      res.json(data);
    } catch (error) { next(error); }
  },

  async markRead(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await inboxService.markRead(req.params.id as string);
      res.json(data);
    } catch (error) { next(error); }
  },

  async getUnreadCount(req: Request, res: Response, next: NextFunction) {
    try {
      const count = await inboxService.getUnreadCount(getAccountId(req));
      res.json({ count });
    } catch (error) { next(error); }
  },

  // Reply to a message
  async reply(req: Request, res: Response, next: NextFunction) {
    try {
      const accountId = getAccountId(req);
      const { messageId, subject, bodyHtml, bodyText } = req.body;

      const message = await inboxService.getMessage(messageId);
      if (!message) return res.status(404).json({ error: 'Mensagem não encontrada' });

      const creds = await sendgridService.getAccountCredentials(accountId);
      if (!creds) return res.status(400).json({ error: 'Credenciais SendGrid não configuradas' });

      const result = await sendgridService.sendEmail({
        to: message.fromEmail,
        subject: subject || `Re: ${message.subject}`,
        html: bodyHtml,
        text: bodyText,
        fromEmail: creds.fromEmail,
        fromName: creds.fromName,
        apiKey: creds.apiKey,
      });

      if (result.success) {
        await prisma.emailInboxMessage.update({
          where: { id: messageId },
          data: { replied: true, repliedAt: new Date() },
        });
      }

      res.json(result);
    } catch (error) { next(error); }
  },

  // Generate AI reply suggestion
  async suggestReply(req: Request, res: Response, next: NextFunction) {
    try {
      const accountId = getAccountId(req);
      const { messageId, instructions } = req.body;

      const message = await inboxService.getMessage(messageId);
      if (!message) return res.status(404).json({ error: 'Mensagem não encontrada' });

      const account = await prisma.account.findUnique({
        where: { id: accountId },
        select: { openaiApiKey: true },
      });

      if (!account?.openaiApiKey) {
        return res.status(400).json({ error: 'Chave OpenAI não configurada' });
      }

      const prompt = `Gere uma resposta profissional para o seguinte e-mail recebido.
De: ${message.fromEmail} (${message.contact?.nome || 'Lead'})
Assunto: ${message.subject}
Mensagem: ${message.bodyText || 'Sem conteúdo de texto'}

${instructions ? `Instruções adicionais: ${instructions}` : ''}

Responda em formato JSON: {"subject":"...","bodyHtml":"...","bodyText":"..."}`;

      const result = await emailAiService.generateWithKey(account.openaiApiKey, prompt);
      res.json(result);
    } catch (error) { next(error); }
  },

  // SendGrid Inbound Parse webhook
  async handleInboundWebhook(req: Request, res: Response, next: NextFunction) {
    try {
      const { from, to, subject, text, html } = req.body;

      // Extract email from "Name <email@example.com>" format
      const emailMatch = (from || '').match(/<([^>]+)>/) || [null, from];
      const fromEmail = (emailMatch[1] || from || '').trim().toLowerCase();

      if (!fromEmail) {
        return res.status(400).json({ error: 'No from email' });
      }

      await inboxService.processInboundEmail({
        fromEmail,
        toEmail: to || '',
        subject: subject || '(Sem assunto)',
        bodyText: text,
        bodyHtml: html,
      });

      res.status(200).json({ received: true });
    } catch (error) {
      logger.error('[Inbound Webhook] Error:', error);
      next(error);
    }
  },

  // Diagnostics: tells the admin if inbox is wired up correctly
  async getDiagnostics(req: Request, res: Response, next: NextFunction) {
    try {
      const accountId = getAccountId(req);
      const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
      const host = (req.headers['x-forwarded-host'] as string) || req.get('host');
      const webhookUrl = `${proto}://${host}/api/email/inbound/webhook`;

      const [total, unread, latest, sendgridCfg] = await Promise.all([
        prisma.emailInboxMessage.count({ where: { accountId } }),
        prisma.emailInboxMessage.count({ where: { accountId, read: false } }),
        prisma.emailInboxMessage.findFirst({
          where: { accountId },
          orderBy: { receivedAt: 'desc' },
          select: { receivedAt: true, fromEmail: true },
        }),
        prisma.account.findUnique({
          where: { id: accountId },
          select: { sendgridFromEmail: true, sendgridApiKey: true },
        }),
      ]);

      res.json({
        webhookUrl,
        totalMessages: total,
        unreadMessages: unread,
        latestReceivedAt: latest?.receivedAt || null,
        latestFromEmail: latest?.fromEmail || null,
        sendgridConfigured: !!sendgridCfg?.sendgridApiKey,
        sendgridFromEmail: sendgridCfg?.sendgridFromEmail || null,
      });
    } catch (error) { next(error); }
  },

  // Mark as replied manually (when user replied outside the platform)
  async markRepliedManually(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await prisma.emailInboxMessage.update({
        where: { id: req.params.id as string },
        data: { replied: true, repliedAt: new Date(), read: true },
      });
      res.json(data);
    } catch (error) { next(error); }
  },

  // Pause / Resume / Unenroll the cadence linked to a message
  async pauseEnrollment(req: Request, res: Response, next: NextFunction) {
    try {
      const message = await inboxService.getMessage(req.params.id as string);
      if (!message?.enrollmentId) return res.status(404).json({ error: 'Mensagem sem inscrição vinculada' });
      const updated = await prisma.emailEnrollment.update({
        where: { id: message.enrollmentId },
        data: { status: 'paused' },
      });
      res.json({ success: true, enrollment: updated });
    } catch (error) { next(error); }
  },

  async resumeEnrollment(req: Request, res: Response, next: NextFunction) {
    try {
      const message = await inboxService.getMessage(req.params.id as string);
      if (!message?.enrollmentId) return res.status(404).json({ error: 'Mensagem sem inscrição vinculada' });
      const updated = await prisma.emailEnrollment.update({
        where: { id: message.enrollmentId },
        data: { status: 'active' },
      });
      res.json({ success: true, enrollment: updated });
    } catch (error) { next(error); }
  },

  async unenrollFromCadence(req: Request, res: Response, next: NextFunction) {
    try {
      const message = await inboxService.getMessage(req.params.id as string);
      if (!message?.enrollmentId) return res.status(404).json({ error: 'Mensagem sem inscrição vinculada' });
      const updated = await prisma.emailEnrollment.update({
        where: { id: message.enrollmentId },
        data: { status: 'unsubscribed', completedAt: new Date() },
      });
      res.json({ success: true, enrollment: updated });
    } catch (error) { next(error); }
  },
};

import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

// Lazy import to avoid circular dependency
let _emailService: any = null;
async function getEmailService() {
  if (!_emailService) {
    const mod = await import('./email.service');
    _emailService = mod.emailService;
  }
  return _emailService;
}

interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
  fromEmail: string;
  fromName: string;
  apiKey: string;
}

interface SendGridResponse {
  success: boolean;
  messageId?: string;
  error?: string;
}

// Hierarquia de status: índice maior = mais avançado.
// Eventos do SendGrid podem chegar fora de ordem (ex.: 'open' antes de 'delivered').
// Nunca devemos regredir, apenas avançar timestamps.
const STATUS_RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  opened: 3,
  clicked: 4,
  bounced: 5,
  spam: 6,
  failed: 7,
};

export const sendgridService = {
  /**
   * Send an email via SendGrid API (REST, no SDK needed)
   */
  async sendEmail(params: SendEmailParams): Promise<SendGridResponse> {
    const { to, subject, html, text, fromEmail, fromName, apiKey } = params;

    try {
      const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: fromEmail, name: fromName },
          subject,
          content: [
            ...(text ? [{ type: 'text/plain', value: text }] : []),
            { type: 'text/html', value: html },
          ],
          tracking_settings: {
            click_tracking: { enable: true },
            open_tracking: { enable: true },
          },
        }),
      });

      if (response.status === 202) {
        const messageId = response.headers.get('x-message-id') || undefined;
        logger.info(`[SendGrid] Email sent to ${to}, messageId: ${messageId}`);
        return { success: true, messageId };
      }

      const errorBody = await response.text();
      logger.error(`[SendGrid] Failed to send: ${response.status} ${errorBody}`);
      return { success: false, error: `SendGrid ${response.status}: ${errorBody}` };
    } catch (error: any) {
      logger.error(`[SendGrid] Error: ${error.message}`);
      return { success: false, error: error.message };
    }
  },

  /**
   * Test SendGrid connection with a validation request
   */
  async testConnection(apiKey: string): Promise<{ success: boolean; message: string }> {
    try {
      const response = await fetch('https://api.sendgrid.com/v3/user/profile', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });

      if (response.ok) {
        return { success: true, message: 'Conexão com SendGrid estabelecida!' };
      }

      return { success: false, message: `Erro ${response.status}: Chave API inválida ou sem permissão.` };
    } catch (error: any) {
      return { success: false, message: `Erro de conexão: ${error.message}` };
    }
  },

  /**
   * Send a test email
   */
  async sendTestEmail(
    apiKey: string,
    fromEmail: string,
    fromName: string,
    toEmail: string
  ): Promise<SendGridResponse> {
    return this.sendEmail({
      to: toEmail,
      subject: 'Teste de Conexão - GoodLeads CRM',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #6366F1;">✅ Teste de E-mail</h2>
          <p>Este é um e-mail de teste enviado pelo GoodLeads CRM.</p>
          <p>Se você recebeu este e-mail, sua integração com SendGrid está funcionando corretamente!</p>
          <hr style="border: 1px solid #e5e7eb; margin: 20px 0;">
          <p style="color: #9ca3af; font-size: 12px;">Enviado por ${fromName} via GoodLeads CRM</p>
        </div>
      `,
      text: 'Este é um e-mail de teste enviado pelo GoodLeads CRM.',
      fromEmail,
      fromName,
      apiKey,
    });
  },

  /**
   * Get SendGrid credentials for an account
   */
  async getAccountCredentials(accountId: string) {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: {
        sendgridApiKey: true,
        sendgridFromEmail: true,
        sendgridFromName: true,
      },
    });

    if (!account?.sendgridApiKey || !account?.sendgridFromEmail) {
      return null;
    }

    return {
      apiKey: account.sendgridApiKey,
      fromEmail: account.sendgridFromEmail,
      fromName: account.sendgridFromName || 'GoodLeads CRM',
    };
  },

  /**
   * Process SendGrid webhook event
   */
  async processWebhookEvent(events: Array<{
    event: string;
    sg_message_id?: string;
    timestamp?: number;
    email?: string;
  }>) {
    for (const event of events) {
      if (!event.sg_message_id) continue;

      const sgMsgId = event.sg_message_id.split('.')[0]; // Remove .filter info

      try {
        const emailSend = await prisma.emailSend.findFirst({
          where: { sendgridMessageId: sgMsgId },
        });

        if (!emailSend) continue;

        const updateData: any = {};
        let nextStatus: string | null = null;

        switch (event.event) {
          case 'delivered':
            nextStatus = 'delivered';
            break;
          case 'open':
            nextStatus = 'opened';
            updateData.openedAt = new Date();
            break;
          case 'click':
            nextStatus = 'clicked';
            updateData.clickedAt = new Date();
            break;
          case 'bounce':
          case 'dropped':
            nextStatus = 'bounced';
            updateData.bouncedAt = new Date();
            break;
          case 'spamreport':
            nextStatus = 'spam';
            break;
          default:
            continue;
        }

        // Só promove o status se for mais avançado que o atual.
        // Bounce/spam/failed sempre podem sobrescrever para refletir falha real.
        if (nextStatus) {
          const currentRank = STATUS_RANK[emailSend.status] ?? -1;
          const nextRank = STATUS_RANK[nextStatus] ?? -1;
          const isFailureEvent = ['bounced', 'spam', 'failed'].includes(nextStatus);
          if (nextRank > currentRank || isFailureEvent) {
            updateData.status = nextStatus;
          }
        }

        if (Object.keys(updateData).length === 0) {
          // Nada a atualizar (timestamps já gravados ou status superior).
          continue;
        }

        await prisma.emailSend.update({
          where: { id: emailSend.id },
          data: updateData,
        });

        // Real-time branching: evaluate rules immediately for actionable events
        if (nextStatus && ['opened', 'clicked', 'bounced'].includes(nextStatus)) {
          try {
            const es = await getEmailService();
            await es.evaluateRulesForSend(emailSend.id, nextStatus as 'opened' | 'clicked' | 'bounced');
          } catch (branchErr: any) {
            logger.error(`[SendGrid Webhook] Branching error: ${branchErr.message}`);
          }
        }

        // If bounced, update enrollment too
        if (nextStatus === 'bounced' && emailSend.enrollmentId) {
          await prisma.emailEnrollment.update({
            where: { id: emailSend.enrollmentId },
            data: { status: 'bounced' },
          });
        }

        logger.info(`[SendGrid Webhook] Updated email ${emailSend.id}: ${event.event}`);
      } catch (error: any) {
        logger.error(`[SendGrid Webhook] Error processing event: ${error.message}`);
      }
    }
  },
};

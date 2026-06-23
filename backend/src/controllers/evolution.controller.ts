import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import { prisma } from '../config/database';
import { evolutionService } from '../services/evolution.service';
import { whatsappConsentService } from '../services/whatsapp-consent.service';
import { logger } from '../utils/logger';
import { AuthenticatedRequest } from '../types';
import { ForbiddenError, ErrorCodes } from '../utils/errors';

export class EvolutionController {
  /**
   * Ensure the authenticated user can access the given accountId.
   * Super admin can access any account; admin can only access their own.
   */
  private assertCanAccessAccount(req: AuthenticatedRequest, accountId: string): void {
    if (!req.user) {
      throw new ForbiddenError(ErrorCodes.PERMISSION_DENIED);
    }

    if (req.user.role === 'super_admin') {
      return;
    }

    if (req.user.role === 'admin' && req.user.accountId === accountId) {
      return;
    }

    throw new ForbiddenError(ErrorCodes.PERMISSION_DENIED);
  }

  /**
   * GET /api/evolution/accounts/:accountId/qrcode
   */
  async getQrCode(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.params.accountId as string;
      this.assertCanAccessAccount(req, accountId);

      const result = await evolutionService.getQrCode(accountId);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/evolution/accounts/:accountId/status
   */
  async getStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.params.accountId as string;
      this.assertCanAccessAccount(req, accountId);

      const result = await evolutionService.getStatus(accountId);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/evolution/accounts/:accountId/disconnect
   */
  async disconnect(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.params.accountId as string;
      this.assertCanAccessAccount(req, accountId);

      const result = await evolutionService.disconnect(accountId);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Compara duas strings de assinatura em tempo constante.
   * Devolve false (sem lançar) se tamanhos divergem ou hex inválido.
   */
  private safeSignatureEqual(expectedHex: string, providedHex: string): boolean {
    try {
      const expected = Buffer.from(expectedHex, 'hex');
      const provided = Buffer.from(providedHex, 'hex');
      if (expected.length === 0 || expected.length !== provided.length) {
        return false;
      }
      return crypto.timingSafeEqual(expected, provided);
    } catch {
      return false;
    }
  }

  /**
   * POST /api/evolution/webhook/:accountId
   *
   * Recebe eventos da Evolution API (messages.upsert, connection.update, etc).
   * Endpoint PÚBLICO — não passa pelo middleware authenticate.
   *
   * BUG-018: valida HMAC SHA-256 do raw body via header `x-evolution-signature`
   * quando `account.evolutionWebhookSecret` está configurado. Se o secret está
   * setado mas a assinatura não bate (ou está ausente), responde 401.
   * Se o secret é null/undefined, ainda aceita por compatibilidade (TODO: forçar).
   *
   * BUG-006: após HMAC válido, processa keyword opt-out em mensagens inbound.
   */
  async receiveWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.params.accountId as string;
      const event = req.body?.event || req.body?.type || 'unknown';

      // ============================================
      // BUG-018: validação HMAC
      // ============================================
      const account = await prisma.account.findUnique({
        where: { id: accountId },
        select: { id: true, evolutionWebhookSecret: true },
      });

      if (!account) {
        logger.warn('[evolution-webhook] accountId desconhecido', { accountId });
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account not found' } });
        return;
      }

      if (account.evolutionWebhookSecret) {
        const headerSig = req.headers['x-evolution-signature'];
        const providedSig = Array.isArray(headerSig) ? headerSig[0] : headerSig;

        if (!providedSig || typeof providedSig !== 'string') {
          logger.warn('[evolution-webhook] header x-evolution-signature ausente', {
            accountId,
            event,
          });
          res.status(401).json({
            error: { code: 'INVALID_SIGNATURE', message: 'Missing signature header' },
          });
          return;
        }

        const rawBody: Buffer | undefined = (req as any).rawBody;
        if (!rawBody) {
          logger.error('[evolution-webhook] rawBody indisponível para validar HMAC', undefined, {
            accountId,
          });
          res.status(401).json({
            error: { code: 'INVALID_SIGNATURE', message: 'Raw body not available' },
          });
          return;
        }

        const expectedSig = crypto
          .createHmac('sha256', account.evolutionWebhookSecret)
          .update(rawBody)
          .digest('hex');

        // Permite tanto `<hex>` quanto `sha256=<hex>` (compat com diferentes clientes)
        const normalizedProvided = providedSig.startsWith('sha256=')
          ? providedSig.slice('sha256='.length)
          : providedSig;

        if (!this.safeSignatureEqual(expectedSig, normalizedProvided)) {
          logger.warn('[evolution-webhook] assinatura HMAC inválida', { accountId, event });
          res.status(401).json({
            error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' },
          });
          return;
        }
      } else {
        // TODO(BUG-018): tornar o secret obrigatório após migração de contas existentes.
        logger.warn(
          '[evolution-webhook] evolutionWebhookSecret não configurado — aceitando sem HMAC',
          { accountId, event }
        );
      }

      logger.info('Evolution webhook received', {
        accountId,
        event,
        instance: req.body?.instance,
        bodyKeys: req.body && typeof req.body === 'object' ? Object.keys(req.body) : [],
      });

      // ============================================
      // BUG-006: keyword opt-out em mensagens inbound do cliente
      // ============================================
      if (event === 'messages.upsert') {
        try {
          const body: any = req.body || {};
          const fromMe = Boolean(body?.data?.key?.fromMe);

          if (!fromMe) {
            const messageText: string =
              body?.data?.message?.conversation ||
              body?.data?.message?.extendedTextMessage?.text ||
              '';
            const remoteJid: string | undefined = body?.data?.key?.remoteJid;
            const phone = remoteJid ? String(remoteJid).split('@')[0] : '';

            if (messageText && phone) {
              await whatsappConsentService.handleInboundOptOut(accountId, phone, messageText);
            }
          }
        } catch (err: any) {
          // Não derruba o webhook por falha no opt-out — apenas loga.
          logger.warn('[evolution-webhook] falha ao processar opt-out inbound', {
            accountId,
            event,
            error: err?.message ?? String(err),
          });
        }
      }

      res.status(200).json({ received: true });
    } catch (error) {
      next(error);
    }
  }
}

export const evolutionController = new EvolutionController();

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { voiceService, SENTINEL } from '../services/voice.service';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { AuthenticatedRequest } from '../types';

/**
 * T-029 — Discador.
 *
 * Duas famílias de rota aqui, com autenticação DIFERENTE:
 *
 *  - As do operador (/token, /calls, /config) usam JWT normal.
 *  - As da operadora (/twiml, /status, /recording) são PÚBLICAS, porque quem
 *    chama é a Twilio, que não tem como carregar nosso JWT. A defesa delas é a
 *    assinatura HMAC do próprio provedor (X-Twilio-Signature).
 */

const configSchema = z.object({
  twilioAccountSid: z.string().max(120).optional().nullable(),
  twilioAuthToken: z.string().max(200).optional().nullable(),
  twilioApiKeySid: z.string().max(120).optional().nullable(),
  twilioApiKeySecret: z.string().max(200).optional().nullable(),
  twilioTwimlAppSid: z.string().max(120).optional().nullable(),
  twilioCallerId: z.string().max(30).optional().nullable(),
  voiceRecording: z.boolean().optional(),
});

const startCallSchema = z.object({
  to: z.string().min(3, 'Informe o número'),
  contactId: z.string().uuid().optional().nullable(),
});

const outcomeSchema = z.object({
  disposition: z.string().max(40).optional(),
  notes: z.string().max(5000).optional(),
});

const listSchema = z.object({
  contactId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

function baseUrl(): string {
  return (env.WEBHOOK_BASE_URL || env.API_URL).replace(/\/$/, '');
}

export class VoiceController {
  // ============================================
  // Configuração
  // ============================================

  async getConfig(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.user!.accountId!;
      const config = await voiceService.getConfig(accountId);
      res.json({
        data: {
          ...config,
          // A URL que o admin precisa colar no TwiML App da Twilio. Mostrar
          // pronta evita o erro mais comum da configuração (montar à mão).
          twimlVoiceUrl: `${baseUrl()}/api/voice/twiml/${accountId}`,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async updateConfig(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = configSchema.parse(req.body);
      const config = await voiceService.updateConfig(req.user!.accountId!, body);
      res.json({
        data: { ...config, twimlVoiceUrl: `${baseUrl()}/api/voice/twiml/${req.user!.accountId!}` },
      });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // Operador
  // ============================================

  /** GET /voice/token — credencial curta que o SDK do navegador usa pra discar. */
  async token(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const r = await voiceService.createAccessToken(req.user!.accountId!, req.user!.id);
      res.json({ data: r });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /voice/calls — registra a ligação e devolve o callId.
   * O navegador chama isto ANTES de conectar, e passa o callId pro SDK.
   */
  async startCall(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = startCallSchema.parse(req.body);
      const r = await voiceService.startCall({
        accountId: req.user!.accountId!,
        userId: req.user!.id,
        to: body.to,
        contactId: body.contactId ?? null,
      });
      res.status(201).json({ data: r });
    } catch (error) {
      next(error);
    }
  }

  async listCalls(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const q = listSchema.parse(req.query);
      res.json({ data: await voiceService.listCalls(req.user!.accountId!, q) });
    } catch (error) {
      next(error);
    }
  }

  async setOutcome(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = outcomeSchema.parse(req.body);
      const call = await voiceService.setOutcome(
        req.user!.accountId!,
        req.params.callId as string,
        body
      );
      res.json({ data: call });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // Webhooks da operadora (públicos, validados por assinatura)
  // ============================================

  /**
   * POST /voice/twiml/:accountId
   * A Twilio busca aqui a instrução do que fazer quando o navegador pede a
   * chamada. É esta resposta que encaminha a ligação pro número discado.
   */
  async twiml(req: Request, res: Response): Promise<void> {
    const accountId = req.params.accountId as string;
    const params = (req.body ?? {}) as Record<string, string>;

    try {
      const url = `${baseUrl()}${req.originalUrl}`;
      const assinaturaOk = await voiceService.validateWebhook(
        accountId,
        req.header('X-Twilio-Signature'),
        url,
        params
      );
      if (!assinaturaOk) {
        logger.warn('[voice] TwiML com assinatura inválida', { accountId, url });
        res.status(403).type('text/xml').send('<Response><Reject/></Response>');
        return;
      }

      const to = params.To;
      const callId = params.CallId;
      if (!to || !callId) {
        res.type('text/xml').send('<Response><Say language="pt-BR">Número não informado.</Say></Response>');
        return;
      }

      const xml = await voiceService.buildDialTwiml(accountId, to, callId);
      res.type('text/xml').send(xml);
    } catch (err) {
      // Erro aqui vira silêncio na linha; melhor dizer o que houve pro operador
      // ouvir do que devolver 500 e a chamada cair sem explicação.
      logger.error('[voice] falha ao montar TwiML', {
        accountId,
        error: err instanceof Error ? err.message : String(err),
      });
      res
        .type('text/xml')
        .send(
          '<Response><Say language="pt-BR">Não foi possível completar a chamada. Verifique a configuração do discador.</Say></Response>'
        );
    }
  }

  /**
   * Confere a assinatura de um callback que NÃO carrega o accountId na URL.
   * A conta é descoberta pela própria ligação — sem isso não daria pra saber
   * com qual Auth Token validar.
   */
  private async callbackAutorizado(req: Request, callId: string): Promise<boolean> {
    const accountId = await voiceService.accountIdDaLigacao(callId);
    if (!accountId) return false;
    const url = `${baseUrl()}${req.originalUrl}`;
    return voiceService.validateWebhook(
      accountId,
      req.header('X-Twilio-Signature'),
      url,
      (req.body ?? {}) as Record<string, string>
    );
  }

  /** POST /voice/status?callId= — eventos da ligação (tocando, atendeu, encerrou). */
  async status(req: Request, res: Response): Promise<void> {
    try {
      const callId = String(req.query.callId ?? '');
      // Sem a conferência de assinatura, quem descobrisse a URL conseguiria
      // forjar status e sujar o histórico de ligações.
      if (callId && (await this.callbackAutorizado(req, callId))) {
        await voiceService.handleStatusCallback(callId, (req.body ?? {}) as Record<string, string>);
      } else if (callId) {
        logger.warn('[voice] callback de status com assinatura inválida', { callId });
      }
    } catch (err) {
      logger.warn('[voice] falha ao processar status', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Sempre 204: erro nosso não pode fazer a operadora reenviar em laço.
    res.status(204).send();
  }

  /** POST /voice/recording?callId= — URL da gravação, quando habilitada. */
  async recording(req: Request, res: Response): Promise<void> {
    try {
      const callId = String(req.query.callId ?? '');
      if (callId && (await this.callbackAutorizado(req, callId))) {
        await voiceService.handleRecordingCallback(
          callId,
          (req.body ?? {}) as Record<string, string>
        );
      } else if (callId) {
        logger.warn('[voice] callback de gravação com assinatura inválida', { callId });
      }
    } catch (err) {
      logger.warn('[voice] falha ao registrar gravação', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    res.status(204).send();
  }
}

export const voiceController = new VoiceController();
export { SENTINEL };

import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { evolutionService } from '../services/evolution.service';
import { whatsappConsentService } from '../services/whatsapp-consent.service';
import { inboxChannelService } from '../services/inbox.service';
import { conversationService } from '../services/conversation.service';
import {
  messageService,
  MessageContentType,
  CreateAttachmentInput,
} from '../services/message.service';
import { logger } from '../utils/logger';
import { AuthenticatedRequest } from '../types';
import { ForbiddenError, ErrorCodes } from '../utils/errors';
import { emitInboxConnection } from '../socket';
import { env, isProduction } from '../config/env';

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
   *
   * BUG-FIX: normaliza ambas as strings (trim + lowercase) antes do parse hex.
   * Algumas implementações de provider enviam hex em UPPERCASE ou com espaços
   * em volta — sem normalização, Buffer.from('ABCDEF', 'hex') é válido mas
   * timingSafeEqual rejeita por bytes diferentes. A normalização é canônica
   * (case-insensitive porque hex é case-insensitive por definição) e mantém
   * o time-constant compare (acontece DEPOIS, sobre buffers do mesmo tamanho).
   */
  private safeSignatureEqual(expectedHex: string, providedHex: string): boolean {
    try {
      const normExpected = String(expectedHex).trim().toLowerCase();
      const normProvided = String(providedHex).trim().toLowerCase();
      const expected = Buffer.from(normExpected, 'hex');
      const provided = Buffer.from(normProvided, 'hex');
      if (expected.length === 0 || expected.length !== provided.length) {
        return false;
      }
      return crypto.timingSafeEqual(expected, provided);
    } catch {
      return false;
    }
  }

  /**
   * Compara dois tokens em tempo constante (não-hex — bytes utf-8 crus).
   * Aplica trim para tolerar whitespace de copy/paste em config de provider.
   */
  private safeTokenEqual(expected: string, provided: string): boolean {
    try {
      const a = Buffer.from(String(expected).trim(), 'utf8');
      const b = Buffer.from(String(provided).trim(), 'utf8');
      if (a.length === 0 || a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /**
   * Extrai o IP do cliente respeitando X-Forwarded-For (quando atrás de proxy
   * reverso confiável). Devolve null se não conseguir determinar.
   */
  private extractClientIp(req: Request): string | null {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      // Primeiro IP da chain (cliente original).
      return xff.split(',')[0].trim();
    }
    if (Array.isArray(xff) && xff.length > 0) {
      return xff[0].split(',')[0].trim();
    }
    const raw = req.ip || req.socket?.remoteAddress || null;
    if (!raw) return null;
    // Normaliza IPv4-mapped IPv6 (::ffff:1.2.3.4 → 1.2.3.4)
    return raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;
  }

  /**
   * Valida o IP do cliente contra EVOLUTION_ALLOWED_IPS (CSV de IPs exatos).
   * Retorna true se a lista não está configurada (allow-list desabilitada).
   * Implementação simples por igualdade — não expande CIDR (basta listar IPs
   * estáticos da Evolution self-hosted).
   */
  private isIpAllowed(req: Request): boolean {
    const csv = env.EVOLUTION_ALLOWED_IPS;
    if (!csv || csv.trim() === '') return true; // não configurado → não filtra
    const allowed = csv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowed.length === 0) return true;
    const ip = this.extractClientIp(req);
    if (!ip) return false;
    return allowed.includes(ip);
  }

  /**
   * POST /api/evolution/webhook/:accountId
   *
   * Recebe eventos da Evolution API (messages.upsert, connection.update, etc).
   * Endpoint PÚBLICO — não passa pelo middleware authenticate.
   *
   * BUG-018 (HARDENED + RELAXED): autenticação multi-modo para webhook Evolution.
   *
   * A Evolution API v2 self-hosted (ex.: autevo.gleps.com.br) NÃO calcula HMAC
   * SHA-256 sobre o body — apenas repassa headers fixos definidos em
   * `webhook.headers`. Exigir HMAC sempre quebra a integração real. Solução:
   * aceitar QUALQUER UMA das modalidades abaixo (OR), em ordem de preferência:
   *
   *   1. HMAC SHA-256 (`x-evolution-signature`) — modo forte, usado quando o
   *      provider suporta. Continua sendo o ideal.
   *   2. Bearer token estático (`x-evolution-token` OU `Authorization: Bearer …`)
   *      validado em time-constant contra `account.evolutionWebhookSecret`.
   *      Compatível com Evolution v2 (header fixo configurado em webhook.headers).
   *   3. IP allow-list via `EVOLUTION_ALLOWED_IPS` (CSV) — útil quando o provider
   *      sai de IP estático conhecido (rede interna / VPC peering).
   *
   * Em prod (NODE_ENV=production) pelo menos UMA modalidade precisa passar.
   * Em dev (NODE_ENV=development), se NENHUMA estiver configurada, aceita com
   * warning — facilita teste local sem segredo.
   * Override: `EVOLUTION_HMAC_REQUIRED=true` força HMAC mesmo em dev.
   *
   * O secret `account.evolutionWebhookSecret` deve ser populado no primeiro
   * connect do Inbox (random 32 bytes hex via crypto.randomBytes).
   *
   * BUG-006: após autenticação válida, processa keyword opt-out inbound.
   */
  async receiveWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.params.accountId as string;
      const event = req.body?.event || req.body?.type || 'unknown';

      // D) Log INFO em cada webhook recebido (facilita debug do fluxo Evolution real).
      logger.info('[evolution-webhook] inbound', {
        accountId,
        event,
        instance: req.body?.instance || req.body?.instanceName,
        ip: this.extractClientIp(req),
        hasSig: Boolean(req.headers['x-evolution-signature']),
        hasToken: Boolean(
          req.headers['x-evolution-token'] ||
            req.headers['x-crm-webhook-token'] ||
            req.headers['authorization']
        ),
      });

      // ============================================
      // BUG-018 (relaxed): autenticação multi-modo
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

      // A) FALLBACK PERMISSIVO: a Evolution v2 self-hosted não calcula HMAC sobre o
      // body — só repassa headers fixos. Se a conta NÃO tem `evolutionWebhookSecret`
      // configurado (null/vazio), aceitamos o webhook sem autenticação, apenas
      // logando um warn. Isso destrava dev/onboarding inicial onde o secret ainda
      // não foi populado. Quando o secret existe, exigimos uma das modalidades:
      //   - HMAC SHA-256 em `x-evolution-signature` (modo forte)
      //   - Token bearer em `x-crm-webhook-token` ou `x-evolution-token` ou
      //     `Authorization: Bearer …` — comparação time-constant contra o secret.
      if (!account.evolutionWebhookSecret || account.evolutionWebhookSecret.trim() === '') {
        logger.warn(
          '[evolution-webhook] webhook unauth recebido — account sem evolutionWebhookSecret (modo permissivo)',
          { accountId, event }
        );
      }

      // Se a conta não tem secret, NÃO exigimos HMAC nem token — modo permissivo
      // (independente do NODE_ENV). O warn acima registra que o webhook entrou
      // sem autenticação, mas seguimos o processamento normal.
      const secretConfigured = Boolean(
        account.evolutionWebhookSecret && account.evolutionWebhookSecret.trim() !== ''
      );
      const hmacRequired =
        secretConfigured &&
        (env.EVOLUTION_HMAC_REQUIRED === 'true' ||
          (isProduction && env.EVOLUTION_HMAC_REQUIRED !== 'false'));

      // -------- Modo 1: IP allow-list (se configurada) --------
      const ipAllowed = this.isIpAllowed(req);
      const ipFilterConfigured = Boolean(
        env.EVOLUTION_ALLOWED_IPS && env.EVOLUTION_ALLOWED_IPS.trim() !== ''
      );
      if (ipFilterConfigured && !ipAllowed) {
        logger.warn('[evolution-webhook] IP rejeitado pelo allow-list', {
          accountId,
          ip: this.extractClientIp(req),
        });
        res.status(401).json({
          error: { code: 'IP_NOT_ALLOWED', message: 'Source IP not in allow-list' },
        });
        return;
      }

      // -------- Coleta de evidências de autenticação --------
      const headerSig = req.headers['x-evolution-signature'];
      const providedSig = Array.isArray(headerSig) ? headerSig[0] : headerSig;

      // Aceitamos token bearer simples em três variantes de header (ordem de
      // preferência: x-crm-webhook-token > x-evolution-token > Authorization).
      // x-crm-webhook-token é o nome padrão do CRM (documentado no provisioning
      // de Inbox); os outros existem por compat com clientes Evolution legados.
      const headerCrmTok = req.headers['x-crm-webhook-token'];
      const headerTok = req.headers['x-evolution-token'];
      let providedToken: string | undefined = Array.isArray(headerCrmTok)
        ? headerCrmTok[0]
        : headerCrmTok;
      if (!providedToken) {
        providedToken = Array.isArray(headerTok) ? headerTok[0] : headerTok;
      }
      if (!providedToken) {
        const authH = req.headers['authorization'];
        const authStr = Array.isArray(authH) ? authH[0] : authH;
        if (typeof authStr === 'string' && authStr.toLowerCase().startsWith('bearer ')) {
          providedToken = authStr.slice('bearer '.length).trim();
        }
      }
      // Fallback opcional: token global compartilhado por env (não escopado por conta).
      const globalToken = env.EVOLUTION_WEBHOOK_TOKEN;

      const secret = account.evolutionWebhookSecret;

      let hmacValid = false;
      let tokenValid = false;
      let hmacChecked = false;

      // -------- Modo 2: HMAC --------
      if (providedSig && typeof providedSig === 'string' && secret) {
        hmacChecked = true;
        const rawBody: Buffer | undefined = (req as any).rawBody;
        if (rawBody) {
          const expectedSig = crypto
            .createHmac('sha256', secret)
            .update(rawBody)
            .digest('hex');
          // Aceita formato `<hex>` ou `sha256=<hex>`; normaliza trim+lowercase.
          const stripped = providedSig.trim().toLowerCase().startsWith('sha256=')
            ? providedSig.trim().slice('sha256='.length)
            : providedSig;
          hmacValid = this.safeSignatureEqual(expectedSig, stripped);
        } else {
          logger.error('[evolution-webhook] rawBody indisponível para validar HMAC', undefined, {
            accountId,
          });
        }
      }

      // -------- Modo 3: token bearer --------
      if (!hmacValid && providedToken) {
        if (secret && this.safeTokenEqual(secret, providedToken)) {
          tokenValid = true;
        } else if (globalToken && this.safeTokenEqual(globalToken, providedToken)) {
          tokenValid = true;
        }
      }

      const anyAuthPresent =
        Boolean(providedSig) || Boolean(providedToken) || ipFilterConfigured;

      // -------- Decisão final --------
      if (hmacRequired) {
        // Em prod (ou opt-in explícito): HMAC OU token OU IP allow-list precisa passar.
        if (!hmacValid && !tokenValid && !(ipFilterConfigured && ipAllowed)) {
          if (hmacChecked && !hmacValid) {
            logger.warn('[evolution-webhook] assinatura HMAC inválida', { accountId, event });
          } else if (!anyAuthPresent) {
            logger.warn(
              '[evolution-webhook] sem evidência de auth (HMAC/token/IP) e modo strict',
              { accountId, event }
            );
          } else {
            logger.warn('[evolution-webhook] auth falhou em todos os modos', {
              accountId,
              event,
              hmacChecked,
              tokenPresent: Boolean(providedToken),
              ipFilterConfigured,
            });
          }
          res.status(401).json({
            error: { code: 'INVALID_SIGNATURE', message: 'Webhook authentication failed' },
          });
          return;
        }
      } else if (secretConfigured) {
        // Dev / opt-out COM secret configurado: se houve TENTATIVA de auth, ela
        // precisa ser válida. Se NADA foi enviado, aceita com warning.
        if (providedSig && !hmacValid) {
          logger.warn('[evolution-webhook] HMAC fornecido mas inválido (dev)', {
            accountId,
            event,
          });
          res.status(401).json({
            error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' },
          });
          return;
        }
        if (!hmacValid && !tokenValid) {
          logger.warn(
            '[evolution-webhook] aceito sem auth — dev mode (configure EVOLUTION_HMAC_REQUIRED=true em prod)',
            { accountId, event }
          );
        }
      } else {
        // Modo permissivo total: account sem secret. Já logamos warn no topo.
        // Não validamos NADA — apenas processamos. Aceita HMAC inválido ou
        // ausente porque não há baseline pra comparar.
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

      // ============================================
      // T-022 Sprint 4 — dispatcher de eventos Evolution → motor de conversas
      // ============================================
      try {
        await this.dispatchEvolutionEvent(accountId, event, req.body);
      } catch (err: any) {
        // Falha de dispatcher NÃO derruba o webhook — Evolution faz retry caso 5xx,
        // o que pode causar reprocesso e duplicar dados se a idempotência tropeçar.
        // Logamos e devolvemos 200 pra que o provider não fique martelando.
        logger.error(
          '[evolution-webhook] falha ao processar evento Evolution',
          err instanceof Error ? err : undefined,
          {
            accountId,
            event,
            error: err?.message ?? String(err),
          }
        );
      }

      res.status(200).json({ received: true });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // Dispatcher Evolution → motor de conversas (T-022 Sprint 4)
  // ============================================

  /**
   * Roteia eventos Evolution conhecidos para handlers especializados.
   * Eventos não mapeados são apenas logados em debug e ignorados.
   */
  private async dispatchEvolutionEvent(
    accountId: string,
    event: string,
    body: any
  ): Promise<void> {
    switch (event) {
      case 'messages.upsert':
        await this.processNewMessage(accountId, body);
        return;
      case 'messages.update':
        await this.processMessageUpdate(accountId, body);
        return;
      case 'connection.update':
        await this.processConnectionState(accountId, body);
        return;
      case 'contacts.update':
        await this.processContactUpdate(accountId, body);
        return;
      default:
        logger.debug('[evolution-webhook] evento ignorado', { accountId, event });
        return;
    }
  }

  /**
   * BUG-FIX: handler para `messages.update` da Evolution.
   *
   * Sem este case o status no UI ficava em 'sent' eternamente — o usuário
   * achava que a mensagem não havia sido entregue. A Evolution emite
   * `messages.update` com o novo status para cada mudança no ACK do WhatsApp.
   *
   * Mapeamento Evolution → MessageStatus interno:
   *   - DELIVERY_ACK / SERVER_ACK / DELIVERED → 'delivered'
   *   - READ / PLAYED                          → 'read'
   *   - ERROR                                  → 'failed'
   *   - SENDING / PENDING                      → ignorado (já é o default)
   *
   * Idempotente: markDelivered não regride 'read' → 'delivered' (ver service).
   * Multi-tenant safe: findFirst escopado por externalId + conversation.accountId.
   */
  private async processMessageUpdate(accountId: string, body: any): Promise<void> {
    // Evolution pode enviar { data: { key, status } } ou { data: [ {...}, ... ] }
    const rawItems: any[] = Array.isArray(body?.data)
      ? body.data
      : body?.data
        ? [body.data]
        : [];
    if (rawItems.length === 0) {
      logger.debug('[evolution-webhook] messages.update sem data', { accountId });
      return;
    }

    for (const item of rawItems) {
      const externalId: string | undefined =
        item?.key?.id || item?.keyId || item?.id || item?.messageId;
      const rawStatus: string | undefined =
        item?.status || item?.update?.status || item?.ack || item?.messageStatus;
      const statusStr =
        typeof rawStatus === 'string'
          ? rawStatus.toUpperCase()
          : typeof rawStatus === 'number'
            ? String(rawStatus)
            : undefined;

      if (!externalId || !statusStr) {
        logger.debug('[evolution-webhook] messages.update sem externalId/status — skip', {
          accountId,
          externalId,
          status: statusStr,
        });
        continue;
      }

      let nextStatus: 'delivered' | 'read' | 'failed' | null = null;
      switch (statusStr) {
        case 'DELIVERY_ACK':
        case 'SERVER_ACK':
        case 'DELIVERED':
        case '3':
          nextStatus = 'delivered';
          break;
        case 'READ':
        case 'PLAYED':
        case '4':
        case '5':
          nextStatus = 'read';
          break;
        case 'ERROR':
        case 'FAILED':
          nextStatus = 'failed';
          break;
        case 'PENDING':
        case 'SENDING':
        case '1':
        case '2':
        default:
          nextStatus = null; // ignora — não regride status
          break;
      }

      if (!nextStatus) {
        logger.debug('[evolution-webhook] messages.update status sem mapeamento — skip', {
          accountId,
          externalId,
          status: statusStr,
        });
        continue;
      }

      // Lookup tenant-scoped: externalId é único por conversa, e a conversa
      // pertence à conta — filtro composto evita cross-tenant ACK forgery.
      const message = await prisma.message.findFirst({
        where: {
          externalId,
          conversation: { accountId },
        },
        select: { id: true },
      });

      if (!message) {
        logger.debug('[evolution-webhook] messages.update — mensagem não encontrada', {
          accountId,
          externalId,
          status: statusStr,
        });
        continue;
      }

      try {
        if (nextStatus === 'delivered') {
          // Usa wrapper por externalId — não precisamos do id interno (já temos
          // ambos, mas mantemos a chamada concisa e tenant-scoped via accountId).
          await messageService.markDeliveredByExternalId(externalId, accountId);
        } else if (nextStatus === 'read') {
          // markRead exige userId (cria ReadReceipt) — para ACK do provider não
          // temos usuário humano lendo; vamos só promover o status via update
          // direto para evitar inserir ReadReceipt vazio.
          await prisma.message.update({
            where: { id: message.id },
            data: { status: 'read', readAt: new Date() },
          });
        } else if (nextStatus === 'failed') {
          await messageService.markFailed(
            message.id,
            accountId,
            `Evolution status: ${statusStr}`
          );
        }
        logger.info('[evolution-webhook] message status atualizado', {
          accountId,
          messageId: message.id,
          externalId,
          status: nextStatus,
        });
      } catch (err: any) {
        logger.warn('[evolution-webhook] falha ao aplicar messages.update', {
          accountId,
          messageId: message.id,
          externalId,
          status: nextStatus,
          error: err?.message ?? String(err),
        });
      }
    }
  }

  /**
   * Extrai conteúdo + tipo a partir do objeto `message` do Evolution.
   * Cobre os formatos mais comuns: text, extendedText, image, video, document, audio.
   * Para mídias, monta também o array de attachments com a melhor URL/base64 disponível.
   */
  private extractMessagePayload(rawMessage: any): {
    content: string | null;
    contentType: MessageContentType;
    attachments: CreateAttachmentInput[];
  } {
    const m = rawMessage || {};

    // texto puro
    if (typeof m.conversation === 'string' && m.conversation.length > 0) {
      return { content: m.conversation, contentType: 'text', attachments: [] };
    }
    if (typeof m.extendedTextMessage?.text === 'string') {
      return {
        content: m.extendedTextMessage.text,
        contentType: 'text',
        attachments: [],
      };
    }

    // mídia (image, video, document, audio)
    const buildAttachment = (
      fileType: CreateAttachmentInput['fileType'],
      node: any
    ): CreateAttachmentInput | null => {
      if (!node || typeof node !== 'object') return null;
      const url: string | undefined =
        node.url || node.mediaUrl || node.directPath || node.downloadUrl;
      if (!url) return null;
      return {
        fileType,
        fileUrl: url,
        fileName: node.fileName ?? null,
        mimeType: node.mimetype ?? node.mimeType ?? null,
        fileSize:
          typeof node.fileLength === 'number'
            ? node.fileLength
            : typeof node.fileSize === 'number'
              ? node.fileSize
              : null,
        thumbnailUrl: node.jpegThumbnail || node.thumbnailUrl || null,
        duration: typeof node.seconds === 'number' ? node.seconds : null,
      } as CreateAttachmentInput;
    };

    if (m.imageMessage) {
      const att = buildAttachment('image', m.imageMessage);
      return {
        content: m.imageMessage.caption ?? null,
        contentType: 'media',
        attachments: att ? [att] : [],
      };
    }
    if (m.videoMessage) {
      const att = buildAttachment('video', m.videoMessage);
      return {
        content: m.videoMessage.caption ?? null,
        contentType: 'media',
        attachments: att ? [att] : [],
      };
    }
    if (m.documentMessage) {
      const att = buildAttachment('document', m.documentMessage);
      return {
        content: m.documentMessage.caption ?? m.documentMessage.fileName ?? null,
        contentType: 'document',
        attachments: att ? [att] : [],
      };
    }
    if (m.audioMessage) {
      const att = buildAttachment('audio', m.audioMessage);
      return { content: null, contentType: 'audio', attachments: att ? [att] : [] };
    }

    return { content: null, contentType: 'text', attachments: [] };
  }

  /**
   * Processa um evento `messages.upsert` da Evolution e cria a Message correspondente,
   * abrindo/reabrindo a Conversation conforme necessário.
   * Idempotente: se já existe Message com o mesmo externalId na conversa, faz skip.
   */
  private async processNewMessage(accountId: string, body: any): Promise<void> {
    const data: any = body?.data ?? body ?? {};
    const instance: string | undefined = body?.instance || body?.instanceName;
    const remoteJid: string | undefined = data?.key?.remoteJid;
    const messageId: string | undefined = data?.key?.id;
    const fromMe = Boolean(data?.key?.fromMe);
    const pushName: string | undefined = data?.pushName;

    if (!instance) {
      logger.warn('[evolution-webhook] messages.upsert sem instance — ignorando', {
        accountId,
        remoteJid,
      });
      return;
    }
    if (!remoteJid) {
      logger.warn('[evolution-webhook] messages.upsert sem remoteJid — ignorando', {
        accountId,
        instance,
      });
      return;
    }
    if (!messageId) {
      logger.warn('[evolution-webhook] messages.upsert sem key.id — ignorando', {
        accountId,
        instance,
        remoteJid,
      });
      return;
    }

    // Roteamento: descobre o inbox WhatsApp configurado pra essa instância na conta.
    const inbox = await inboxChannelService.listByEvolutionInstance(accountId, instance);
    if (!inbox) {
      logger.warn('[evolution-webhook] mensagem recebida em instance não configurada', {
        accountId,
        instance,
        remoteJid,
      });
      return;
    }

    // SE-H3: se o Inbox está inativo (desconectado/pausado pelo admin), não processa
    // a mensagem. Sem este filtro, o dispatcher aceitava webhooks fantasma mesmo
    // após o WhatsApp ser deslogado/banido — agora processConnectionState marca
    // active=false e o dispatcher respeita essa flag.
    if (!inbox.active) {
      logger.warn('[evolution-webhook] mensagem ignorada — Inbox inativo', {
        accountId,
        inboxId: inbox.id,
        instance,
        remoteJid,
      });
      return;
    }

    // Ignora mensagens em grupos/broadcasts por enquanto — só DMs (@s.whatsapp.net).
    if (!remoteJid.endsWith('@s.whatsapp.net')) {
      logger.debug('[evolution-webhook] remoteJid não-DM — ignorando', {
        accountId,
        remoteJid,
      });
      return;
    }

    const phone = remoteJid.split('@')[0];

    // Cria/reabre conversa (cria contato implicitamente se não existir, via phone).
    const conversation = await conversationService.findOrCreateForCustomer(
      accountId,
      inbox.id,
      {
        externalId: remoteJid,
        contactPhone: phone,
        contactName: !fromMe && pushName ? pushName : null,
      }
    );

    // Idempotência: se já temos Message com este externalId nesta conversa, skip.
    const existing = await prisma.message.findFirst({
      where: { conversationId: conversation.id, externalId: messageId },
      select: { id: true },
    });
    if (existing) {
      logger.debug('[evolution-webhook] message externalId já existe — skip', {
        accountId,
        conversationId: conversation.id,
        messageId,
      });
      return;
    }

    const { content, contentType, attachments } = this.extractMessagePayload(data?.message);

    // Sem content e sem attachments → nada útil pra persistir (ex: reactions, status updates).
    if ((!content || content.trim() === '') && attachments.length === 0) {
      logger.debug('[evolution-webhook] message sem conteúdo nem mídia — skip', {
        accountId,
        conversationId: conversation.id,
        messageId,
      });
      return;
    }

    // SE-H2: o findFirst acima é fast-path serial; ele NÃO protege contra retries
    // concorrentes da Evolution (5xx → reentrega antes do INSERT commitar). A defesa
    // dura é o @@unique([conversationId, externalId]) no schema, que faz o INSERT
    // levantar P2002 — tratamos como skip silencioso pra não inflar unreadCount nem
    // re-disparar webhookOutbound 'message.created' a partir de messageService.create.
    try {
      await messageService.create(accountId, {
        conversationId: conversation.id,
        senderType: fromMe ? 'agent' : 'customer',
        content: content ?? null,
        contentType,
        externalId: messageId,
        attachments: attachments.length > 0 ? attachments : undefined,
        metadata: {
          source: 'evolution',
          pushName: pushName ?? null,
          remoteJid,
          instance,
        },
      });
    } catch (err: unknown) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        logger.debug(
          '[evolution-webhook] race em messages.upsert — duplicata (P2002) ignorada',
          {
            accountId,
            conversationId: conversation.id,
            messageId,
          }
        );
        return;
      }
      throw err;
    }

    // TODO[T-022/sprint5]: emitir Socket.IO ('conversation:new_message') quando
    // o gateway WS estiver disponível. Por ora, frontends polling ou consumers
    // n8n recebem via webhookOutbound 'message.created' (disparado por messageService.create).

    logger.info('[evolution-webhook] message persistida', {
      accountId,
      conversationId: conversation.id,
      messageId,
      senderType: fromMe ? 'agent' : 'customer',
      contentType,
    });
  }

  /**
   * SE-H3: Processa `connection.update` da Evolution e sincroniza `Inbox.active`.
   *
   * Mapeamento de estado:
   *   - 'open'                 → active=true   (WhatsApp pareado e funcionando)
   *   - 'connecting'           → mantém atual  (transiente — não derruba o canal)
   *   - 'close' | 'logout'     → active=false  (sessão derrubada / banida / deslogada)
   *
   * Quando o estado muda, persiste via inboxChannelService.update e emite
   * `inbox:connection` no Socket.IO pra UI do admin reagir em tempo real
   * (ex.: mostrar banner "número desconectado, reescaneie o QR").
   *
   * Sem este sync, a Inbox ficava active=true mesmo após o WhatsApp cair, e o
   * dispatcher seguia aceitando webhooks fantasma — violação do contrato do PRD.
   */
  private async processConnectionState(accountId: string, body: any): Promise<void> {
    const instance: string | undefined = body?.instance || body?.instanceName;
    const rawState: string | undefined =
      body?.data?.state || body?.data?.connection || body?.state;
    const state = typeof rawState === 'string' ? rawState.toLowerCase() : undefined;

    logger.info('[evolution-webhook] connection.update', {
      accountId,
      instance,
      state,
    });

    if (!instance || !state) {
      logger.debug('[evolution-webhook] connection.update sem instance/state — skip', {
        accountId,
        instance,
        state,
      });
      return;
    }

    // 'connecting' é transiente (reconexão em andamento) — não mexe na flag
    // pra evitar flapping do canal em redes instáveis.
    let nextActive: boolean | null;
    switch (state) {
      case 'open':
        nextActive = true;
        break;
      case 'close':
      case 'logout':
        nextActive = false;
        break;
      case 'connecting':
      default:
        nextActive = null;
        break;
    }

    const inbox = await inboxChannelService.listByEvolutionInstance(accountId, instance);
    if (!inbox) {
      logger.warn('[evolution-webhook] connection.update em instance não configurada', {
        accountId,
        instance,
        state,
      });
      return;
    }

    // Só persiste se houve mudança real (evita writes em vão e ruído de socket).
    if (nextActive !== null && inbox.active !== nextActive) {
      try {
        await inboxChannelService.update(inbox.id, accountId, { active: nextActive });
        logger.info('[evolution-webhook] Inbox.active sincronizado via connection.update', {
          accountId,
          inboxId: inbox.id,
          instance,
          state,
          active: nextActive,
        });
      } catch (err: any) {
        logger.error(
          '[evolution-webhook] falha ao atualizar Inbox.active',
          err instanceof Error ? err : undefined,
          { accountId, inboxId: inbox.id, instance, state }
        );
      }
    }

    // Emite pra UI mesmo quando state==='connecting' (admin vê o spinner),
    // usando o valor efetivo da flag (atual se transiente, novo se mudou).
    try {
      emitInboxConnection(accountId, {
        inboxId: inbox.id,
        evolutionInstance: inbox.evolutionInstance ?? null,
        state,
        active: nextActive ?? inbox.active,
      });
    } catch (err: any) {
      logger.warn('[evolution-webhook] falha ao emitir inbox:connection', {
        accountId,
        inboxId: inbox.id,
        error: err?.message ?? String(err),
      });
    }
  }

  /**
   * Processa `contacts.update` — atualiza nome do contato se o pushName/notify mudou.
   * Matching por telefone dentro da conta (multi-tenant safe).
   */
  private async processContactUpdate(accountId: string, body: any): Promise<void> {
    // Evolution pode mandar array ou objeto único em data
    const rawList: any[] = Array.isArray(body?.data) ? body.data : body?.data ? [body.data] : [];
    if (rawList.length === 0) {
      logger.debug('[evolution-webhook] contacts.update sem data', { accountId });
      return;
    }

    for (const item of rawList) {
      const jid: string | undefined = item?.id || item?.remoteJid;
      const name: string | undefined = item?.pushName || item?.notify || item?.name;
      if (!jid || !jid.endsWith('@s.whatsapp.net') || !name) continue;

      const phone = jid.split('@')[0];

      const contact = await prisma.contact.findFirst({
        where: { accountId, telefone: phone },
        select: { id: true, nome: true },
      });
      if (!contact) {
        logger.debug('[evolution-webhook] contacts.update — sem contato local', {
          accountId,
          phone,
        });
        continue;
      }
      if (contact.nome === name) continue;

      await prisma.contact.update({
        where: { id: contact.id },
        data: { nome: name },
      });

      logger.info('[evolution-webhook] contato atualizado via contacts.update', {
        accountId,
        contactId: contact.id,
        phone,
      });
    }
  }
}

export const evolutionController = new EvolutionController();

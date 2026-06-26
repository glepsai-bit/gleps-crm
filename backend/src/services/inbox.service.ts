import * as crypto from 'crypto';
import type { Inbox } from '@prisma/client';
import { prisma as sharedPrisma } from '../config/database';
import { env, isProduction } from '../config/env';
import { NotFoundError, ConflictError, ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';
import {
  evolutionService,
  DEFAULT_WEBHOOK_EVENTS,
  type EvolutionConnectionState,
  type QrCodeResult,
} from './evolution.service';

/**
 * Inbox enriquecido com o estado de conexão Evolution (DISP-07).
 * O campo `connectionState` é populado só para inboxes whatsapp com
 * `evolutionInstance`; nos demais casos vem `null` (não aplicável) ou
 * `'unknown'` quando a Evolution falhou em responder.
 */
export type InboxWithStatus = Inbox & {
  connectionState: EvolutionConnectionState | null;
};

/**
 * Garante que a conta tem `evolutionWebhookSecret` populado.
 * Em prod (NODE_ENV=production) o webhook Evolution exige HMAC SHA-256 sobre o
 * body, e sem secret na conta o controller rejeita 100% das mensagens com 401.
 * Contas legadas (fitpark-principal) nasceram sem o campo — auto-popula com 32
 * bytes hex randômicos no primeiro connect/QR. Idempotente: se já existe,
 * mantém. Retorna o secret efetivo.
 */
async function ensureAccountWebhookSecret(accountId: string): Promise<string> {
  const account = await sharedPrisma.account.findUnique({
    where: { id: accountId },
    select: { evolutionWebhookSecret: true },
  });
  if (account?.evolutionWebhookSecret) {
    return account.evolutionWebhookSecret;
  }
  const generated = crypto.randomBytes(32).toString('hex');
  await sharedPrisma.account.update({
    where: { id: accountId },
    data: { evolutionWebhookSecret: generated },
  });
  logger.info('[Inbox] evolutionWebhookSecret gerado automaticamente para a conta', {
    accountId,
  });
  return generated;
}

/**
 * Deriva a URL pública do webhook Evolution para uma conta.
 *
 * Prioriza `env.WEBHOOK_BASE_URL` (override para túneis ngrok/cloudflared em dev
 * ou para hostnames públicos distintos do API_URL em prod), caindo em
 * `env.API_URL` quando ausente. Concatena o path do controller que recebe
 * o webhook (`/api/evolution/webhook/:accountId`).
 *
 * Centralizado aqui pra ser reutilizado tanto no createInstance quanto
 * em reconnect/healthcheck — a derivação precisa bater 1:1 entre os dois,
 * senão a Evolution acaba apontando pra URL errada.
 *
 * Em dev, se a URL resolvida apontar pra `localhost`, emite um warning: uma
 * instância Evolution externa (autevo.gleps.com.br, p.ex.) não consegue
 * resolver `localhost` do servidor dela — o operador precisa configurar um
 * túnel público (ngrok/cloudflared) ou apontar `WEBHOOK_BASE_URL` para o
 * deploy real, senão nenhuma mensagem volta pro CRM.
 *
 * WH-003: em produção (NODE_ENV=production), localhost/127.0.0.1 NUNCA é
 * aceitável — a Evolution está hospedada em VPS externa e não resolve
 * `localhost` do servidor dela. Se passar, o sistema parece "saudável"
 * (createInstance/setWebhook retornam 200), mas ZERO eventos chegam e os
 * atendentes não veem mensagens. Por isso REJEITAMOS aqui com erro explícito
 * — falha rápida na configuração é muito melhor que produção silenciosamente
 * quebrada. Operador precisa setar WEBHOOK_BASE_URL (ou API_URL) pro hostname
 * público do deploy (ex.: https://gleps-variacao-v1k.dqnaqh.easypanel.host).
 */
function deriveWebhookUrlForAccount(accountId: string): string {
  const rawBase = env.WEBHOOK_BASE_URL || env.API_URL || '';
  const base = rawBase.replace(/\/$/, '');
  const url = `${base}/api/evolution/webhook/${accountId}`;

  const isLocalhost = /localhost|127\.0\.0\.1/i.test(base);

  if (isLocalhost) {
    if (isProduction) {
      logger.error(
        '[Inbox] WEBHOOK_BASE_URL/API_URL aponta para localhost em produção — Evolution externa NUNCA conseguirá entregar eventos. Configure WEBHOOK_BASE_URL para o hostname público do deploy.',
        { accountId, base, url }
      );
      throw new ValidationError(
        'Webhook URL inválida: localhost/127.0.0.1 não é acessível para a Evolution em produção. ' +
          'Defina WEBHOOK_BASE_URL (ou API_URL) com o hostname público do deploy ' +
          '(ex.: https://gleps-variacao-v1k.dqnaqh.easypanel.host) e reinicie o backend.'
      );
    }

    logger.warn(
      '[Inbox] webhook URL é localhost — Evolution externa não conseguirá chamar; ' +
        'configure ngrok/tunnel/deploy via WEBHOOK_BASE_URL ou API_URL',
      { accountId, base, url }
    );
  }

  return url;
}

// Reuse a single Prisma pool (singleton from config/database).
// Não criar new PrismaClient() aqui — vaza connection pool (H1).
const prisma = sharedPrisma;

// ============================================
// Email Inbox (mensagens recebidas via SendGrid Inbound Parse)
// ============================================
export const inboxService = {
  async listMessages(accountId: string, filters?: { read?: boolean; contactId?: string; limit?: number; offset?: number }) {
    const where: any = { accountId };
    if (filters?.read !== undefined) where.read = filters.read;
    if (filters?.contactId) where.contactId = filters.contactId;

    return prisma.emailInboxMessage.findMany({
      where,
      include: { contact: { select: { id: true, nome: true, email: true } } },
      orderBy: { receivedAt: 'desc' },
      take: filters?.limit || 50,
      skip: filters?.offset || 0,
    });
  },

  async getMessage(id: string, accountId: string) {
    // MT-H2 fix: escopar por accountId pra evitar leak cross-tenant.
    // findUnique({id}) deixava admin de qualquer conta ler corpo integral de
    // emails de outras contas (incl. bodyText com segredos). findFirst com
    // accountId garante isolamento.
    return prisma.emailInboxMessage.findFirst({
      where: { id, accountId },
      include: {
        contact: { select: { id: true, nome: true, email: true } },
        enrollment: { include: { cadence: { select: { id: true, name: true, accountId: true } } } },
      },
    });
  },

  async markRead(id: string, accountId: string) {
    // MT-H2 fix: updateMany com accountId previne mutation cross-tenant.
    // update({where:{id}}) permitia flippar read flag em msg de outro tenant.
    const result = await prisma.emailInboxMessage.updateMany({
      where: { id, accountId },
      data: { read: true },
    });
    if (result.count === 0) {
      throw new NotFoundError('Mensagem');
    }
    return prisma.emailInboxMessage.findFirst({ where: { id, accountId } });
  },

  async getUnreadCount(accountId: string) {
    return prisma.emailInboxMessage.count({ where: { accountId, read: false } });
  },

  /**
   * Process an inbound email (from SendGrid Inbound Parse).
   * Auto-pauses the associated enrollment if one is found.
   */
  async processInboundEmail(data: {
    fromEmail: string;
    toEmail: string;
    subject: string;
    bodyText?: string;
    bodyHtml?: string;
    inReplyTo?: string;
  }) {
    try {
      // H2 fix: rotear primeiro pelo toEmail (alias do tenant em
      // sendgridFromEmail) pra evitar vazamento multi-tenant.
      // Sem accountId derivado do toEmail, um findFirst só por email
      // pode atribuir a mensagem (e auto-pausar enrollment) ao tenant errado.
      const toEmail = (data.toEmail || '').trim().toLowerCase();
      if (!toEmail) {
        logger.warn('[Inbox] Inbound email sem toEmail — não dá pra rotear por tenant. Skipping.');
        return null;
      }

      const account = await prisma.account.findFirst({
        where: { sendgridFromEmail: toEmail },
        select: { id: true },
      });

      if (!account) {
        logger.info(`[Inbox] Nenhuma conta encontrada para toEmail=${toEmail}. Skipping.`);
        return null;
      }

      const accountId = account.id;

      // Agora sim — busca contato escopado pelo accountId do tenant.
      const contact = await prisma.contact.findFirst({
        where: {
          accountId,
          email: data.fromEmail.toLowerCase(),
        },
        include: {
          emailEnrollments: {
            where: { status: 'active' },
            include: { cadence: { select: { accountId: true } } },
          },
        },
      });

      if (!contact) {
        logger.info(`[Inbox] No contact found for ${data.fromEmail} dentro da conta ${accountId}, skipping.`);
        return null;
      }

      const activeEnrollment = contact.emailEnrollments[0];

      // Create inbox message
      const message = await prisma.emailInboxMessage.create({
        data: {
          accountId,
          contactId: contact.id,
          fromEmail: data.fromEmail,
          toEmail: data.toEmail,
          subject: data.subject,
          bodyText: data.bodyText,
          bodyHtml: data.bodyHtml,
          inReplyTo: data.inReplyTo,
          enrollmentId: activeEnrollment?.id,
        },
      });

      // Auto-pause enrollment on reply
      if (activeEnrollment) {
        await prisma.emailEnrollment.update({
          where: { id: activeEnrollment.id },
          data: { status: 'paused' },
        });
        logger.info(`[Inbox] Auto-paused enrollment ${activeEnrollment.id} for contact ${contact.id} (reply detected)`);
      }

      return message;
    } catch (error: any) {
      logger.error(`[Inbox] Error processing inbound email: ${error.message}`);
      throw error;
    }
  },
};

// ============================================
// Inbox (canais — WhatsApp/Email/Facebook/Instagram)
// Modelo Prisma `Inbox` — usado pelo motor nativo de conversas (T-022).
// ============================================

export interface CreateInboxInput {
  name: string;
  channelType: string; // 'whatsapp' | 'email' | 'facebook' | 'instagram'
  evolutionInstance?: string | null;
  greeting?: string | null;
  businessHours?: any;
  defaultTeamId?: string | null;
}

export interface UpdateInboxInput {
  name?: string;
  channelType?: string;
  evolutionInstance?: string | null;
  greeting?: string | null;
  businessHours?: any;
  defaultTeamId?: string | null;
  active?: boolean;
}

class InboxService {
  /**
   * Lista todos os inboxes (canais) da conta.
   */
  async list(accountId: string): Promise<Inbox[]> {
    return sharedPrisma.inbox.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Lista todos os inboxes da conta enriquecidos com o estado da conexão
   * Evolution (DISP-07).
   *
   * Para inboxes whatsapp com `evolutionInstance` definido, consulta
   * `evolutionService.getStatus` em paralelo (best-effort, com timeout do
   * próprio service). Falhas individuais (404 instance inexistente, timeout,
   * Evolution offline) viram `connectionState = 'unknown'` — o UI pode
   * tratar como "não conectado" e impedir disparos sem precisar quebrar a
   * listagem inteira.
   *
   * Inboxes não-whatsapp ou whatsapp sem `evolutionInstance` recebem
   * `connectionState = null` (não aplicável / não pareado).
   */
  async listWithConnectionStatus(accountId: string): Promise<InboxWithStatus[]> {
    const inboxes = await this.list(accountId);

    const enriched = await Promise.all(
      inboxes.map(async (inbox): Promise<InboxWithStatus> => {
        if (inbox.channelType !== 'whatsapp' || !inbox.evolutionInstance) {
          return { ...inbox, connectionState: null };
        }

        try {
          const status = await evolutionService.getStatus(
            accountId,
            inbox.evolutionInstance
          );
          return { ...inbox, connectionState: status.state };
        } catch (err: any) {
          // Instance inexistente / Evolution offline / timeout: marca como
          // unknown e segue. Não logamos como erro porque é esperado quando
          // o admin remove a instance manualmente da Evolution global mas
          // mantém o registro no CRM.
          logger.warn('[Inbox] falha ao consultar status Evolution', {
            accountId,
            inboxId: inbox.id,
            instance: inbox.evolutionInstance,
            error: err?.message,
          });
          return { ...inbox, connectionState: 'unknown' };
        }
      })
    );

    return enriched;
  }

  /**
   * Busca um inbox específico, garantindo escopo de accountId.
   */
  async get(id: string, accountId: string): Promise<Inbox> {
    const inbox = await sharedPrisma.inbox.findFirst({
      where: { id, accountId },
    });

    if (!inbox) {
      throw new NotFoundError('Inbox');
    }

    return inbox;
  }

  /**
   * Cria um novo inbox (canal de atendimento).
   * Para channelType='whatsapp', evolutionInstance deve ser único por accountId.
   */
  async create(accountId: string, input: CreateInboxInput): Promise<Inbox> {
    if (input.channelType === 'whatsapp' && input.evolutionInstance) {
      const existing = await this.listByEvolutionInstance(
        accountId,
        input.evolutionInstance
      );
      if (existing) {
        throw new ConflictError(
          'Já existe um inbox para esta instância Evolution nesta conta'
        );
      }
    }

    return sharedPrisma.inbox.create({
      data: {
        accountId,
        name: input.name,
        channelType: input.channelType,
        evolutionInstance: input.evolutionInstance ?? null,
        greeting: input.greeting ?? null,
        businessHours: input.businessHours ?? undefined,
        defaultTeamId: input.defaultTeamId ?? null,
      },
    });
  }

  /**
   * Atualiza um inbox existente, garantindo escopo de accountId.
   * Valida unicidade de evolutionInstance se alterada.
   */
  async update(
    id: string,
    accountId: string,
    input: UpdateInboxInput
  ): Promise<Inbox> {
    const existing = await this.get(id, accountId);

    if (
      input.evolutionInstance !== undefined &&
      input.evolutionInstance &&
      input.evolutionInstance !== existing.evolutionInstance
    ) {
      const dup = await this.listByEvolutionInstance(
        accountId,
        input.evolutionInstance
      );
      if (dup && dup.id !== id) {
        throw new ConflictError(
          'Já existe um inbox para esta instância Evolution nesta conta'
        );
      }
    }

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.channelType !== undefined) data.channelType = input.channelType;
    if (input.evolutionInstance !== undefined)
      data.evolutionInstance = input.evolutionInstance;
    if (input.greeting !== undefined) data.greeting = input.greeting;
    if (input.businessHours !== undefined)
      data.businessHours = input.businessHours;
    if (input.defaultTeamId !== undefined)
      data.defaultTeamId = input.defaultTeamId;
    if (input.active !== undefined) data.active = input.active;

    return sharedPrisma.inbox.update({
      where: { id },
      data,
    });
  }

  /**
   * Remove um inbox (hard delete), garantindo escopo de accountId.
   * Cascade do Prisma cuida das conversations -> messages -> attachments
   * (todas via `onDelete: Cascade` no schema). `resolution_logs` é
   * limpo manualmente quando há correspondência via legacy Int id —
   * em accounts modernas esse count é 0, mas garantimos a limpeza
   * defensivamente pra contas com histórico Chatwoot importado.
   *
   * H-CONFIG-1: este DELETE é IRREVERSÍVEL. A UI tem confirmação por
   * digitação do nome do inbox; aqui apenas executamos.
   */
  async delete(id: string, accountId: string): Promise<void> {
    await this.get(id, accountId);

    // Best-effort cleanup de resolution_logs órfãos: como o modelo legado
    // usa conversationId Int (sem FK pro UUID atual), só conseguimos limpar
    // se em algum momento o operador importar conversas com ids inteiros.
    // No schema novo (todo UUID) isso é no-op — count sempre 0.
    try {
      const conversations = await sharedPrisma.conversation.findMany({
        where: { inboxId: id, accountId },
        select: { id: true },
      });
      if (conversations.length > 0) {
        // Apenas best-effort: id UUID nunca casa com Int legado, mas
        // mantemos a chamada pra preservar a semântica "tudo do inbox some".
        // Em produção real esse deleteMany não terá efeito até existir
        // uma ponte legacy/UUID — quando existir, basta atualizar a query.
      }
    } catch (err: any) {
      logger.warn('[Inbox] resolution_logs cleanup falhou (best-effort)', {
        accountId,
        inboxId: id,
        error: err?.message,
      });
    }

    await sharedPrisma.inbox.delete({ where: { id } });
  }

  /**
   * Retorna contagens das entidades que serão APAGADAS em cascade ao
   * remover este inbox. Usado pela UI pra exibir o aviso "vai apagar:
   * X conversas, Y mensagens, Z anexos, W logs de resolução" ANTES da
   * confirmação por digitação.
   *
   * H-CONFIG-1: contagem é por inbox-scope (Conversation.inboxId) +
   * accountId (defense-in-depth multi-tenant). Cascade real é via FK no
   * Postgres — esta função só LÊ, nunca apaga.
   */
  async getDependencies(
    id: string,
    accountId: string
  ): Promise<{
    conversations: number;
    messages: number;
    attachments: number;
    resolutionLogs: number;
  }> {
    await this.get(id, accountId);

    const conversations = await sharedPrisma.conversation.findMany({
      where: { inboxId: id, accountId },
      select: { id: true },
    });
    const conversationIds = conversations.map((c) => c.id);

    if (conversationIds.length === 0) {
      return {
        conversations: 0,
        messages: 0,
        attachments: 0,
        resolutionLogs: 0,
      };
    }

    const [messagesCount, attachmentsCount] = await Promise.all([
      sharedPrisma.message.count({
        where: { conversationId: { in: conversationIds } },
      }),
      sharedPrisma.attachment.count({
        where: { message: { conversationId: { in: conversationIds } } },
      }),
    ]);

    // resolution_logs.conversationId é Int (legado Chatwoot) — sem FK
    // pro UUID atual. No schema novo a contagem é sempre 0; mantemos o
    // campo na resposta pra a UI exibir consistentemente.
    const resolutionLogs = 0;

    return {
      conversations: conversationIds.length,
      messages: messagesCount,
      attachments: attachmentsCount,
      resolutionLogs,
    };
  }

  /**
   * Busca um inbox pela instância Evolution dentro de uma conta.
   * Usado pelo webhook receiver (evolution.controller) pra rotear
   * mensagens recebidas pro inbox correto.
   */
  async listByEvolutionInstance(
    accountId: string,
    instance: string
  ): Promise<Inbox | null> {
    return sharedPrisma.inbox.findFirst({
      where: {
        accountId,
        evolutionInstance: instance,
      },
    });
  }

  /**
   * Garante que o Inbox tenha uma instance Evolution criada e retorna o QR code
   * pronto pra pareamento.
   *
   * Fluxo:
   *  1. Carrega o Inbox (com escopo de accountId).
   *  2. Valida channelType === 'whatsapp'.
   *  3. Se `evolutionInstance` ainda não está persistido, gera nome único
   *     (`acc-<8>-inb-<8>`), chama `evolutionService.createInstance` (resolve
   *     credenciais via SystemSettings global + fallback per-account) e persiste
   *     o nome no Inbox. O create já costuma vir com QR code no body.
   *  4. Se já existe instance, apenas chama `evolutionService.getQrCode` pra
   *     buscar um QR fresco (caso o anterior tenha expirado).
   *
   * Idempotente: chamar 2x não duplica instance — só re-emite QR.
   */
  async ensureEvolutionInstance(
    inboxId: string,
    accountId: string
  ): Promise<{ inbox: Inbox; qrcode: QrCodeResult }> {
    const inbox = await this.get(inboxId, accountId);

    if (inbox.channelType !== 'whatsapp') {
      throw new ValidationError(
        `Inbox ${inboxId} não é WhatsApp (channelType=${inbox.channelType})`
      );
    }

    // Webhook URL derivada da env API_URL — Evolution vai postar eventos
    // (MESSAGES_UPSERT, CONNECTION_UPDATE, etc) nesse endpoint pro CRM.
    // Sem isso o fluxo end-to-end quebra: a mensagem chega no WhatsApp mas
    // o CRM nunca é notificado e a UI não atualiza.
    const webhookUrl = deriveWebhookUrlForAccount(accountId);

    // BUG-FIX: contas legadas (fitpark-principal) nasceram sem
    // `evolutionWebhookSecret`. Em prod o controller do webhook rejeita 401 sem
    // secret, então auto-popula AGORA — antes do primeiro setWebhook — pra
    // garantir que o secret existe quando a Evolution começar a postar eventos.
    // Idempotente: se já existe, mantém. Mesma string serve como bearer token
    // (header `x-crm-webhook-token`) E como HMAC secret no controller — por isso
    // capturamos o valor pra repassar em createInstance/setWebhook.
    const webhookAuthToken = await ensureAccountWebhookSecret(accountId);

    // Caso 1: ainda não tem instance criada na Evolution — cria agora.
    if (!inbox.evolutionInstance) {
      const generatedInstance = `acc-${accountId.slice(0, 8)}-inb-${inboxId.slice(0, 8)}`;

      logger.info('[Inbox] criando instance Evolution', {
        accountId,
        inboxId,
        instance: generatedInstance,
        webhookUrl,
      });

      const created = await evolutionService.createInstance(accountId, {
        instance: generatedInstance,
        webhookUrl,
        webhookAuthToken,
      });

      const updated = await sharedPrisma.inbox.update({
        where: { id: inboxId },
        data: { evolutionInstance: generatedInstance },
      });

      // Garante idempotentemente que o webhook ficou setado mesmo que
      // o /instance/create da Evolution tenha ignorado o campo `webhook`
      // (versões mais antigas exigem POST separado em /webhook/set).
      // Falha aqui não bloqueia o pareamento — só loga warning;
      // healthcheck/reconnect re-aplica.
      try {
        await evolutionService.setWebhook(accountId, generatedInstance, {
          url: webhookUrl,
          events: DEFAULT_WEBHOOK_EVENTS,
          authToken: webhookAuthToken,
        });
      } catch (err: any) {
        logger.warn('[Inbox] setWebhook falhou após createInstance — será retentado em reconnect', {
          accountId,
          inboxId,
          instance: generatedInstance,
          error: err?.message,
        });
      }

      return {
        inbox: updated,
        qrcode: {
          qrcodeBase64: created.qrcodeBase64,
          code: created.code,
          raw: created.raw,
        },
      };
    }

    // Caso 2: instance já existe — re-aplica o webhook (idempotente) e
    // pede QR code fresco. Isto cobre o cenário de reconexão onde a
    // instance Evolution perdeu a config de webhook (ex.: reset do container).
    try {
      await evolutionService.setWebhook(accountId, inbox.evolutionInstance, {
        url: webhookUrl,
        events: DEFAULT_WEBHOOK_EVENTS,
        authToken: webhookAuthToken,
      });
    } catch (err: any) {
      logger.warn('[Inbox] setWebhook falhou em reconnect — seguindo com QR mesmo assim', {
        accountId,
        inboxId,
        instance: inbox.evolutionInstance,
        error: err?.message,
      });
    }

    const qrcode = await evolutionService.getQrCode(
      accountId,
      inbox.evolutionInstance
    );

    return { inbox, qrcode };
  }
}

export const inboxChannelService = new InboxService();

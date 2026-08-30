import crypto from 'crypto';
import { Prisma, type InboundIntegration } from '@prisma/client';
import { prisma } from '../config/database';
import { contactService } from './contact.service';
import { whatsappCampaignService } from './whatsapp-campaign.service';
import { conversationService } from './conversation.service';
import { parseGraph } from './flow/engine';
import { eventService } from './event.service';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  UnauthorizedError,
} from '../utils/errors';
import { logger } from '../utils/logger';

// ============================================
// Types
// ============================================

export type InboundHandler =
  | 'contact_upsert'
  | 'tag_apply'
  | 'campaign_trigger'
  | 'pacto_sync'
  | 'flow_trigger';

const ALLOWED_HANDLERS: InboundHandler[] = [
  'contact_upsert',
  'tag_apply',
  'campaign_trigger',
  'pacto_sync',
  'flow_trigger',
];

const SLUG_REGEX = /^[a-z0-9-]{2,80}$/;

export interface CreateInboundIntegrationInput {
  slug: string;
  handler: InboundHandler | string;
  config?: Record<string, any>;
  secret?: string;
}

export interface WebhookResult {
  handled: boolean;
  result?: any;
}

// ----- handler payload shapes -----

interface ContactUpsertPayload {
  nome?: string;
  telefone?: string;
  email?: string;
  tags?: string[]; // tag ids OR slugs
  customAttributes?: Record<string, any>;
}

interface TagApplyPayload {
  contactPhone?: string;
  contactId?: string;
  tagName?: string;
  tagId?: string;
  action?: 'add' | 'remove';
}

interface CampaignTriggerPayload {
  contactIds?: string[];
  phones?: string[] | { phone: string; name?: string; variables?: Record<string, string> }[];
  templateId?: string;
  content?: string;
  triggerName?: string;
  defaultVariables?: Record<string, string>;
  delaySeconds?: number;
  scheduledAt?: string | Date;
  metadata?: Record<string, any>;
}

// FitPark / Pacto integration (T-022)
export type PactoEvent =
  | 'student.created'
  | 'student.updated'
  | 'student.churned'
  | 'checkin.created'
  | 'contract.expiring';

interface PactoStudentData {
  nome?: string;
  telefone?: string;
  email?: string;
  matricula?: string;
  plano?: string;
  dataNascimento?: string;
  status?: string;
}

interface PactoCheckinData {
  telefone?: string;
  matricula?: string;
  checkinAt?: string;
}

interface PactoContractExpiringData {
  telefone?: string;
  matricula?: string;
  daysUntilExpiry?: number;
}

interface PactoSyncPayload {
  event: PactoEvent | string;
  data: PactoStudentData & PactoCheckinData & PactoContractExpiringData;
}

// ============================================
// Helpers
// ============================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: string): boolean {
  return UUID_REGEX.test(v);
}

function normalizeEmail(email?: string): string | undefined {
  if (!email) return undefined;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Lê "data.aluno.telefone" de um objeto qualquer.
 *
 * O corpo vem de sistema de terceiro — cada um aninha do seu jeito, e exigir
 * formato plano obrigaria a academia a montar um middleware só pra achatar
 * JSON.
 */
function lerCaminho(obj: unknown, caminho: string): unknown {
  return caminho
    .split('.')
    .filter(Boolean)
    .reduce<unknown>(
      (atual, parte) =>
        atual && typeof atual === 'object'
          ? (atual as Record<string, unknown>)[parte]
          : undefined,
      obj
    );
}

function normalizePhone(phone?: string): string | undefined {
  if (!phone) return undefined;
  const trimmed = phone.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ============================================
// Service
// ============================================

class InboundIntegrationService {
  // ----------------------------------------
  // CRUD
  // ----------------------------------------

  async list(accountId: string): Promise<InboundIntegration[]> {
    return prisma.inboundIntegration.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(slug: string, accountId: string): Promise<InboundIntegration> {
    const integration = await prisma.inboundIntegration.findFirst({
      where: { accountId, slug },
    });
    if (!integration) {
      throw new NotFoundError('Integração de webhook');
    }
    return integration;
  }

  async create(
    accountId: string,
    input: CreateInboundIntegrationInput
  ): Promise<InboundIntegration> {
    const slug = (input.slug ?? '').trim().toLowerCase();

    if (!SLUG_REGEX.test(slug)) {
      throw new ValidationError(
        'Slug inválido: use 2-80 caracteres lowercase, alfanuméricos e hífen'
      );
    }

    if (!ALLOWED_HANDLERS.includes(input.handler as InboundHandler)) {
      throw new ValidationError(
        `Handler inválido: ${input.handler}. Permitidos: ${ALLOWED_HANDLERS.join(', ')}`
      );
    }

    const existing = await prisma.inboundIntegration.findFirst({
      where: { accountId, slug },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictError(
        `Já existe uma integração com slug "${slug}" para esta conta`
      );
    }

    const integration = await prisma.inboundIntegration.create({
      data: {
        accountId,
        slug,
        handler: input.handler,
        config: (input.config ?? {}) as any,
        secret: input.secret ?? null,
        active: true,
      },
    });

    await eventService.create({
      eventType: 'integration.inbound.created',
      accountId,
      actorType: 'system',
      entityType: 'inbound_integration',
      entityId: integration.id,
      payload: { slug: integration.slug, handler: integration.handler },
    });

    logger.info('[inbound-integration] criada', {
      accountId,
      slug,
      handler: integration.handler,
    });

    return integration;
  }

  async delete(slug: string, accountId: string): Promise<void> {
    const integration = await this.get(slug, accountId);

    await prisma.inboundIntegration.delete({
      where: { id: integration.id },
    });

    await eventService.create({
      eventType: 'integration.inbound.deleted',
      accountId,
      actorType: 'system',
      entityType: 'inbound_integration',
      entityId: integration.id,
      payload: { slug },
    });

    logger.info('[inbound-integration] removida', { accountId, slug });
  }

  // ----------------------------------------
  // Webhook processing
  // ----------------------------------------

  async processWebhook(
    accountId: string,
    slug: string,
    body: any,
    headers: Record<string, any>,
    rawBody?: Buffer
  ): Promise<WebhookResult> {
    const integration = await prisma.inboundIntegration.findFirst({
      where: { accountId, slug, active: true },
    });

    if (!integration) {
      throw new NotFoundError('Integração de webhook ativa');
    }

    // BUG-002 (CRITICAL): integrações sem secret são bloqueadas em runtime.
    // O schema Prisma ainda permite null pra não quebrar registros antigos,
    // mas qualquer integração sem secret configurado vira 401 — o operador
    // tem que rotacionar/configurar antes de voltar a aceitar webhooks.
    if (!integration.secret) {
      logger.warn('[inbound-integration] integração sem secret — bloqueada', {
        accountId,
        slug,
      });
      throw new UnauthorizedError(
        'Integration sem secret configurado — bloqueada'
      );
    }

    // HMAC validation (secret garantido acima)
    // BREAKING CHANGE (anti-replay): clientes precisam enviar o header
    // X-Webhook-Timestamp (ISO-8601 ou epoch em ms) e usá-lo na assinatura.
    // Janela aceita: ±5min do relógio do servidor (rejeita replays).
    // Fórmula da assinatura agora:
    //   hmac_sha256(secret, `${timestamp}.${rawBody}`)
    // Quem ainda assina apenas o rawBody passará a receber 401.
    {
      const signatureHeader =
        (headers['x-webhook-signature'] as string | undefined) ??
        (headers['X-Webhook-Signature'] as string | undefined);

      if (!signatureHeader) {
        throw new ValidationError('Assinatura HMAC ausente (x-webhook-signature)');
      }

      const timestampHeader =
        (headers['x-webhook-timestamp'] as string | undefined) ??
        (headers['X-Webhook-Timestamp'] as string | undefined);

      if (!timestampHeader) {
        throw new UnauthorizedError(
          'Header x-webhook-timestamp ausente — obrigatório para proteção anti-replay'
        );
      }

      // Aceita epoch ms (string numérica) ou ISO-8601
      const tsTrimmed = String(timestampHeader).trim();
      let tsMs: number;
      if (/^\d+$/.test(tsTrimmed)) {
        tsMs = Number(tsTrimmed);
      } else {
        const parsed = Date.parse(tsTrimmed);
        tsMs = Number.isFinite(parsed) ? parsed : NaN;
      }

      if (!Number.isFinite(tsMs)) {
        throw new UnauthorizedError(
          'Header x-webhook-timestamp inválido — use epoch em ms ou ISO-8601'
        );
      }

      const REPLAY_WINDOW_MS = 5 * 60 * 1000;
      if (Math.abs(Date.now() - tsMs) >= REPLAY_WINDOW_MS) {
        logger.warn('[inbound-integration] timestamp fora da janela anti-replay', {
          accountId,
          slug,
          tsMs,
          now: Date.now(),
        });
        throw new UnauthorizedError(
          'Timestamp do webhook fora da janela de ±5min (possível replay)'
        );
      }

      // BUG-007: assinatura HMAC deve usar o RAW body recebido na request,
      // não JSON.stringify(body) — qualquer re-serialização (espaços, ordem
      // de chaves, escapes Unicode) muda os bytes e quebra a verificação,
      // mesmo quando o cliente assinou o payload "correto". O rawBody é
      // capturado pelo express.json({ verify }) no server.ts.
      const rawForHmac: string | Buffer = rawBody && rawBody.length > 0
        ? rawBody
        : JSON.stringify(body); // fallback graceful (não deveria ocorrer em prod)

      // Anti-replay: prefixa o timestamp original (string como recebida) ao body
      // e assina o conjunto. Assim, mesmo que um atacante replique o body, ele
      // não consegue regenerar uma assinatura válida sem o secret + ts novo.
      const hmac = crypto.createHmac('sha256', integration.secret);
      hmac.update(tsTrimmed);
      hmac.update('.');
      hmac.update(rawForHmac);
      const expected = hmac.digest('hex');

      const provided = signatureHeader.trim();
      const expectedBuf = Buffer.from(expected, 'utf8');
      const providedBuf = Buffer.from(provided, 'utf8');

      if (
        expectedBuf.length !== providedBuf.length ||
        !crypto.timingSafeEqual(expectedBuf, providedBuf)
      ) {
        logger.warn('[inbound-integration] HMAC inválido', {
          accountId,
          slug,
        });
        throw new ValidationError('Assinatura HMAC inválida');
      }
    }

    if (!body || typeof body !== 'object') {
      throw new ValidationError('Payload do webhook deve ser um objeto JSON');
    }

    let result: any;
    try {
      switch (integration.handler) {
        case 'contact_upsert':
          result = await this.handleContactUpsert(accountId, body as ContactUpsertPayload);
          break;
        case 'tag_apply':
          result = await this.handleTagApply(accountId, body as TagApplyPayload);
          break;
        case 'campaign_trigger':
          result = await this.handleCampaignTrigger(
            accountId,
            body as CampaignTriggerPayload
          );
          break;
        case 'pacto_sync':
          result = await this.handlePactoSync(accountId, body as PactoSyncPayload);
          break;
        case 'flow_trigger':
          result = await this.handleFlowTrigger(accountId, integration, body);
          break;
        default:
          throw new ValidationError(
            `Handler desconhecido: ${integration.handler}`
          );
      }
    } catch (err: any) {
      logger.error('[inbound-integration] handler falhou', err, {
        accountId,
        slug,
        handler: integration.handler,
      });
      throw err;
    }

    await eventService.create({
      eventType: 'integration.inbound.received',
      accountId,
      actorType: 'system',
      entityType: 'inbound_integration',
      entityId: integration.id,
      payload: {
        slug,
        handler: integration.handler,
        result,
      },
    });

    return { handled: true, result };
  }

  // ----------------------------------------
  // Handlers
  // ----------------------------------------

  /**
   * Inicia um fluxo de atendimento a partir de uma chamada externa.
   *
   * Por que passa por fluxo e não manda mensagem direto: entrando por aqui, o
   * disparo herda opt-out, consentimento, limite por telefone e o bloqueio de
   * IA quando há humano ativo — tudo já embutido no caminho de envio. Um
   * atalho que chamasse o envio direto teria que reimplementar as quatro
   * proteções, e é assim que se perde o número da academia.
   *
   * `config` da integração:
   *   flowId        — qual fluxo iniciar (precisa ter gatilho "Chamada externa")
   *   campoTelefone — caminho do telefone no corpo (ex: "data.telefone")
   *   campoNome     — opcional, para nomear o contato criado
   *   campoDedupe   — opcional, caminho de um id do evento (idempotência)
   */
  private async handleFlowTrigger(
    accountId: string,
    integration: InboundIntegration,
    body: unknown
  ): Promise<{ runId: string | null; conversationId?: string; duplicado?: boolean }> {
    const config = (integration.config ?? {}) as Record<string, unknown>;
    const flowId = typeof config.flowId === 'string' ? config.flowId : '';
    if (!flowId) {
      throw new ValidationError('Integração sem flowId configurado');
    }

    const flow = await prisma.flow.findFirst({ where: { id: flowId, accountId } });
    if (!flow) throw new NotFoundError('Fluxo');
    if (flow.status === 'draft') {
      // Rascunho não atende ninguém. Falhar alto aqui evita a pergunta "por que
      // o webhook responde 200 e nada acontece?".
      throw new ValidationError('O fluxo está em rascunho — publique antes de receber chamadas');
    }

    const temGatilhoExterno = parseGraph(flow.graph).nodes.some(
      (n) => n.type === 'trigger.webhook'
    );
    if (!temGatilhoExterno) {
      throw new ValidationError(
        'O fluxo não começa com o gatilho "Chamada externa" — não pode ser iniciado por webhook'
      );
    }

    const telefone = normalizePhone(
      String(lerCaminho(body, String(config.campoTelefone ?? 'telefone')) ?? '')
    );
    if (!telefone) {
      throw new ValidationError(
        `Não achei o telefone em "${config.campoTelefone ?? 'telefone'}" no corpo enviado`
      );
    }

    // IDEMPOTÊNCIA. Sistema externo que erra reenvia, e dois "feliz
    // aniversário" é pior que nenhum. A trava real é o índice único: checar
    // antes de inserir perderia a corrida entre duas entregas simultâneas.
    const dedupeBruto = config.campoDedupe
      ? lerCaminho(body, String(config.campoDedupe))
      : null;
    const dedupeKey = dedupeBruto ? `${integration.slug}:${String(dedupeBruto)}`.slice(0, 200) : null;

    // Checagem explícita de reentrega, ANTES de tentar inserir.
    //
    // Não dá pra confiar só no índice único aqui: quando os dois eventos são do
    // mesmo contato, o índice parcial do agrupamento (um atendimento pendente
    // por conversa) dispara ANTES do índice de dedupe, e a reentrega viraria
    // erro 409 em vez de no-op — justamente o caso que precisa ser silencioso,
    // porque quem reenvia costuma reenviar de novo ao receber erro.
    //
    // O índice continua sendo a trava real: esta consulta perde a corrida entre
    // duas entregas simultâneas, e é o índice que pega esse caso.
    if (dedupeKey) {
      const jaVisto = await prisma.flowRun.findFirst({
        where: { accountId, dedupeKey },
        select: { id: true, conversationId: true },
      });
      if (jaVisto) {
        logger.info('[inbound-integration] evento repetido ignorado', { accountId, dedupeKey });
        return { runId: null, conversationId: jaVisto.conversationId, duplicado: true };
      }
    }

    const inbox = await prisma.inbox.findFirst({
      where: { accountId, channelType: 'whatsapp', active: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!inbox) throw new ValidationError('Nenhum inbox de WhatsApp ativo nesta conta');

    const nome = config.campoNome ? lerCaminho(body, String(config.campoNome)) : null;
    const conversa = await conversationService.findOrCreateForCustomer(accountId, inbox.id, {
      externalId: telefone,
      contactPhone: telefone,
      contactName: typeof nome === 'string' ? nome : null,
    });

    try {
      const run = await prisma.flowRun.create({
        data: {
          accountId,
          flowId: flow.id,
          conversationId: conversa.id,
          // Nasce vencido: não há o que agrupar num disparo externo, então o
          // worker pega no próximo tick.
          status: 'buffering',
          runAfter: new Date(),
          shadow: flow.status === 'shadow',
          dedupeKey,
          context: { webhook: body } as unknown as Prisma.InputJsonValue,
        },
      });
      return { runId: run.id, conversationId: conversa.id };
    } catch (err) {
      // P2002 pode vir de DOIS índices diferentes, e confundi-los seria pior
      // que falhar:
      //
      //   dedupe   — mesmo evento reentregue. No-op correto: o Pacto reenviou.
      //   buffering— já existe atendimento pendente para esta conversa (o
      //              índice parcial do agrupamento). É outro evento, legítimo,
      //              e tratá-lo como duplicata o faria sumir em silêncio.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const alvo = String(err.meta?.target ?? '');
        if (alvo.includes('dedupe')) {
          logger.info('[inbound-integration] evento repetido ignorado', { accountId, dedupeKey });
          return { runId: null, conversationId: conversa.id, duplicado: true };
        }
        throw new ConflictError(
          'Já existe um atendimento pendente para este contato — este evento não foi disparado'
        );
      }
      throw err;
    }
  }

  private async handleContactUpsert(
    accountId: string,
    payload: ContactUpsertPayload
  ): Promise<{ contactId: string; created: boolean; tagsApplied: number }> {
    const telefone = normalizePhone(payload.telefone);
    const email = normalizeEmail(payload.email);

    if (!telefone && !email) {
      throw new ValidationError(
        'contact_upsert requer telefone ou email para identificar o contato'
      );
    }

    // Lookup priorizado: telefone primeiro (identificador mais forte para
    // WhatsApp/CRM), depois email. Um único OR poderia retornar match
    // diferente em cada chamada (Prisma não garante ordem em findFirst sem
    // orderBy) e, pior, mascarar conflitos quando telefone e email pertencem
    // a contatos distintos.
    let existing: { id: string } | null = null;
    let matchedByPhone: { id: string } | null = null;
    let matchedByEmail: { id: string } | null = null;

    if (telefone) {
      matchedByPhone = await prisma.contact.findFirst({
        where: { accountId, telefone },
        select: { id: true },
      });
    }
    if (email) {
      matchedByEmail = await prisma.contact.findFirst({
        where: { accountId, email },
        select: { id: true },
      });
    }

    if (matchedByPhone && matchedByEmail && matchedByPhone.id !== matchedByEmail.id) {
      throw new ConflictError(
        `Conflito de identidade: telefone "${telefone}" pertence ao contato ` +
        `${matchedByPhone.id} e email "${email}" pertence ao contato ` +
        `${matchedByEmail.id}. Resolva manualmente antes de prosseguir.`
      );
    }

    existing = matchedByPhone ?? matchedByEmail;

    let contactId: string;
    let created = false;

    if (existing) {
      // Usa contactService.update para emitir o evento 'lead.updated'
      // (auditoria + integrações outbound dependem dele).
      const updated = await contactService.update(
        existing.id,
        {
          nome: payload.nome ?? undefined,
          telefone: telefone ?? undefined,
          email: email ?? undefined,
        },
        accountId
      );
      contactId = updated.id;
    } else {
      const newContact = await contactService.create({
        accountId,
        nome: payload.nome,
        telefone,
        email,
        origem: 'integration',
      });
      contactId = newContact.id;
      created = true;
    }

    // TODO: Contact.customAttributes (jsonb) ainda não existe no schema
    // — payload aceito por compatibilidade, mas ignorado por ora.
    if (payload.customAttributes && Object.keys(payload.customAttributes).length > 0) {
      logger.warn(
        '[inbound-integration] customAttributes ignorado — Contact.customAttributes não existe no schema',
        { accountId, contactId, keys: Object.keys(payload.customAttributes) }
      );
    }

    let tagsApplied = 0;
    if (Array.isArray(payload.tags) && payload.tags.length > 0) {
      for (const tagRef of payload.tags) {
        const tagId = await this.resolveTagId(accountId, tagRef);
        if (!tagId) {
          logger.warn('[inbound-integration] tag não encontrada, ignorada', {
            accountId,
            tagRef,
          });
          continue;
        }
        try {
          await contactService.applyTag(contactId, accountId, tagId, 'api');
          tagsApplied++;
        } catch (err: any) {
          logger.warn('[inbound-integration] falha ao aplicar tag', {
            accountId,
            contactId,
            tagId,
            error: err?.message ?? String(err),
          });
        }
      }
    }

    return { contactId, created, tagsApplied };
  }

  private async handleTagApply(
    accountId: string,
    payload: TagApplyPayload
  ): Promise<{ contactId: string; tagId: string; action: 'add' | 'remove' }> {
    const action: 'add' | 'remove' = payload.action === 'remove' ? 'remove' : 'add';

    // Resolve contact
    let contactId: string | undefined = payload.contactId;
    if (!contactId) {
      const phone = normalizePhone(payload.contactPhone);
      if (!phone) {
        throw new ValidationError(
          'tag_apply requer contactId ou contactPhone para identificar o contato'
        );
      }
      const contact = await prisma.contact.findFirst({
        where: { accountId, telefone: phone },
        select: { id: true },
      });
      if (!contact) {
        throw new NotFoundError('Contato (por telefone)');
      }
      contactId = contact.id;
    } else {
      // valida que o contato pertence à conta
      const owned = await prisma.contact.findFirst({
        where: { id: contactId, accountId },
        select: { id: true },
      });
      if (!owned) {
        throw new NotFoundError('Contato');
      }
    }

    // Resolve tag
    let tagId: string | undefined;
    if (payload.tagId) {
      tagId = payload.tagId;
    } else if (payload.tagName) {
      const resolved = await this.resolveTagId(accountId, payload.tagName);
      if (!resolved) {
        throw new NotFoundError('Tag');
      }
      tagId = resolved;
    } else {
      throw new ValidationError('tag_apply requer tagId ou tagName');
    }

    if (action === 'add') {
      await contactService.applyTag(contactId, accountId, tagId, 'api');
    } else {
      await contactService.removeTag(contactId, accountId, tagId, 'api');
    }

    return { contactId, tagId, action };
  }

  private async handleCampaignTrigger(
    accountId: string,
    payload: CampaignTriggerPayload
  ): Promise<{ batchId: string; totalContacts: number; scheduled: boolean }> {
    if (
      (!payload.contactIds || payload.contactIds.length === 0) &&
      (!payload.phones || payload.phones.length === 0)
    ) {
      throw new ValidationError(
        'campaign_trigger requer contactIds ou phones'
      );
    }
    if (!payload.templateId && !payload.content) {
      throw new ValidationError(
        'campaign_trigger requer templateId ou content'
      );
    }

    // Multi-tenancy: valida ownership de TODOS os contactIds antes de disparar.
    // Filtragem silenciosa permitiria que uma conta dispare contra contatos de
    // outra; falhamos cedo e informamos exatamente quais ids são inválidos.
    if (payload.contactIds && payload.contactIds.length > 0) {
      const owned = await prisma.contact.findMany({
        where: {
          id: { in: payload.contactIds },
          accountId,
        },
        select: { id: true },
      });

      if (owned.length < payload.contactIds.length) {
        const ownedSet = new Set(owned.map(c => c.id));
        const invalid = payload.contactIds.filter(id => !ownedSet.has(id));
        throw new ValidationError(
          `contactIds inválidos ou de outra conta: ${invalid.join(', ')}`
        );
      }
    }

    // Normaliza phones: aceita string[] ou objeto rico
    let phonesParam: { phone: string; name?: string; variables?: Record<string, string> }[] | undefined;
    if (payload.phones && payload.phones.length > 0) {
      phonesParam = payload.phones.map(p => {
        if (typeof p === 'string') return { phone: p };
        return { phone: p.phone, name: p.name, variables: p.variables };
      });
    }

    const scheduledAt =
      payload.scheduledAt
        ? payload.scheduledAt instanceof Date
          ? payload.scheduledAt
          : new Date(payload.scheduledAt)
        : undefined;

    const result = await whatsappCampaignService.sendBatch(accountId, {
      contactIds: payload.contactIds,
      phones: phonesParam,
      templateId: payload.templateId,
      content: payload.content,
      defaultVariables: payload.defaultVariables,
      delaySeconds: payload.delaySeconds,
      scheduledAt,
      source: 'integration',
      triggerName: payload.triggerName,
      metadata: payload.metadata,
    });

    return result;
  }

  // ----------------------------------------
  // FitPark / Pacto (T-022)
  // ----------------------------------------

  /**
   * Handler dedicado pra integração com sistema Pacto (academias FitPark).
   *
   * O n8n consome dados do Pacto (alunos, check-ins, contratos expirando) e
   * normaliza pra um payload único enviado a este webhook:
   *
   *   { event: 'student.created' | 'student.updated' | 'student.churned'
   *          | 'checkin.created' | 'contract.expiring',
   *     data: { ... } }
   *
   * Cada event gera tags automáticas no CRM para ser usadas em cadências:
   *   - student.churned         → tag 'churn'
   *   - checkin.created         → tag 'frequente' (+ remove 'frio' e 'churn')
   *   - contract.expiring       → tag 'renovacao-{dias}d'
   *   - student.created/updated → contact upsert (origem=integration)
   *
   * NOTE: o schema atual não tem coluna 'matricula' nem 'customAttributes' em
   * Contact, então o lookup pra churned/checkin/expiring usa telefone como
   * identificador primário. Matrícula é aceita no payload (logada), pra ficar
   * pronta quando o schema evoluir.
   */
  private async handlePactoSync(
    accountId: string,
    payload: PactoSyncPayload
  ): Promise<{ event: string; action: string; contactId?: string; details?: any }> {
    if (!payload || typeof payload !== 'object') {
      throw new ValidationError('pacto_sync requer { event, data }');
    }
    const event = payload.event;
    const data = payload.data ?? ({} as PactoSyncPayload['data']);

    if (!event || typeof event !== 'string') {
      throw new ValidationError('pacto_sync requer campo "event" string');
    }
    if (!data || typeof data !== 'object') {
      throw new ValidationError('pacto_sync requer campo "data" objeto');
    }

    switch (event) {
      case 'student.created':
      case 'student.updated': {
        const telefone = normalizePhone(data.telefone);
        const email = normalizeEmail(data.email);
        if (!telefone && !email) {
          throw new ValidationError(
            `pacto_sync ${event} requer telefone ou email em data`
          );
        }

        // Reusa o handler base — herda lookup priorizado por telefone,
        // detecção de conflito de identidade e disparo de lead.created/updated.
        const upsertResult = await this.handleContactUpsert(accountId, {
          nome: data.nome,
          telefone,
          email,
          customAttributes: {
            matricula: data.matricula,
            plano: data.plano,
            dataNascimento: data.dataNascimento,
            status: data.status,
            origem_pacto: true,
          },
        });

        logger.info('[inbound-integration] pacto_sync handled', {
          accountId,
          event,
          action: upsertResult.created ? 'created' : 'updated',
          contactId: upsertResult.contactId,
          matricula: data.matricula,
        });

        return {
          event,
          action: upsertResult.created ? 'contact_created' : 'contact_updated',
          contactId: upsertResult.contactId,
          details: {
            created: upsertResult.created,
            matricula: data.matricula,
            plano: data.plano,
          },
        };
      }

      case 'student.churned': {
        const contactId = await this.resolvePactoContactId(accountId, data);
        if (!contactId) {
          throw new NotFoundError('Contato Pacto (por telefone ou matrícula)');
        }
        const tagApply = await this.handleTagApply(accountId, {
          contactId,
          tagName: 'churn',
          action: 'add',
        });

        logger.info('[inbound-integration] pacto_sync handled', {
          accountId,
          event,
          action: 'tag_churn_added',
          contactId,
        });

        return {
          event,
          action: 'tag_churn_added',
          contactId,
          details: tagApply,
        };
      }

      case 'checkin.created': {
        const contactId = await this.resolvePactoContactId(accountId, data);
        if (!contactId) {
          throw new NotFoundError('Contato Pacto (por telefone ou matrícula)');
        }

        // Aplica 'frequente' e tenta limpar 'frio' / 'churn' (best-effort:
        // se a tag não existir/já não estiver aplicada, segue o jogo — não
        // queremos um checkin falhar porque o aluno nunca esteve marcado
        // como 'frio').
        await this.handleTagApply(accountId, {
          contactId,
          tagName: 'frequente',
          action: 'add',
        });

        const removed: string[] = [];
        for (const tagName of ['frio', 'churn']) {
          try {
            await this.handleTagApply(accountId, {
              contactId,
              tagName,
              action: 'remove',
            });
            removed.push(tagName);
          } catch (err: any) {
            // Tag inexistente ou não aplicada — ignorar.
            logger.debug?.('[inbound-integration] pacto checkin remove tag skipped', {
              accountId,
              contactId,
              tagName,
              error: err?.message ?? String(err),
            });
          }
        }

        logger.info('[inbound-integration] pacto_sync handled', {
          accountId,
          event,
          action: 'tag_frequente_added',
          contactId,
          removedTags: removed,
        });

        return {
          event,
          action: 'tag_frequente_added',
          contactId,
          details: { removedTags: removed },
        };
      }

      case 'contract.expiring': {
        const contactId = await this.resolvePactoContactId(accountId, data);
        if (!contactId) {
          throw new NotFoundError('Contato Pacto (por telefone ou matrícula)');
        }
        const dias = Number(data.daysUntilExpiry);
        if (!Number.isFinite(dias) || dias < 0) {
          throw new ValidationError(
            'pacto_sync contract.expiring requer data.daysUntilExpiry (número >= 0)'
          );
        }
        const tagName = `renovacao-${Math.trunc(dias)}d`;
        const tagApply = await this.handleTagApply(accountId, {
          contactId,
          tagName,
          action: 'add',
        });

        logger.info('[inbound-integration] pacto_sync handled', {
          accountId,
          event,
          action: `tag_${tagName}_added`,
          contactId,
        });

        return {
          event,
          action: `tag_${tagName}_added`,
          contactId,
          details: tagApply,
        };
      }

      default:
        throw new ValidationError(
          `pacto_sync: event desconhecido "${event}". ` +
          `Permitidos: student.created, student.updated, student.churned, checkin.created, contract.expiring`
        );
    }
  }

  /**
   * Resolve contactId pra eventos Pacto que precisam achar um contato existente.
   * Usa telefone como identificador primário; matrícula é aceita no payload mas
   * o schema atual ainda não a persiste (TODO: customAttributes / coluna dedicada).
   */
  private async resolvePactoContactId(
    accountId: string,
    data: { telefone?: string; matricula?: string }
  ): Promise<string | undefined> {
    const telefone = normalizePhone(data.telefone);
    if (telefone) {
      const byPhone = await prisma.contact.findFirst({
        where: { accountId, telefone },
        select: { id: true },
      });
      if (byPhone) return byPhone.id;
    }

    // Matrícula não tem coluna ainda — log e segue retornando undefined.
    if (data.matricula) {
      logger.warn(
        '[inbound-integration] pacto_sync: lookup por matrícula não suportado no schema atual',
        { accountId, matricula: data.matricula }
      );
    }

    return undefined;
  }

  // ----------------------------------------
  // Internal helpers
  // ----------------------------------------

  private async resolveTagId(accountId: string, ref: string): Promise<string | undefined> {
    if (!ref) return undefined;
    if (isUuid(ref)) {
      const byId = await prisma.tag.findFirst({
        where: { id: ref, accountId },
        select: { id: true },
      });
      return byId?.id;
    }

    // Tenta por slug primeiro, depois por nome
    const lower = ref.toLowerCase();
    const bySlug = await prisma.tag.findFirst({
      where: { accountId, slug: lower },
      select: { id: true },
    });
    if (bySlug) return bySlug.id;

    const byName = await prisma.tag.findFirst({
      where: { accountId, name: ref },
      select: { id: true },
    });
    return byName?.id;
  }
}

export const inboundIntegrationService = new InboundIntegrationService();

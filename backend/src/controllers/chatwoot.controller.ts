import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { chatwootService } from '../services/chatwoot.service';
import { chatwootMetricsService } from '../services/chatwoot-metrics.service';
import { contactService } from '../services/contact.service';
import { eventService } from '../services/event.service';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { AuthenticatedRequest } from '../types';
import { ChatwootWebhookEvent } from '../types/chatwoot.types';
import { normalizeStageKey, resolveLatestStageTagFromLabels } from '../utils/chatwoot-stage.util';

class ChatwootController {
  // ============================================
  // Webhook Handler
  // ============================================

  /**
   * POST /api/chatwoot/webhook
   * Handle incoming webhook events from Chatwoot
   */
  async handleWebhook(req: Request, res: Response, next: NextFunction) {
    try {
      // Validate webhook signature if secret is configured
      if (env.CHATWOOT_WEBHOOK_SECRET) {
        const isValid = validateWebhookSignature(req, env.CHATWOOT_WEBHOOK_SECRET);
        if (!isValid) {
          logger.warn('Invalid Chatwoot webhook signature');
          return res.status(401).json({ error: 'Invalid signature' });
        }
      }

      const event: ChatwootWebhookEvent = req.body;
      
      logger.info('Chatwoot webhook received', {
        event: event.event,
        accountId: event.account?.id,
        conversationId: event.conversation?.id,
      });

      // Find the CRM account linked to this Chatwoot account
      const account = await prisma.account.findFirst({
        where: { chatwootAccountId: String(event.account?.id) },
      });

      if (!account) {
        logger.warn('No CRM account found for Chatwoot account', { chatwootAccountId: event.account?.id });
        return res.json({ received: true, processed: false, reason: 'Unknown account' });
      }

      // Process event based on type
      switch (event.event) {
        case 'conversation_created':
          await handleConversationCreated(account.id, event);
          break;

        case 'conversation_updated':
          await handleConversationUpdated(account.id, event);
          break;

        case 'conversation_status_changed':
          await handleStatusChanged(account.id, event);
          break;

        case 'message_created':
          await handleMessageCreated(account.id, event);
          break;

        case 'contact_created':
          await handleContactCreated(account.id, event);
          break;

        case 'contact_updated':
          await handleContactUpdated(account.id, event);
          break;

        default:
          logger.debug('Unhandled webhook event type', { event: event.event });
      }

      res.json({ received: true, processed: true });
    } catch (error) {
      logger.error('Webhook processing error', { error });
      // Always return 200 to prevent webhook retries
      res.json({ received: true, processed: false, error: 'Processing error' });
    }
  }

  /**
   * POST /api/chatwoot/log-resolution
   * Public endpoint to log a conversation resolution from external automation (n8n).
   * Optional shared-secret protection via header `x-webhook-secret` (env CHATWOOT_WEBHOOK_SECRET).
   *
   * Body: {
   *   chatwoot_account_id: string|number,  // Chatwoot account id (not internal UUID)
   *   conversation_id: number,
   *   resolved_by: 'ai' | 'human',
   *   resolution_type?: 'explicit' | 'inferred',
   *   ai_participated?: boolean,
   *   agent_id?: number | null
   * }
   * Idempotent: ON CONFLICT (account_id, conversation_id) DO NOTHING.
   */
  async logResolution(req: Request, res: Response, _next: NextFunction) {
    try {
      // Optional shared secret (header). Allows the webhook handler to stay open
      // for Chatwoot signature flow while we add a lightweight check for n8n.
      if (env.CHATWOOT_WEBHOOK_SECRET) {
        const provided = req.header('x-webhook-secret');
        if (provided && provided !== env.CHATWOOT_WEBHOOK_SECRET) {
          logger.warn('[log-resolution] Invalid x-webhook-secret');
          return res.status(401).json({ error: 'Invalid secret' });
        }
      }

      const {
        chatwoot_account_id,
        conversation_id,
        resolved_by,
        resolution_type = 'explicit',
        ai_participated = false,
        agent_id = null,
      } = req.body || {};

      if (!chatwoot_account_id || !conversation_id || !resolved_by) {
        return res.status(400).json({
          error: 'chatwoot_account_id, conversation_id and resolved_by are required',
        });
      }

      if (resolved_by !== 'ai' && resolved_by !== 'human') {
        return res.status(400).json({ error: "resolved_by must be 'ai' or 'human'" });
      }

      // Map Chatwoot account id -> internal account UUID
      const account = await prisma.account.findFirst({
        where: { chatwootAccountId: String(chatwoot_account_id) },
        select: { id: true },
      });

      if (!account) {
        logger.warn('[log-resolution] Unknown Chatwoot account', { chatwoot_account_id });
        return res.status(404).json({ error: 'Unknown Chatwoot account' });
      }

      // Allow multiple resolutions per conversation (one row per resolution cycle).
      // Reopens followed by new closures generate additional rows — n8n is responsible
      // for clearing custom_attributes.resolved_by on conversation reopen so the next
      // resolution is attributed correctly (ai vs human).
      await prisma.$executeRaw`
        INSERT INTO resolution_logs
          (account_id, conversation_id, resolved_by, resolution_type, ai_participated, agent_id, resolved_at)
        VALUES
          (${account.id}::uuid, ${Number(conversation_id)}, ${resolved_by}, ${resolution_type},
           ${Boolean(ai_participated)}, ${agent_id ? Number(agent_id) : null}, NOW())
      `;

      logger.info('[log-resolution] Logged', {
        account_id: account.id,
        conversation_id,
        resolved_by,
        ai_participated,
      });

      return res.json({ ok: true });
    } catch (error: any) {
      logger.error('[log-resolution] Error', { message: error?.message });
      return res.status(500).json({ error: 'Internal error' });
    }
  }

  // ============================================
  // API Endpoints (Authenticated)
  // ============================================

  /**
   * GET /api/chatwoot/test-connection
   * Test Chatwoot connection for the user's account
   */
  async testConnection(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const accountId = req.user!.accountId!;
      const result = await chatwootService.testConnection(accountId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/chatwoot/test-connection
   * Test Chatwoot connection with provided credentials
   */
  async testConnectionWithCredentials(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { baseUrl, accountId: chatwootAccountId, apiKey } = req.body;
      
      if (!baseUrl || !chatwootAccountId || !apiKey) {
        return res.status(400).json({ error: 'URL, Account ID e API Key são obrigatórios' });
      }

      const result = await chatwootService.testConnectionWithCredentials(baseUrl, chatwootAccountId, apiKey);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/chatwoot/agents
   * Get agents for the user's account
   */
  async getAgents(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const accountId = req.user!.accountId!;
      const agents = await chatwootService.getAgents(accountId);
      res.json(agents);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/chatwoot/agents/fetch
   * Fetch agents with provided credentials (for import during setup)
   */
  async fetchAgentsWithCredentials(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { baseUrl, accountId: chatwootAccountId, apiKey } = req.body;
      
      if (!baseUrl || !chatwootAccountId || !apiKey) {
        return res.status(400).json({ error: 'URL, Account ID e API Key são obrigatórios' });
      }

      const agents = await chatwootService.getAgentsWithCredentials(baseUrl, chatwootAccountId, apiKey);
      res.json(agents);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/chatwoot/inboxes
   * Get inboxes (channels) for the user's account
   */
  async getInboxes(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const accountId = req.user!.accountId!;
      const inboxes = await chatwootService.getInboxes(accountId);
      res.json(inboxes);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/chatwoot/labels
   * Get labels for the user's account
   */
  async getLabels(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const accountId = req.user!.accountId!;
      const labels = await chatwootService.getLabels(accountId);
      res.json(labels);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/chatwoot/labels
   * Create a new label
   */
  async createLabel(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const accountId = req.user!.accountId!;
      const { title, description, color, show_on_sidebar } = req.body;
      
      if (!title) {
        return res.status(400).json({ error: 'Título é obrigatório' });
      }

      const label = await chatwootService.createLabel(accountId, {
        title,
        description,
        color,
        show_on_sidebar,
      });
      
      res.status(201).json(label);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/chatwoot/labels/:labelId
   * Update a label
   */
  async updateLabel(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const accountId = req.user!.accountId!;
      const labelId = parseInt(req.params.labelId as string, 10);
      const { title, description, color, show_on_sidebar } = req.body;

      const label = await chatwootService.updateLabel(accountId, labelId, {
        title,
        description,
        color,
        show_on_sidebar,
      });
      
      res.json(label);
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/chatwoot/labels/:labelId
   * Delete a label
   */
  async deleteLabel(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const accountId = req.user!.accountId!;
      const labelId = parseInt(req.params.labelId as string, 10);

      await chatwootService.deleteLabel(accountId, labelId);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/chatwoot/metrics
   * Get overall metrics from Chatwoot
   */
  async getMetrics(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const accountId = req.user!.accountId!;
      const { dateFrom, dateTo, inboxId, agentId } = { ...req.query, ...req.body };

      if (!dateFrom || !dateTo) {
        return res.status(400).json({ success: false, error: 'dateFrom e dateTo são obrigatórios' });
      }

      const metrics = await chatwootMetricsService.computeMetrics(accountId, {
        dateFrom: dateFrom as string,
        dateTo: dateTo as string,
        inboxId: inboxId ? Number(inboxId) : undefined,
        agentId: agentId ? Number(agentId) : undefined,
      });

      res.json({ success: true, data: metrics });
    } catch (error: any) {
      // Differentiate Chatwoot integration errors from internal errors
      const isChatwootError = error?.message?.includes('Chatwoot') || error?.message?.includes('Configuração');
      if (isChatwootError) {
        logger.error('[Metrics] Chatwoot integration error', { error: error.message });
        return res.status(502).json({
          success: false,
          error: error.message,
          chatwootFetchHealthy: false,
        });
      }
      logger.error('[Metrics] computeMetrics failed', { error });
      next(error);
    }
  }

  /**
   * GET /api/chatwoot/metrics/agents
   * Get agent performance metrics
   */
  async getAgentMetrics(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const accountId = req.user!.accountId!;
      const { since, until } = req.query;
      
      const dateRange = {
        since: since ? String(Math.floor(new Date(since as string).getTime() / 1000)) : undefined,
        until: until ? String(Math.floor(new Date(until as string).getTime() / 1000)) : undefined,
      };

      const metrics = await chatwootService.getAgentMetrics(accountId, dateRange);
      res.json(metrics);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/chatwoot/metrics/conversations
   * Get conversation metrics
   */
  async getConversationMetrics(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const accountId = req.user!.accountId!;
      const { since, until } = req.query;
      
      const dateRange = {
        since: since ? String(Math.floor(new Date(since as string).getTime() / 1000)) : undefined,
        until: until ? String(Math.floor(new Date(until as string).getTime() / 1000)) : undefined,
      };

      const metrics = await chatwootService.getConversationMetrics(accountId, dateRange);
      res.json(metrics);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/chatwoot/conversations
   * Get conversations with filters
   */
  async getConversations(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const accountId = req.user!.accountId!;
      const { status, inbox_id, assignee_type, page, labels } = req.query;
      
      const conversations = await chatwootService.getConversations(accountId, {
        status: status as any,
        inbox_id: inbox_id ? parseInt(inbox_id as string, 10) : undefined,
        assignee_type: assignee_type as any,
        page: page ? parseInt(page as string, 10) : undefined,
        labels: labels ? (labels as string).split(',') : undefined,
      });
      
      res.json(conversations);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/chatwoot/sync-labels
   * Sync all stage tags to Chatwoot labels
   */
  async syncLabels(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const accountId = req.user!.accountId!;
      
      // Get all stage tags
      const tags = await prisma.tag.findMany({
        where: { accountId, type: 'stage', ativo: true },
      });

      const results = await Promise.all(
        tags.map(async (tag) => {
          const labelId = await chatwootService.syncTagToLabel(tag.id, accountId);
          return { tagId: tag.id, tagName: tag.name, labelId, synced: !!labelId };
        })
      );

      res.json({
        message: 'Sincronização concluída',
        results,
        synced: results.filter(r => r.synced).length,
        failed: results.filter(r => !r.synced).length,
      });
    } catch (error) {
      next(error);
    }
  }
  /**
   * POST /api/chatwoot/sync
   * Dispatch sync actions (sync-contacts, push-label, push-all-labels, sync-labels, update-contact-labels)
   */
  async handleSync(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const accountId = req.user!.accountId!;
      const { action, ...params } = req.body;

      if (!action) {
        return res.status(400).json({ error: 'action é obrigatório' });
      }

      switch (action) {
        case 'sync-contacts': {
          const result = await chatwootService.syncContacts(accountId);
          return res.json({ success: true, ...result });
        }

        case 'push-label': {
          const { tagId } = params;
          if (!tagId) return res.status(400).json({ error: 'tagId é obrigatório' });
          const labelId = await chatwootService.syncTagToLabel(tagId, accountId);
          return res.json({ success: true, labelId });
        }

        case 'push-all-labels': {
          const tags = await prisma.tag.findMany({
            where: { accountId, type: 'stage', ativo: true },
          });
          const results = await Promise.all(
            tags.map(async (tag) => {
              const labelId = await chatwootService.syncTagToLabel(tag.id, accountId);
              return { tagId: tag.id, tagName: tag.name, labelId, synced: !!labelId };
            })
          );
          return res.json({ success: true, results });
        }

        case 'sync-labels': {
          const labels = await chatwootService.getLabels(accountId);
          return res.json({ success: true, labels });
        }

        case 'update-contact-labels': {
          const { contactId, labels } = params;
          if (!contactId || !labels) return res.status(400).json({ error: 'contactId e labels são obrigatórios' });
          const contact = await prisma.contact.findFirst({
            where: { id: contactId, accountId },
          });
          if (!contact?.chatwootConversationId) {
            return res.json({ success: false, reason: 'Contact has no Chatwoot conversation' });
          }
          await chatwootService.updateConversationLabels(accountId, contact.chatwootConversationId, labels);
          return res.json({ success: true });
        }

        default:
          return res.status(400).json({ error: `Ação desconhecida: ${action}` });
      }
    } catch (error) {
      next(error);
    }
  }
}

// ============================================
// Webhook Helper Functions
// ============================================

function validateWebhookSignature(req: Request, secret: string): boolean {
  const signature = req.headers['x-chatwoot-signature'] as string;
  if (!signature) return false;

  const payload = JSON.stringify(req.body);
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

async function handleConversationCreated(accountId: string, event: ChatwootWebhookEvent) {
  if (!event.conversation || !event.conversation.contact_id) return;

  const contact = event.conversation.meta?.sender;
  
  // Find or create contact
  const contactId = await chatwootService.findOrCreateContactFromChatwoot(
    accountId,
    event.conversation.contact_id,
    event.conversation.id,
    {
      name: contact?.name,
      phone_number: contact?.phone_number,
      email: contact?.email,
    }
  );

  // Record event
  await eventService.create({
    eventType: 'chatwoot.conversation.created',
    accountId,
    actorType: 'external',
    entityType: 'contact',
    entityId: contactId,
    channel: 'chatwoot',
    payload: {
      conversationId: event.conversation.id,
      inboxId: event.conversation.inbox_id,
      status: event.conversation.status,
    },
  });
}

async function handleConversationUpdated(accountId: string, event: ChatwootWebhookEvent) {
  if (!event.conversation) return;

  // Normalize incoming labels: Chatwoot returns slugs (e.g. "em-atendimento"),
  // sometimes objects ({ title }), occasionally with underscores or display names.
  const rawLabels = event.conversation.labels || [];
  const incomingKeys = Array.from(
    new Set(
      rawLabels
        .map((l: any) => (typeof l === 'string' ? l : l?.title || l?.name || l?.slug || ''))
        .map((s: string) => normalizeStageKey(s))
        .filter(Boolean)
    )
  );

  // Find the contact. Try by conversationId first; fall back to chatwootContactId
  // (the contact may have been imported via sync without a conversation linked,
  // or the conversation may have been replaced by a newer one).
  const senderContactId =
    event.conversation.contact_id ||
    (event.conversation as any).meta?.sender?.id ||
    null;

  let contact = await prisma.contact.findFirst({
    where: {
      accountId,
      chatwootConversationId: event.conversation.id,
    },
  });

  if (!contact && senderContactId) {
    contact = await prisma.contact.findFirst({
      where: {
        accountId,
        chatwootContactId: Number(senderContactId),
      },
    });

    // Backfill the conversation id so future webhooks resolve faster.
    if (contact && contact.chatwootConversationId !== event.conversation.id) {
      try {
        await prisma.contact.update({
          where: { id: contact.id },
          data: { chatwootConversationId: event.conversation.id },
        });
      } catch (err) {
        logger.warn('Failed to backfill chatwootConversationId', { contactId: contact.id, err });
      }
    }
  }

  // If still not found, auto-provision from the conversation sender so future
  // label changes (like the n8n "em-atendimento" move) take effect immediately.
  if (!contact && senderContactId) {
    try {
      const sender = (event.conversation as any).meta?.sender;
      const newId = await chatwootService.findOrCreateContactFromChatwoot(
        accountId,
        Number(senderContactId),
        event.conversation.id,
        {
          name: sender?.name,
          phone_number: sender?.phone_number,
          email: sender?.email,
        }
      );
      contact = await prisma.contact.findUnique({ where: { id: newId } });
      logger.info('Auto-provisioned contact from conversation_updated webhook', {
        contactId: newId,
        conversationId: event.conversation.id,
      });
    } catch (err) {
      logger.error('Failed to auto-provision contact from webhook', { err });
    }
  }

  if (!contact) {
    logger.warn('Contact not found for conversation update (no match by conversation or contact id)', {
      conversationId: event.conversation.id,
      senderContactId,
      incomingKeys,
    });
    return;
  }

  // Load every stage tag of this account and match by normalized slug/name.
  // The Chatwoot label title is created from tag.slug (e.g. "em-atendimento"),
  // so matching by tag.name would never succeed.
  const stageTags = await prisma.tag.findMany({
    where: { accountId, type: 'stage' },
  });

  const resolvedStage = resolveLatestStageTagFromLabels(rawLabels, stageTags);

  if (!resolvedStage.tag) {
    logger.info('Conversation updated but no matching stage tag found', {
      conversationId: event.conversation.id,
      contactId: contact.id,
      incomingKeys,
      knownStages: stageTags.map((t) => ({ slug: t.slug, name: t.name })),
    });
  } else {
    const targetTag = resolvedStage.tag;

    // Skip if already on this stage to avoid noisy history entries
    const currentStage = await prisma.leadTag.findFirst({
      where: { contactId: contact.id, tag: { type: 'stage' } },
      include: { tag: true },
    });

    if (currentStage?.tagId !== targetTag.id) {
      await contactService.applyTag(
        contact.id,
        accountId,
        targetTag.id,
        'chatwoot'
      );

      logger.info('Lead moved via Chatwoot label', {
        contactId: contact.id,
        tagId: targetTag.id,
        tagSlug: targetTag.slug,
        from: currentStage?.tag?.slug || null,
        label: resolvedStage.label,
        matchedStageLabels: resolvedStage.matchCount,
      });
    } else {
      logger.debug('Stage already current, skipping move', {
        contactId: contact.id,
        tagSlug: targetTag.slug,
      });
    }
  }

  // Record event
  await eventService.create({
    eventType: 'chatwoot.conversation.updated',
    accountId,
    actorType: 'external',
    entityType: 'contact',
    entityId: contact.id,
    channel: 'chatwoot',
    payload: {
      conversationId: event.conversation.id,
      labels: rawLabels,
      incomingKeys,
    },
  });
}

async function handleStatusChanged(accountId: string, event: ChatwootWebhookEvent) {
  if (!event.conversation) return;

  // Record event for metrics/dashboard
  await eventService.create({
    eventType: 'chatwoot.conversation.status_changed',
    accountId,
    actorType: 'external',
    channel: 'chatwoot',
    payload: {
      conversationId: event.conversation.id,
      status: event.conversation.status,
      previousStatus: event.changed_attributes?.[0]?.previous_value,
    },
  });
}

async function handleMessageCreated(accountId: string, event: ChatwootWebhookEvent) {
  if (!event.message || !event.conversation) return;

  // Only log for audit, don't create events for every message
  logger.debug('Message received', {
    conversationId: event.conversation.id,
    messageType: event.message.message_type,
    senderType: event.message.sender_type,
  });
}

async function handleContactCreated(accountId: string, event: ChatwootWebhookEvent) {
  if (!event.contact) return;

  await chatwootService.findOrCreateContactFromChatwoot(
    accountId,
    event.contact.id,
    undefined,
    {
      name: event.contact.name,
      phone_number: event.contact.phone_number,
      email: event.contact.email,
    }
  );
}

async function handleContactUpdated(accountId: string, event: ChatwootWebhookEvent) {
  if (!event.contact) return;

  // Find and update contact
  const contact = await prisma.contact.findFirst({
    where: {
      accountId,
      chatwootContactId: event.contact.id,
    },
  });

  if (contact) {
    await prisma.contact.update({
      where: { id: contact.id },
      data: {
        nome: event.contact.name || contact.nome,
        telefone: event.contact.phone_number || contact.telefone,
        email: event.contact.email?.toLowerCase() || contact.email,
      },
    });

    try {
      const rawLabels = await chatwootService.getContactLabels(accountId, event.contact.id);
      const incomingKeys = Array.from(new Set(rawLabels.map((s) => normalizeStageKey(s)).filter(Boolean)));
      const stageTags = await prisma.tag.findMany({
        where: { accountId, type: 'stage', ativo: true },
      });

      const resolvedStage = resolveLatestStageTagFromLabels(rawLabels, stageTags);
      const targetTag = resolvedStage.tag;

      if (targetTag) {
        const currentStage = await prisma.leadTag.findFirst({
          where: { contactId: contact.id, tag: { type: 'stage' } },
          select: { tagId: true },
        });

        if (currentStage?.tagId !== targetTag.id) {
          await contactService.applyTag(contact.id, accountId, targetTag.id, 'chatwoot');
          logger.info('Lead moved via Chatwoot contact label', {
            contactId: contact.id,
            chatwootContactId: event.contact.id,
            tagId: targetTag.id,
            tagSlug: targetTag.slug,
            label: resolvedStage.label,
            matchedStageLabels: resolvedStage.matchCount,
          });
        }
      }
    } catch (err) {
      logger.warn('Failed to sync stage from contact_updated webhook', {
        chatwootContactId: event.contact.id,
        error: (err as any)?.message,
      });
    }
  }
}

export const chatwootController = new ChatwootController();

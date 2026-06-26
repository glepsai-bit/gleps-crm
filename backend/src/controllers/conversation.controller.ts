import { Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  conversationService,
  type ListConversationFilters,
  type GetConversationInclude,
  type ConversationActor,
} from '../services/conversation.service';
import { conversationCycleService } from '../services/conversation-cycle.service';
import { AuthenticatedRequest } from '../types';
import { ValidationError } from '../utils/errors';

// ============================================
// Validation schemas
// ============================================

const ALLOWED_STATUSES = ['open', 'pending', 'resolved', 'snoozed'] as const;
const ALLOWED_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
const ALLOWED_RESOLVED_BY = ['ai', 'human', 'timeout'] as const;

const listSchema = z.object({
  status: z.enum(ALLOWED_STATUSES).optional(),
  assigneeId: z.string().optional(),
  teamId: z.string().optional(),
  inboxId: z.string().optional(),
  labelId: z.string().optional(),
  priority: z.enum(ALLOWED_PRIORITIES).optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const createSchema = z.object({
  inboxId: z.string().min(1, 'inboxId é obrigatório'),
  contactId: z.string().nullable().optional(),
  externalId: z.string().nullable().optional(),
  priority: z.enum(ALLOWED_PRIORITIES).optional(),
  customAttributes: z.record(z.unknown()).optional(),
});

const statusSchema = z.object({
  status: z.enum(ALLOWED_STATUSES),
});

const prioritySchema = z.object({
  priority: z.enum(ALLOWED_PRIORITIES),
});

const assignSchema = z.object({
  assigneeId: z.string().nullable(),
});

const assignTeamSchema = z.object({
  teamId: z.string().nullable(),
});

const transferSchema = z.object({
  to: z.enum(['agent', 'team']),
  targetId: z.string().nullable(),
  note: z.string().optional(),
});

const snoozeSchema = z.object({
  until: z.union([z.string(), z.number(), z.date()]),
});

const resolveSchema = z.object({
  resolvedBy: z.enum(ALLOWED_RESOLVED_BY),
});

const labelSchema = z.object({
  tagId: z.string().min(1, 'tagId é obrigatório'),
});

const participantSchema = z.object({
  userId: z.string().min(1, 'userId é obrigatório'),
});

// T2-CONV-ATTRS: aceita ambos `attrs` (legado) e `customAttributes` (camelCase
// como a UI envia). Normaliza pra `attrs` internamente. Antes a UI mandava
// `customAttributes:{}` e o schema rejeitava (400 — sem efeito). Agora os dois
// shapes funcionam; pelo menos um precisa estar presente.
const customAttrsSchema = z
  .object({
    attrs: z.record(z.unknown()).optional(),
    customAttributes: z.record(z.unknown()).optional(),
  })
  .refine((d) => d.attrs !== undefined || d.customAttributes !== undefined, {
    message: 'Informe attrs ou customAttributes',
  })
  .transform((d) => ({ attrs: (d.attrs ?? d.customAttributes) as Record<string, unknown> }));

// ============================================
// Helpers
// ============================================

function parseInclude(req: AuthenticatedRequest): GetConversationInclude {
  // Aceita ?include=messages,participants,labels OU flags isoladas
  const include: GetConversationInclude = {};
  const raw = req.query.include;

  if (typeof raw === 'string' && raw.length > 0) {
    const parts = raw.split(',').map((s) => s.trim().toLowerCase());
    if (parts.includes('messages')) include.messages = true;
    if (parts.includes('participants')) include.participants = true;
    if (parts.includes('labels')) include.labels = true;
  }

  if (req.query.messages === 'true') include.messages = true;
  if (req.query.participants === 'true') include.participants = true;
  if (req.query.labels === 'true') include.labels = true;

  return include;
}

function getAccountId(req: AuthenticatedRequest): string {
  return req.user!.accountId!;
}

/**
 * CHAT-ACTIONS-A-2: monta o ConversationActor a partir do req.user para
 * que o service aplique RBAC (agente só vê/muta conversas que lhe
 * pertencem; admin/super_admin passam direto).
 */
function getActor(req: AuthenticatedRequest): ConversationActor {
  return {
    userId: req.user!.id,
    role: req.user!.role as ConversationActor['role'],
  };
}

// ============================================
// Controller
// ============================================

export class ConversationController {
  /**
   * GET /conversations
   */
  async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = listSchema.parse(req.query);

      const filters: ListConversationFilters = {
        status: parsed.status,
        inboxId: parsed.inboxId,
        labelId: parsed.labelId,
        priority: parsed.priority,
        search: parsed.search,
        limit: parsed.limit,
        offset: parsed.offset,
      };

      // assigneeId / teamId aceitam 'null' (string) para filtrar "não atribuído"
      if (parsed.assigneeId !== undefined) {
        filters.assigneeId = parsed.assigneeId === 'null' ? null : parsed.assigneeId;
      }
      if (parsed.teamId !== undefined) {
        filters.teamId = parsed.teamId === 'null' ? null : parsed.teamId;
      }

      const result = await conversationService.list(getAccountId(req), filters, getActor(req));
      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /conversations/:id
   */
  async get(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const include = parseInclude(req);
      const data = await conversationService.get(id, getAccountId(req), include, getActor(req));
      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /conversations
   */
  async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = createSchema.parse(req.body);
      const data = await conversationService.create(getAccountId(req), body);
      res.status(201).json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /conversations/:id/status
   */
  async updateStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const { status } = statusSchema.parse(req.body);
      await conversationService.ensureConversationAccess(id, getAccountId(req), getActor(req));
      const data = await conversationService.updateStatus(
        id,
        getAccountId(req),
        status,
        req.user!.id
      );
      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /conversations/:id/priority
   */
  async updatePriority(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const { priority } = prioritySchema.parse(req.body);
      await conversationService.ensureConversationAccess(id, getAccountId(req), getActor(req));
      const data = await conversationService.updatePriority(
        id,
        getAccountId(req),
        priority,
        req.user!.id
      );
      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /conversations/:id/assign
   */
  async assign(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const { assigneeId } = assignSchema.parse(req.body);
      await conversationService.ensureConversationAccess(id, getAccountId(req), getActor(req));
      const data = await conversationService.assign(
        id,
        getAccountId(req),
        assigneeId,
        req.user!.id
      );
      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /conversations/:id/assign-team
   */
  async assignTeam(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const { teamId } = assignTeamSchema.parse(req.body);
      await conversationService.ensureConversationAccess(id, getAccountId(req), getActor(req));
      const data = await conversationService.assignToTeam(
        id,
        getAccountId(req),
        teamId,
        req.user!.id
      );
      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /conversations/:id/transfer
   */
  async transfer(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const { to, targetId, note } = transferSchema.parse(req.body);
      await conversationService.ensureConversationAccess(id, getAccountId(req), getActor(req));
      const data = await conversationService.transfer(id, getAccountId(req), {
        to,
        targetId,
        fromUserId: req.user!.id,
        note,
      });
      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /conversations/:id/snooze
   */
  async snooze(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const { until } = snoozeSchema.parse(req.body);

      const date = until instanceof Date ? until : new Date(until as any);
      if (isNaN(date.getTime())) {
        throw new ValidationError('Data de snooze inválida');
      }

      await conversationService.ensureConversationAccess(id, getAccountId(req), getActor(req));
      const data = await conversationService.snooze(id, getAccountId(req), date, req.user!.id);
      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /conversations/:id/resolve
   */
  async resolve(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const { resolvedBy } = resolveSchema.parse(req.body);
      await conversationService.ensureConversationAccess(id, getAccountId(req), getActor(req));
      const data = await conversationService.resolve(id, getAccountId(req), {
        resolvedBy,
        userId: req.user!.id,
      });
      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /conversations/:id/reopen
   */
  async reopen(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      await conversationService.ensureConversationAccess(id, getAccountId(req), getActor(req));
      const data = await conversationService.reopen(id, getAccountId(req), req.user!.id);
      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /conversations/:id/labels
   */
  async addLabel(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const { tagId } = labelSchema.parse(req.body);
      await conversationService.ensureConversationAccess(id, getAccountId(req), getActor(req));
      const data = await conversationService.addLabel(
        id,
        getAccountId(req),
        tagId,
        req.user!.id
      );
      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /conversations/:id/labels/:tagId
   */
  async removeLabel(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const tagId = req.params.tagId as string;
      await conversationService.ensureConversationAccess(id, getAccountId(req), getActor(req));
      const data = await conversationService.removeLabel(
        id,
        getAccountId(req),
        tagId,
        req.user!.id
      );
      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /conversations/:id/participants
   */
  async addParticipant(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const { userId } = participantSchema.parse(req.body);
      await conversationService.ensureConversationAccess(id, getAccountId(req), getActor(req));
      const data = await conversationService.addParticipant(
        id,
        getAccountId(req),
        userId,
        req.user!.id
      );
      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /conversations/:id/participants/:userId
   */
  async removeParticipant(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const id = req.params.id as string;
      const userId = req.params.userId as string;
      await conversationService.ensureConversationAccess(id, getAccountId(req), getActor(req));
      const data = await conversationService.removeParticipant(
        id,
        getAccountId(req),
        userId,
        req.user!.id
      );
      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /conversations/:id/custom-attributes
   */
  async setCustomAttributes(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const id = req.params.id as string;
      const { attrs } = customAttrsSchema.parse(req.body);
      await conversationService.ensureConversationAccess(id, getAccountId(req), getActor(req));
      const data = await conversationService.setCustomAttributes(
        id,
        getAccountId(req),
        attrs,
        req.user!.id
      );
      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /conversations/:id/read
   */
  async markAsRead(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      await conversationService.ensureConversationAccess(id, getAccountId(req), getActor(req));
      const data = await conversationService.markAsRead(id, getAccountId(req), req.user!.id);
      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /conversations/:id/cycles — histórico de ConversationCycle (Bug B)
   *
   * Retorna todos os ciclos open->resolved da conversa, do mais recente
   * para o mais antigo. Cada reabertura cria novo ciclo (não apaga o
   * anterior), permitindo trilha completa pra UI/auditoria.
   *
   * Respeita RBAC: agente só lê ciclos de conversas que lhe pertencem
   * (ensureConversationAccess usa o mesmo critério das demais mutations).
   */
  async listCycles(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const id = req.params.id as string;
      const accountId = getAccountId(req);
      await conversationService.ensureConversationAccess(id, accountId, getActor(req));
      const data = await conversationCycleService.listCycles(id, accountId);
      res.json({ data });
    } catch (error) {
      next(error);
    }
  }
}

export const conversationController = new ConversationController();

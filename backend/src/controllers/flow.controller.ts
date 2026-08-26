import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { flowService } from '../services/flow.service';
import { listNodeTypes } from '../services/flow/nodes';
import { parseGraph, validateGraph } from '../services/flow/engine';
import { buildDefaultGraph, SUGGESTED_AGENT_SCHEMA } from '../services/flow/default-graph';
import { AuthenticatedRequest } from '../types';

/**
 * T-028 Fase 2 — fluxos de atendimento.
 *
 * Escopo por accountId em toda rota (ver flow.routes.ts).
 */

const nodeSchema = z.object({
  id: z.string().min(1).max(80),
  type: z.string().min(1).max(60),
  label: z.string().max(120).optional(),
  config: z.record(z.unknown()).optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
});

const edgeSchema = z.object({
  id: z.string().min(1).max(80),
  source: z.string().min(1).max(80),
  target: z.string().min(1).max(80),
  branch: z.string().max(40).nullable().optional(),
});

const graphSchema = z.object({
  nodes: z.array(nodeSchema).max(60),
  edges: z.array(edgeSchema).max(120),
});

const createSchema = z.object({
  name: z.string().min(1, 'Nome é obrigatório').max(120),
  description: z.string().max(2000).optional().nullable(),
  graph: graphSchema,
  inboxIds: z.array(z.string().uuid()).optional().nullable(),
});

const updateSchema = createSchema.partial();

const statusSchema = z.object({
  status: z.enum(['draft', 'shadow', 'active']),
});

const runsQuerySchema = z.object({
  flowId: z.string().uuid().optional(),
  status: z.enum(['buffering', 'running', 'done', 'failed', 'skipped']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export class FlowController {
  /**
   * GET /flows/catalog
   * Paleta de nós + schema sugerido do agente. A tela usa pra montar o menu
   * de "adicionar nó" sem duplicar a lista no frontend.
   */
  async catalog(_req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      res.json({ data: { nodes: listNodeTypes(), agentSchema: SUGGESTED_AGENT_SCHEMA } });
    } catch (error) {
      next(error);
    }
  }

  async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      res.json({ data: await flowService.list(req.user!.accountId!) });
    } catch (error) {
      next(error);
    }
  }

  async get(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const flow = await flowService.get(req.user!.accountId!, (req.params.id as string));
      // Devolve os problemas junto: a tela mostra o que falta pra ativar sem
      // precisar tentar e tomar erro.
      res.json({ data: { ...flow, problemas: validateGraph(parseGraph(flow.graph)) } });
    } catch (error) {
      next(error);
    }
  }

  async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = createSchema.parse(req.body);
      const flow = await flowService.create(req.user!.accountId!, body);
      res.status(201).json({ data: flow });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /flows/seed-default
   * Cria o fluxo padrão (a tradução do workflow do n8n). É o atalho pra quem
   * não quer montar do zero — nasce em rascunho, com o agente por escolher.
   */
  async seedDefault(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = z
        .object({ agentId: z.string().uuid().optional(), name: z.string().max(120).optional() })
        .parse(req.body ?? {});

      const flow = await flowService.create(req.user!.accountId!, {
        name: body.name?.trim() || 'Atendimento IA',
        description: 'Fluxo padrão: agrupa mensagens, roda o agente, aplica etapa e responde.',
        graph: buildDefaultGraph(body.agentId ?? null),
      });
      res.status(201).json({ data: flow });
    } catch (error) {
      next(error);
    }
  }

  async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = updateSchema.parse(req.body);
      const flow = await flowService.update(req.user!.accountId!, (req.params.id as string), body);
      res.json({ data: { ...flow, problemas: validateGraph(parseGraph(flow.graph)) } });
    } catch (error) {
      next(error);
    }
  }

  async setStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { status } = statusSchema.parse(req.body);
      const flow = await flowService.setStatus(req.user!.accountId!, (req.params.id as string), status);
      res.json({ data: flow });
    } catch (error) {
      next(error);
    }
  }

  async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      await flowService.delete(req.user!.accountId!, (req.params.id as string));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // Execuções
  // ============================================

  async listRuns(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const q = runsQuerySchema.parse(req.query);
      res.json({ data: await flowService.listRuns(req.user!.accountId!, q) });
    } catch (error) {
      next(error);
    }
  }

  async getRun(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      res.json({ data: await flowService.getRun(req.user!.accountId!, (req.params.runId as string)) });
    } catch (error) {
      next(error);
    }
  }
}

export const flowController = new FlowController();

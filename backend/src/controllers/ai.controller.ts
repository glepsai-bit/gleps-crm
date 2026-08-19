import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { aiAgentService, AVAILABLE_TOOLS } from '../services/ai-agent.service';
import { knowledgeService } from '../services/knowledge.service';
import { hasProvider } from '../services/ai/client-factory';
import { search as searchKnowledge } from '../services/ai/knowledge-index';
import { AuthenticatedRequest } from '../types';

/**
 * T-027 Fase 1 — Atendimento IA: agentes + base de conhecimento.
 *
 * Escopo por accountId em toda rota (ver ai.routes.ts). O playground executa o
 * agente de verdade contra a chave da conta — é o que dá confiança pra ligar em
 * produção sem descobrir o erro no primeiro lead real.
 */

const PROVIDERS = ['openai', 'anthropic'] as const;
const ROLES = ['classifier', 'responder', 'custom'] as const;

const agentCreateSchema = z.object({
  name: z.string().min(1, 'Nome é obrigatório').max(120),
  description: z.string().max(2000).optional().nullable(),
  role: z.enum(ROLES).optional(),
  systemPrompt: z.string().min(1, 'O prompt do agente é obrigatório'),
  provider: z.enum(PROVIDERS).optional(),
  model: z.string().max(80).optional().nullable(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(64).max(32_000).optional(),
  historyLimit: z.number().int().min(0).max(60).optional(),
  knowledgeBaseId: z.string().uuid().optional().nullable(),
  tools: z.array(z.string()).optional(),
  outputSchema: z.record(z.unknown()).optional().nullable(),
  active: z.boolean().optional(),
});

const agentUpdateSchema = agentCreateSchema.partial();

const runSchema = z.object({
  message: z.string().min(1, 'Mensagem é obrigatória'),
  conversationId: z.string().uuid().optional(),
  variables: z.record(z.string()).optional(),
});

const baseSchema = z.object({
  name: z.string().min(1, 'Nome é obrigatório').max(120),
  description: z.string().max(2000).optional().nullable(),
});

const docSchema = z.object({
  title: z.string().min(1, 'Título é obrigatório').max(300),
  content: z.string().min(1, 'Conteúdo é obrigatório'),
  sourceType: z.enum(['text', 'file', 'url']).optional(),
  sourceRef: z.string().max(2000).optional().nullable(),
});

const docUpdateSchema = docSchema.partial();

const searchSchema = z.object({
  query: z.string().min(1, 'Consulta é obrigatória'),
  topK: z.coerce.number().int().min(1).max(20).optional(),
});

export class AiController {
  // ============================================
  // Status
  // ============================================

  /**
   * GET /ai/status
   * Quais providers a conta consegue usar. A tela precisa disso pra explicar
   * por que a indexação falha quando só há chave Anthropic (embeddings são
   * exclusivos da OpenAI).
   */
  async status(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.user!.accountId!;
      const [openai, anthropic] = await Promise.all([
        hasProvider(accountId, 'openai'),
        hasProvider(accountId, 'anthropic'),
      ]);

      res.json({
        data: {
          providers: { openai, anthropic },
          knowledgeBaseReady: openai,
          transcriptionReady: openai,
          tools: Object.entries(AVAILABLE_TOOLS).map(([name, t]) => ({
            name,
            description: t.definition.description,
          })),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // Agentes
  // ============================================

  async listAgents(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      res.json({ data: await aiAgentService.list(req.user!.accountId!) });
    } catch (error) {
      next(error);
    }
  }

  async getAgent(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      res.json({ data: await aiAgentService.get(req.user!.accountId!, (req.params.id as string)) });
    } catch (error) {
      next(error);
    }
  }

  async createAgent(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = agentCreateSchema.parse(req.body);
      const agent = await aiAgentService.create(req.user!.accountId!, body);
      res.status(201).json({ data: agent });
    } catch (error) {
      next(error);
    }
  }

  async updateAgent(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = agentUpdateSchema.parse(req.body);
      const agent = await aiAgentService.update(req.user!.accountId!, (req.params.id as string), body);
      res.json({ data: agent });
    } catch (error) {
      next(error);
    }
  }

  async deleteAgent(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      await aiAgentService.delete(req.user!.accountId!, (req.params.id as string));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /ai/agents/:id/run — playground.
   * Executa o agente de verdade (gasta token da conta) e devolve, junto da
   * resposta, os trechos do RAG usados e o custo — sem isso o admin não tem
   * como saber se o prompt está pegando o conhecimento certo.
   */
  async runAgent(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = runSchema.parse(req.body);
      const result = await aiAgentService.run({
        accountId: req.user!.accountId!,
        agentId: (req.params.id as string),
        userMessage: body.message,
        conversationId: body.conversationId,
        variables: body.variables,
      });
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // Bases de conhecimento
  // ============================================

  async listBases(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      res.json({ data: await knowledgeService.listBases(req.user!.accountId!) });
    } catch (error) {
      next(error);
    }
  }

  async createBase(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = baseSchema.parse(req.body);
      const base = await knowledgeService.createBase(req.user!.accountId!, body);
      res.status(201).json({ data: base });
    } catch (error) {
      next(error);
    }
  }

  async updateBase(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = baseSchema.partial().parse(req.body);
      const base = await knowledgeService.updateBase(req.user!.accountId!, (req.params.id as string), body);
      res.json({ data: base });
    } catch (error) {
      next(error);
    }
  }

  async deleteBase(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      await knowledgeService.deleteBase(req.user!.accountId!, (req.params.id as string));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }

  /** GET /ai/knowledge/:baseId/search — inspeção do RAG sem gastar o agente. */
  async searchBase(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = searchSchema.parse(req.query);
      const hits = await searchKnowledge(
        req.user!.accountId!,
        (req.params.baseId as string),
        query.query,
        query.topK ?? 6
      );
      res.json({ data: hits });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // Documentos
  // ============================================

  async listDocs(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      res.json({
        data: await knowledgeService.listDocs(req.user!.accountId!, (req.params.baseId as string)),
      });
    } catch (error) {
      next(error);
    }
  }

  async createDoc(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = docSchema.parse(req.body);
      const doc = await knowledgeService.createDoc(
        req.user!.accountId!,
        (req.params.baseId as string),
        body
      );
      res.status(201).json({ data: doc });
    } catch (error) {
      next(error);
    }
  }

  async updateDoc(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = docUpdateSchema.parse(req.body);
      const doc = await knowledgeService.updateDoc(req.user!.accountId!, (req.params.docId as string), body);
      res.json({ data: doc });
    } catch (error) {
      next(error);
    }
  }

  async deleteDoc(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      await knowledgeService.deleteDoc(req.user!.accountId!, (req.params.docId as string));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }

  async reindexDoc(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const doc = await knowledgeService.reindexDoc(req.user!.accountId!, (req.params.docId as string));
      res.json({ data: doc });
    } catch (error) {
      next(error);
    }
  }
}

export const aiController = new AiController();

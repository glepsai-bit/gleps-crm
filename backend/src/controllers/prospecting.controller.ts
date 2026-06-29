import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prospectingService } from '../services/prospecting.service';
import { AuthenticatedRequest } from '../types';

const extractSchema = z.object({
  nicho: z.string().min(1),
  localizacao: z.string().min(1),
});

// T-022 — DispatchDialog hoje envia inbox_id como UUID (string) vindo da
// tabela Prisma `Inbox`. O caminho legacy (REMOVED) ainda mandava number.
// Aceita ambos no Zod e o service normaliza para gravar no DispatchLog.inboxId.
const dispatchSchema = z.object({
  inbox_assignments: z.array(z.object({
    inbox_id: z.union([z.string(), z.number()]),
    inbox_name: z.string(),
    contacts: z.array(z.object({
      nome: z.string(),
      telefone: z.string(),
    })),
  })).min(1),
  messages: z.array(z.string().min(1)).min(1),
  delay_seconds: z.number().min(5).max(300).default(30),
  keyword: z.string().optional(),
  location: z.string().optional(),
});

const cancelSchema = z.object({ batch_id: z.string().uuid() });

const resumeSchema = z.object({
  batch_id: z.string().uuid(),
  messages: z.array(z.string().min(1)).min(1),
  delay_seconds: z.number().min(5).max(300).optional(),
});

// QA2-BUG-001 — valida req.params.id como UUID antes de chamar o service.
// ZodError eh capturado pelo error.middleware e devolve 400 (nao 500).
const batchIdParamSchema = z.string().uuid('ID deve ser UUID valido');

// T-022 — filtros do GET /api/prospecting/batches
// Aceita string|array para source/status/campaignType (Express parseia ?key=a&key=b como array)
const stringOrArray = z.union([z.string(), z.array(z.string())]);

// BUG-013: range validation — antes, toDate < fromDate passava silenciosamente
// e a UI mostrava "nenhum dado" sem feedback. Agora rejeitamos com 400 claro.
const dateRangeRefine = (data: { fromDate?: string; toDate?: string }) => {
  if (!data.fromDate || !data.toDate) return true;
  const from = new Date(data.fromDate);
  const to = new Date(data.toDate);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return true;
  return from.getTime() <= to.getTime();
};
const dateRangeMessage: { message: string; path: (string | number)[] } = {
  message: 'fromDate deve ser <= toDate',
  path: ['toDate'],
};

const getBatchesQuerySchema = z
  .object({
    q: z.string().optional(),
    source: stringOrArray.optional(),
    status: stringOrArray.optional(),
    campaignType: stringOrArray.optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .refine(dateRangeRefine, dateRangeMessage);

const aggregateQuerySchema = z
  .object({
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    groupBy: z.enum(['campaign_type', 'source', 'trigger_name']).optional(),
  })
  .refine(dateRangeRefine, dateRangeMessage);

function parseDateOrUndefined(value?: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d;
}

export class ProspectingController {
  async extractLeads(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = extractSchema.parse(req.body);
      const result = await prospectingService.extractLeads(req.user!.accountId!, body.nicho, body.localizacao);
      res.json({ success: true, leads: result.leads, usage: result.usage });
    } catch (error: any) {
      if (error.statusCode) {
        res.status(error.statusCode).json({ success: false, error: error.message });
        return;
      }
      next(error);
    }
  }

  async listInboxes(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const inboxes = await prospectingService.listInboxes(req.user!.accountId!);
      res.json({ success: true, inboxes });
    } catch (error) {
      next(error);
    }
  }

  async dispatch(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = dispatchSchema.parse(req.body);
      const result = await prospectingService.dispatch(
        req.user!.accountId!,
        body.inbox_assignments,
        body.messages,
        body.delay_seconds,
        body.keyword,
        body.location
      );
      res.json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  }

  async cancelBatch(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = cancelSchema.parse(req.body);
      await prospectingService.cancelBatch(req.user!.accountId!, body.batch_id);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }

  async resumeBatch(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = resumeSchema.parse(req.body);
      const result = await prospectingService.resumeBatch(
        req.user!.accountId!, body.batch_id, body.messages, body.delay_seconds
      );
      res.json({ success: true, batch_id: body.batch_id, ...result });
    } catch (error: any) {
      if (error.statusCode) {
        res.status(error.statusCode).json({ success: false, error: error.message });
        return;
      }
      next(error);
    }
  }

  async getBatches(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = getBatchesQuerySchema.parse(req.query ?? {});
      const batches = await prospectingService.getBatches(req.user!.accountId!, {
        q: query.q,
        source: query.source,
        status: query.status,
        campaignType: query.campaignType,
        fromDate: parseDateOrUndefined(query.fromDate),
        toDate: parseDateOrUndefined(query.toDate),
        limit: query.limit,
        offset: query.offset,
      });
      res.json({ data: batches });
    } catch (error) {
      next(error);
    }
  }

  /**
   * T-022 — GET /api/prospecting/batches/aggregate
   * Agrega batches por chave (campaign_type | source | trigger_name).
   * Default groupBy=campaign_type.
   */
  async aggregateBatches(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = aggregateQuerySchema.parse(req.query ?? {});
      const result = await prospectingService.aggregateBatches(req.user!.accountId!, {
        fromDate: parseDateOrUndefined(query.fromDate),
        toDate: parseDateOrUndefined(query.toDate),
        groupBy: query.groupBy ?? 'campaign_type',
      });
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * T-022 — GET /api/prospecting/batches/campaign-types
   * Lista distinta de campaign_types para popular dropdown de filtro UI.
   */
  async getCampaignTypes(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const types = await prospectingService.getCampaignTypes(req.user!.accountId!);
      res.json({ data: types });
    } catch (error) {
      next(error);
    }
  }

  /**
   * T-022 — GET /api/prospecting/batches/scheduled
   * Lista batches em estados não-finais (scheduled | paused | running) para a aba Agendadas.
   */
  async listScheduled(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const batches = await prospectingService.getScheduledBatches(req.user!.accountId!);
      res.json({ data: batches });
    } catch (error) {
      next(error);
    }
  }

  /**
   * T-022 — POST /api/prospecting/batches/:id/pause
   */
  async pauseScheduled(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      // QA2-BUG-001 — valida UUID antes de chamar Prisma (evita 500 por P2023).
      // ZodError eh tratado pelo error.middleware -> HTTP 400.
      const batchId = batchIdParamSchema.parse(req.params.id);
      const result = await prospectingService.pauseBatch(req.user!.accountId!, batchId);
      res.json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * T-022 — POST /api/prospecting/batches/:id/resume
   * (NÃO confundir com resumeBatch existente, que reprocessa logs de batch CANCELADO via body.messages.
   * Este aqui é o "retomar pausa", sem body.)
   */
  async resumeScheduled(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      // QA2-BUG-001 — valida UUID antes de chamar Prisma (evita 500 por P2023).
      const batchId = batchIdParamSchema.parse(req.params.id);
      const result = await prospectingService.resumeBatchFromPause(req.user!.accountId!, batchId);
      res.json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * T-022 — DELETE /api/prospecting/batches/:id
   * Cancela definitivamente (qualquer estado não-final).
   */
  async cancelScheduled(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      // QA2-BUG-001 — valida UUID antes de chamar Prisma (evita 500 por P2023).
      const batchId = batchIdParamSchema.parse(req.params.id);
      const result = await prospectingService.cancelScheduledBatch(req.user!.accountId!, batchId);
      res.json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  }

  async getBatchLogs(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const batchId = req.params.batchId as string;
      const logs = await prospectingService.getBatchLogs(batchId, req.user!.accountId!);
      res.json({ data: logs });
    } catch (error: any) {
      if (error.statusCode) {
        res.status(error.statusCode).json({ success: false, error: error.message });
        return;
      }
      next(error);
    }
  }

  /**
   * GET /api/prospecting/usage
   * Returns current month extraction usage in "extractions" units (resets monthly).
   */
  async getUsage(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const usage = await prospectingService.getUsage(req.user!.accountId!);
      res.json({ success: true, ...usage });
    } catch (error) {
      next(error);
    }
  }
}

export const prospectingController = new ProspectingController();

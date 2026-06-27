import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database';
import { contactService } from '../services/contact.service';
import { NotFoundError, UnauthorizedError, ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';

/* ============================================================================
 * INTEGRATION KANBAN (T-KANBAN-API)
 *
 * Endpoints externos (API key) para integrações n8n / agentes IA / ERPs
 * moverem leads entre etapas do Kanban sem usar a sessão JWT do CRM.
 *
 * Endpoints:
 *   - GET  /api/integrations/kanban/stages
 *       Lista etapas (Tag.type='stage') do funil isDefault da conta.
 *       Auth: requireApiKey + requireScope('kanban:read','kanban:write','leads:read','leads:write')
 *
 *   - POST /api/integrations/kanban/leads/:leadId/stage
 *       Move o lead para a etapa indicada.
 *       Body: { stageId?, stageName?, reason? } — stageId OU stageName (xor).
 *       Auth: requireApiKey + requireScope('kanban:write','leads:write')
 *
 * Toda mutação delega para contactService.applyTag, que já é transacional
 * (T1-APPLYTAG-RACE), idempotente e remove a stage tag anterior — mantemos
 * uma única fonte de verdade para a regra "lead só fica em UMA stage".
 *
 * NOTA SCOPES:
 *   O middleware apiKey.middleware não tem um enum fechado de scopes — usa
 *   apenas comparação por string. Aceitamos `kanban:write` (canônico) e
 *   `leads:write` (alias semântico alinhado às permissões JWT `leads`/`kanban`).
 *   Chaves com `*` continuam sendo aceitas como super-scope.
 * ========================================================================= */

const moveStageSchema = z
  .object({
    stageId: z.string().uuid().optional(),
    stageName: z
      .string()
      .trim()
      .min(1, 'stageName não pode ser vazio')
      .max(60, 'stageName deve ter no máximo 60 caracteres')
      .optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((d) => Boolean(d.stageId) !== Boolean(d.stageName), {
    message: 'Informe exatamente um entre stageId OU stageName',
  });

const leadIdSchema = z.string().uuid({ message: 'leadId deve ser um UUID válido' });

class IntegrationKanbanController {
  /**
   * GET /api/integrations/kanban/stages
   *
   * Lista as etapas do funil default da conta — UX importante para que a
   * integração externa saiba quais slugs/ids estão disponíveis ANTES de
   * tentar mover um lead.
   */
  async listStages(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.accountId;
      if (!accountId) {
        throw new UnauthorizedError('API key inválida ou revogada');
      }

      // Funil default da conta (mesma fonte usada pelo Kanban UI).
      const funnel = await prisma.funnel.findFirst({
        where: { accountId, isDefault: true },
      });

      // Sem funil default: devolvemos lista vazia (não é erro — conta nova
      // pode ainda não ter setup).
      if (!funnel) {
        // BUG 12 FIX: expor coleção também sob `data` para alinhar com o
        // contrato declarado na task (clientes esperam { data: [...] }).
        // Mantemos `stages` e `funnel` para retrocompatibilidade.
        res.status(200).json({ data: [], funnel: null, stages: [] });
        return;
      }

      const stages = await prisma.tag.findMany({
        where: {
          accountId,
          funnelId: funnel.id,
          type: 'stage',
          ativo: true,
        },
        orderBy: [{ ordem: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          slug: true,
          color: true,
          ordem: true,
          ativo: true,
        },
      });

      // BUG 12 FIX: expor coleção também sob `data` (contrato declarado
      // na task QA) preservando `stages` e `funnel` para compatibilidade
      // com clientes já em produção.
      const items = stages.map((s) => ({
        id: s.id,
        name: s.name,
        slug: s.slug,
        color: s.color,
        order: s.ordem,
        kind: 'stage' as const,
      }));

      res.status(200).json({
        data: items,
        funnel: {
          id: funnel.id,
          name: funnel.name,
          slug: funnel.slug,
          isDefault: funnel.isDefault,
        },
        stages: items,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/integrations/kanban/leads/:leadId/stage
   *
   * Move o lead para a etapa especificada. Resolve stageName -> tagId quando
   * stageId não é fornecido. Delega a mutação para contactService.applyTag
   * (reusa transação T1-APPLYTAG-RACE: remove stage antiga, cria nova,
   * grava TagHistory, emite event lead.stage.changed).
   */
  async moveStage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.accountId;
      if (!accountId) {
        throw new UnauthorizedError('API key inválida ou revogada');
      }

      // 1) Valida leadId (uuid)
      const leadIdParsed = leadIdSchema.safeParse(req.params.leadId);
      if (!leadIdParsed.success) {
        throw new ValidationError('leadId inválido', {
          issues: leadIdParsed.error.issues,
        });
      }
      const leadId = leadIdParsed.data;

      // 2) Valida body (stageId XOR stageName)
      const body = moveStageSchema.parse(req.body ?? {});

      // 3) Confirma que o lead existe na conta (cross-tenant guard).
      //    contactService.getById já lança NotFoundError('Contato') quando
      //    não acha — mas queremos a mensagem 'Lead' para a UX da API.
      const lead = await prisma.contact.findFirst({
        where: { id: leadId, accountId },
        select: { id: true, nome: true },
      });
      if (!lead) {
        throw new NotFoundError('Lead');
      }

      // 4) Resolve a tag-stage alvo
      let tag = null as null | {
        id: string;
        name: string;
        slug: string;
        type: 'stage' | 'operational';
        accountId: string;
      };

      if (body.stageId) {
        const t = await prisma.tag.findFirst({
          where: { id: body.stageId, accountId },
          select: { id: true, name: true, slug: true, type: true, accountId: true },
        });
        tag = t as typeof tag;
      } else if (body.stageName) {
        // BUG 6 FIX: o equals do Prisma (postgres ILIKE) só normalizava
        // case; padding interno duplo (ex: "  Aluno  Ativo  ") gerava 404
        // mesmo quando a stage existia. Agora normalizamos AMBOS os lados:
        // trim + collapse de whitespace interno + lowercase, e fazemos o
        // match em JS após buscar os candidatos do funil.
        const normalize = (s: string): string =>
          s.trim().replace(/\s+/g, ' ').toLowerCase();
        const wanted = normalize(body.stageName);

        // Busca por nome case-insensitive no funil default; se não houver
        // funil default cai pra qualquer funil da conta (alguns clientes
        // ainda não tem isDefault setado).
        const defaultFunnel = await prisma.funnel.findFirst({
          where: { accountId, isDefault: true },
          select: { id: true },
        });

        if (defaultFunnel) {
          const candidates = await prisma.tag.findMany({
            where: {
              accountId,
              funnelId: defaultFunnel.id,
              type: 'stage',
            },
            select: { id: true, name: true, slug: true, type: true, accountId: true },
          });
          const match = candidates.find((c) => normalize(c.name) === wanted);
          if (match) {
            tag = {
              id: match.id,
              name: match.name,
              slug: match.slug,
              type: match.type,
              accountId: match.accountId,
            };
          }
        }

        if (!tag) {
          // Fallback: qualquer funil da conta com nome normalizado
          const candidates = await prisma.tag.findMany({
            where: {
              accountId,
              type: 'stage',
            },
            select: { id: true, name: true, slug: true, type: true, accountId: true },
          });
          const match = candidates.find((c) => normalize(c.name) === wanted);
          if (match) {
            tag = {
              id: match.id,
              name: match.name,
              slug: match.slug,
              type: match.type,
              accountId: match.accountId,
            };
          }
        }
      }

      if (!tag) {
        throw new NotFoundError('Stage');
      }

      // 5) Garantir que é uma stage tag (não permitir aplicar tag operational
      //    por este endpoint — operational tags vão por /tags ou outro fluxo).
      if (tag.type !== 'stage') {
        throw new ValidationError(
          'Tag informada não é uma etapa (type=stage). Operacionais não são aceitas neste endpoint.',
          { tagId: tag.id, tagType: tag.type }
        );
      }

      // 6) Snapshot da stage atual ANTES da mudança (audit + payload de retorno)
      const previousStageLeadTag = await prisma.leadTag.findFirst({
        where: { contactId: leadId, tag: { type: 'stage' } },
        include: { tag: { select: { id: true, name: true, slug: true } } },
      });

      const fromStage = previousStageLeadTag
        ? {
            id: previousStageLeadTag.tag.id,
            name: previousStageLeadTag.tag.name,
            slug: previousStageLeadTag.tag.slug,
          }
        : null;

      // Idempotência: se já está nesta stage, devolve no-op (200) sem
      // chamar applyTag (que também é idempotente, mas evitamos o overhead
      // e o ruído no TagHistory).
      const isNoop = fromStage?.id === tag.id;

      const appliedAt = new Date();

      if (!isNoop) {
        // BUG 11 FIX: passar reason e apiKeyId para o audit trail (TagHistory
        // grava reason persistido + actorType='external' / actorId=apiKey.id
        // para identificar qual integração executou a transição).
        await contactService.applyTag(
          leadId,
          accountId,
          tag.id,
          'api',
          undefined, // sem appliedById — actor é a API key
          {
            reason: body.reason,
            apiKeyId: req.apiKey?.id,
          }
        );
      }

      logger.info('[integration-kanban] move stage', {
        accountId,
        apiKeyId: req.apiKey?.id ?? null,
        leadId,
        fromStageId: fromStage?.id ?? null,
        toStageId: tag.id,
        noop: isNoop,
        reason: body.reason ?? null,
      });

      res.status(200).json({
        lead: {
          id: lead.id,
          nome: lead.nome,
          stageId: tag.id,
          stageName: tag.name,
          stageSlug: tag.slug,
          updatedAt: appliedAt.toISOString(),
        },
        transition: {
          from: fromStage,
          to: { id: tag.id, name: tag.name, slug: tag.slug },
          at: appliedAt.toISOString(),
          noop: isNoop,
          reason: body.reason ?? null,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(new ValidationError('Payload inválido', { issues: error.issues }));
        return;
      }
      next(error);
    }
  }
}

export const integrationKanbanController = new IntegrationKanbanController();

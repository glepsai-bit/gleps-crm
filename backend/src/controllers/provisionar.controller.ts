import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../types';
import { ValidationError } from '../utils/errors';
import {
  provisionarService,
  MAX_CONVERSAS_SIMULADAS,
  MAX_TURNOS_SIMULADOS,
} from '../services/provisionar.service';
import { specSchema, parseEmPortugues, SEGMENTOS, type Segmento } from '../services/provisionar/spec';
import { conversasTeste } from '../services/provisionar/conversas-teste';

/**
 * PROVISIONAMENTO DE AGENTE — só super admin (ver provisionar.routes.ts).
 *
 * O `accountId` vem no corpo do POST porque o super admin não tem conta: ele
 * provisiona NA conta do cliente. Nas rotas por `:agentId`, a conta é a do
 * agente.
 *
 * Toda validação de forma é zod com mensagem em português; o error.middleware
 * devolve 400 com `fieldErrors` por caminho (`spec.negocio.nome — …`).
 */

const uuid = (nome: string) => z.string().uuid(`${nome} precisa ser um uuid`);

const criarSchema = z.object({
  accountId: uuid('accountId'),
  agentId: uuid('agentId').optional().nullable(),
  spec: specSchema,
});

const atualizarSchema = z.object({ spec: specSchema });

const reverterSchema = z.object({
  versao: z.number({ invalid_type_error: 'versao precisa ser número' }).int('versao precisa ser inteiro').min(1, 'versao começa em 1'),
});

const publicarSchema = z.object({
  status: z.enum(['draft', 'shadow', 'active'], {
    errorMap: () => ({ message: 'status precisa ser draft, shadow ou active' }),
  }),
});

const simularSchema = z.object({
  conversas: z
    .array(
      z.object({
        nome: z.string().trim().min(1, 'nome da conversa é obrigatório').max(80, 'nome da conversa passa de 80 caracteres'),
        mensagens: z
          .array(z.string().trim().min(1, 'mensagem vazia').max(2000, 'mensagem passa de 2000 caracteres'))
          .min(1, 'cada conversa precisa de ao menos uma mensagem')
          .max(MAX_TURNOS_SIMULADOS, `no máximo ${MAX_TURNOS_SIMULADOS} mensagens por conversa`),
      })
    )
    .min(1, 'informe ao menos uma conversa')
    .max(MAX_CONVERSAS_SIMULADAS, `no máximo ${MAX_CONVERSAS_SIMULADAS} conversas por lote`),
  maxTurnos: z
    .number({ invalid_type_error: 'maxTurnos precisa ser número' })
    .int()
    .min(1, 'maxTurnos vai de 1 a 12')
    .max(MAX_TURNOS_SIMULADOS, 'maxTurnos vai de 1 a 12')
    .optional(),
});

export class ProvisionarController {
  /** POST /admin/provisionar/agente — 201 criado | 200 atualizado. */
  async criar(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = parseEmPortugues(criarSchema, req.body);
      const { resposta, criado } = await provisionarService.provisionar({
        accountId: body.accountId,
        spec: body.spec,
        agentId: body.agentId ?? null,
        atorId: req.user!.id,
      });
      res.status(criado ? 201 : 200).json({ data: resposta });
    } catch (error) {
      next(error);
    }
  }

  /** GET /admin/provisionar/agente/:agentId */
  async obter(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      res.json({ data: await provisionarService.obter(req.params.agentId as string) });
    } catch (error) {
      next(error);
    }
  }

  /** PUT /admin/provisionar/agente/:agentId — re-provisiona (modo atualizar). */
  async atualizar(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = parseEmPortugues(atualizarSchema, req.body);
      const agente = await provisionarService.obter(req.params.agentId as string);
      const { resposta } = await provisionarService.provisionar({
        accountId: agente.accountId,
        spec: body.spec,
        agentId: agente.agentId,
        atorId: req.user!.id,
        motivo: 'atualizado',
      });
      res.json({ data: resposta });
    } catch (error) {
      next(error);
    }
  }

  /** POST /admin/provisionar/agente/:agentId/reverter — body { versao }. */
  async reverter(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = parseEmPortugues(reverterSchema, req.body);
      const { resposta } = await provisionarService.reverter(req.params.agentId as string, body.versao, req.user!.id);
      res.json({ data: resposta });
    } catch (error) {
      next(error);
    }
  }

  /** POST /admin/provisionar/agente/:agentId/publicar — body { status }. */
  async publicar(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = parseEmPortugues(publicarSchema, req.body);
      res.json({ data: await provisionarService.publicar(req.params.agentId as string, body.status) });
    } catch (error) {
      next(error);
    }
  }

  /** POST /admin/provisionar/agente/:agentId/simular — body { conversas, maxTurnos? }. */
  async simular(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = parseEmPortugues(simularSchema, req.body);
      const relatorio = await provisionarService.simular(req.params.agentId as string, body.conversas, body.maxTurnos);
      res.json({ data: relatorio });
    } catch (error) {
      next(error);
    }
  }

  /** GET /admin/provisionar/conversas-teste/:segmento */
  async conversasTeste(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const segmento = String(req.params.segmento ?? '').toLowerCase();
      if (!(SEGMENTOS as readonly string[]).includes(segmento)) {
        throw new ValidationError(`Segmento inválido. Use um de: ${SEGMENTOS.join(', ')}`);
      }
      res.json({ data: conversasTeste(segmento as Segmento) });
    } catch (error) {
      next(error);
    }
  }
}

export const provisionarController = new ProvisionarController();

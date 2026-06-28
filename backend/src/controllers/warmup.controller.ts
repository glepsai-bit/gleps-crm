/**
 * T-023 — WhatsApp Warmup Controller
 *
 * Endpoints REST do modulo de aquecimento de chips Evolution.
 * Toda mutacao eh escopada por accountId (multi-tenant) e exige role
 * admin/super_admin via middleware no router.
 *
 * Estrutura:
 *   - Pools (CRUD)          POST/GET/PATCH/DELETE  /pools
 *   - Numbers (CRUD)        POST/GET/DELETE        /numbers
 *   - Numbers (lifecycle)   POST                   /numbers/:id/{start,pause,resume}
 *   - Stats                 GET                    /numbers/:id/stats
 *
 * Plano diario (strategy MODERATE — default MVP):
 *   D1:10, D2:12, D3:15, D4:20, D5:25, D6:30, D7:40,
 *   D8-14: linear 50..80, D15-21: linear 100..180, D22+: 200.
 */

import { Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../config/database';
import { AuthenticatedRequest } from '../types';
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../utils/errors';
import { logger } from '../utils/logger';
import {
  listEnabledProviders,
  isAnyProviderEnabled,
} from '../services/ai/registry';

// ─── Schemas ─────────────────────────────────────────────────────────────────

const strategyEnum = z.enum(['conservative', 'moderate', 'aggressive']);
const aiProviderEnum = z.enum(['openai', 'anthropic']);
const aiToneEnum = z.enum(['casual', 'formal', 'gym', 'clinic']);

const poolNameSchema = z
  .string()
  .trim()
  .min(1, 'name nao pode ser vazio')
  .max(160, 'name maximo 160 caracteres');

const createPoolSchema = z
  .object({
    name: poolNameSchema,
    description: z.string().trim().max(500).optional(),
    strategy: strategyEnum.optional(),
    useAi: z.boolean().default(false),
    aiProvider: aiProviderEnum.optional().nullable(),
    aiModel: z.string().trim().min(1).max(100).optional().nullable(),
    aiTone: aiToneEnum.default('casual'),
  })
  .superRefine((data, ctx) => {
    if (data.useAi && !data.aiProvider) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aiProvider'],
        message: 'aiProvider obrigatorio quando useAi=true',
      });
    }
  });

const updatePoolSchema = z
  .object({
    name: poolNameSchema.optional(),
    description: z.string().trim().max(500).nullable().optional(),
    isActive: z.boolean().optional(),
    strategy: strategyEnum.optional(),
    useAi: z.boolean().optional(),
    aiProvider: aiProviderEnum.optional().nullable(),
    aiModel: z.string().trim().min(1).max(100).optional().nullable(),
    aiTone: aiToneEnum.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.useAi === true && data.aiProvider === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aiProvider'],
        message: 'aiProvider obrigatorio quando useAi=true',
      });
    }
  });

// E.164 — '+' obrigatorio + 8 a 15 digitos. Aceita tambem formatos sem '+'
// (Evolution costuma armazenar '5534999...'). Padronizamos: se nao tem '+',
// adicionamos antes de persistir.
const phoneE164Regex = /^\+?[1-9]\d{7,14}$/;

const createNumberSchema = z.object({
  poolId: z.string().uuid({ message: 'poolId invalido' }),
  evolutionInstance: z
    .string()
    .trim()
    .min(1, 'evolutionInstance obrigatorio')
    .max(255),
  phoneE164: z
    .string()
    .trim()
    .regex(phoneE164Regex, 'phoneE164 invalido (use formato E.164)'),
  displayName: z.string().trim().max(160).optional(),
});

const pauseNumberSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

// ─── Strategy plan ───────────────────────────────────────────────────────────

/**
 * Gera plano diario de envios para os primeiros 30 dias do protocolo,
 * conforme a estrategia escolhida. Retorna array onde index = day-1.
 */
function generateDailyPlan(
  strategy: 'conservative' | 'moderate' | 'aggressive'
): number[] {
  // MODERATE (default MVP): D1:10, D2:12, D3:15, D4:20, D5:25, D6:30, D7:40,
  //   D8-14: 50..80 linear, D15-21: 100..180 linear, D22+: 200.
  const moderate: number[] = [10, 12, 15, 20, 25, 30, 40];
  // D8..D14 (7 dias) linear de 50 a 80
  for (let i = 0; i < 7; i++) {
    moderate.push(Math.round(50 + ((80 - 50) * i) / 6));
  }
  // D15..D21 (7 dias) linear de 100 a 180
  for (let i = 0; i < 7; i++) {
    moderate.push(Math.round(100 + ((180 - 100) * i) / 6));
  }
  // D22..D30 estabilizado em 200
  for (let i = 0; i < 9; i++) {
    moderate.push(200);
  }

  if (strategy === 'moderate') return moderate;

  if (strategy === 'conservative') {
    // ~60% da curva moderate
    return moderate.map((v) => Math.max(5, Math.round(v * 0.6)));
  }

  // aggressive — ~150% da curva moderate, teto 300
  return moderate.map((v) => Math.min(300, Math.round(v * 1.5)));
}

/**
 * Normaliza telefone: garante prefixo '+' (E.164 canonico).
 */
function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  return trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
}

// ─── Controller ──────────────────────────────────────────────────────────────

class ApiWarmupController {
  // ─── Pools ────────────────────────────────────────────────────────────────

  /**
   * GET /api/warmup/pools
   * Lista pools da accountId. Pools sao SEMPRE isoladas por conta — sem
   * compartilhamento cross-tenant (regra LGPD + isolamento multi-tenant).
   */
  async listPools(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = req.user?.accountId;
      if (!accountId) throw new UnauthorizedError();

      const pools = await prisma.warmupPool.findMany({
        where: { accountId },
        orderBy: { createdAt: 'desc' },
        include: {
          _count: { select: { numbers: true } },
        },
      });

      res.status(200).json({
        data: pools.map((p) => ({
          id: p.id,
          accountId: p.accountId,
          name: p.name,
          description: p.description,
          isActive: p.isActive,
          strategy: p.strategy,
          useAi: p.useAi,
          aiProvider: p.aiProvider,
          aiModel: p.aiModel,
          aiTone: p.aiTone,
          numbersCount: p._count.numbers,
          createdAt: p.createdAt.toISOString(),
          updatedAt: p.updatedAt.toISOString(),
        })),
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/warmup/pools
   */
  async createPool(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = req.user?.accountId;
      if (!accountId) throw new UnauthorizedError();

      const body = createPoolSchema.parse(req.body ?? {});

      const pool = await prisma.warmupPool.create({
        data: {
          accountId,
          name: body.name,
          description: body.description,
          strategy: body.strategy ?? 'moderate',
          useAi: body.useAi,
          aiProvider: body.aiProvider ?? null,
          aiModel: body.aiModel ?? null,
          aiTone: body.aiTone,
        },
      });

      logger.info('[warmup] pool created', {
        accountId,
        poolId: pool.id,
        name: pool.name,
        useAi: pool.useAi,
        aiProvider: pool.aiProvider,
      });

      res.status(201).json({
        data: {
          id: pool.id,
          accountId: pool.accountId,
          name: pool.name,
          description: pool.description,
          isActive: pool.isActive,
          strategy: pool.strategy,
          useAi: pool.useAi,
          aiProvider: pool.aiProvider,
          aiModel: pool.aiModel,
          aiTone: pool.aiTone,
          createdAt: pool.createdAt.toISOString(),
          updatedAt: pool.updatedAt.toISOString(),
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(new ValidationError('Payload invalido', { issues: error.issues }));
        return;
      }
      next(error);
    }
  }

  /**
   * PATCH /api/warmup/pools/:id
   */
  async updatePool(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = req.user?.accountId;
      if (!accountId) throw new UnauthorizedError();

      const id = z.string().uuid().parse(req.params.id);
      const body = updatePoolSchema.parse(req.body ?? {});

      // Cross-tenant guard: pool deve pertencer a accountId
      const existing = await prisma.warmupPool.findFirst({
        where: { id, accountId },
      });
      if (!existing) throw new NotFoundError('Pool');

      // Cross-field validation pos-merge: se o estado final terminar com
      // useAi=true mas sem aiProvider efetivo, rejeita.
      const finalUseAi = body.useAi ?? existing.useAi;
      const finalAiProvider =
        body.aiProvider === undefined ? existing.aiProvider : body.aiProvider;
      if (finalUseAi && !finalAiProvider) {
        throw new ValidationError(
          'aiProvider obrigatorio quando useAi=true',
          { field: 'aiProvider' }
        );
      }

      const updated = await prisma.warmupPool.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined
            ? { description: body.description }
            : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          ...(body.strategy !== undefined ? { strategy: body.strategy } : {}),
          ...(body.useAi !== undefined ? { useAi: body.useAi } : {}),
          ...(body.aiProvider !== undefined
            ? { aiProvider: body.aiProvider }
            : {}),
          ...(body.aiModel !== undefined ? { aiModel: body.aiModel } : {}),
          ...(body.aiTone !== undefined ? { aiTone: body.aiTone } : {}),
        },
      });

      res.status(200).json({
        data: {
          id: updated.id,
          accountId: updated.accountId,
          name: updated.name,
          description: updated.description,
          isActive: updated.isActive,
          strategy: updated.strategy,
          useAi: updated.useAi,
          aiProvider: updated.aiProvider,
          aiModel: updated.aiModel,
          aiTone: updated.aiTone,
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(new ValidationError('Payload invalido', { issues: error.issues }));
        return;
      }
      next(error);
    }
  }

  /**
   * DELETE /api/warmup/pools/:id
   * Cascade onDelete remove numbers/conversations/messages automaticamente.
   */
  async deletePool(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = req.user?.accountId;
      if (!accountId) throw new UnauthorizedError();

      const id = z.string().uuid().parse(req.params.id);

      const existing = await prisma.warmupPool.findFirst({
        where: { id, accountId },
      });
      if (!existing) throw new NotFoundError('Pool');

      await prisma.warmupPool.delete({ where: { id } });

      logger.info('[warmup] pool deleted', { accountId, poolId: id });

      res.status(204).send();
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(new ValidationError('id invalido', { issues: error.issues }));
        return;
      }
      next(error);
    }
  }

  // ─── AI Providers ─────────────────────────────────────────────────────────

  /**
   * GET /api/warmup/ai/providers
   * Lista providers de IA registrados e se cada um esta habilitado em runtime
   * (env var presente). Usado pela UI pra mostrar/desabilitar selects de
   * provider no formulario de pool.
   */
  async listAiProviders(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = req.user?.accountId;
      if (!accountId) throw new UnauthorizedError();

      const providers = listEnabledProviders();
      res.status(200).json({
        providers,
        anyEnabled: isAnyProviderEnabled(),
        supportedTones: ['casual', 'formal', 'gym', 'clinic'],
      });
    } catch (error) {
      next(error);
    }
  }

  // ─── Numbers ──────────────────────────────────────────────────────────────

  /**
   * GET /api/warmup/numbers?poolId=&status=
   */
  async listNumbers(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = req.user?.accountId;
      if (!accountId) throw new UnauthorizedError();

      const poolId = req.query.poolId
        ? z.string().uuid().parse(req.query.poolId)
        : undefined;
      const status = req.query.status
        ? z
            .enum(['cold', 'warming', 'warm', 'paused', 'banned', 'error'])
            .parse(req.query.status)
        : undefined;

      const numbers = await prisma.warmupNumber.findMany({
        where: {
          accountId,
          ...(poolId ? { poolId } : {}),
          ...(status ? { status } : {}),
        },
        orderBy: { createdAt: 'desc' },
      });

      res.status(200).json({
        data: numbers.map((n) => ({
          id: n.id,
          poolId: n.poolId,
          accountId: n.accountId,
          evolutionInstance: n.evolutionInstance,
          phoneE164: n.phoneE164,
          displayName: n.displayName,
          status: n.status,
          currentDay: n.currentDay,
          qualityScore: n.qualityScore,
          dailyEnviadasHoje: n.dailyEnviadasHoje,
          dailyRecebidasHoje: n.dailyRecebidasHoje,
          startedAt: n.startedAt?.toISOString() ?? null,
          lastActivityAt: n.lastActivityAt?.toISOString() ?? null,
          pausedReason: n.pausedReason,
          createdAt: n.createdAt.toISOString(),
          updatedAt: n.updatedAt.toISOString(),
        })),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(new ValidationError('Query invalida', { issues: error.issues }));
        return;
      }
      next(error);
    }
  }

  /**
   * POST /api/warmup/numbers
   * Body: { poolId, evolutionInstance, phoneE164, displayName? }
   */
  async createNumber(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = req.user?.accountId;
      if (!accountId) throw new UnauthorizedError();

      const body = createNumberSchema.parse(req.body ?? {});

      // Pool precisa existir e pertencer a accountId (isolamento estrito —
      // sem pools compartilhadas cross-tenant).
      const pool = await prisma.warmupPool.findFirst({
        where: {
          id: body.poolId,
          accountId,
        },
      });
      if (!pool) throw new NotFoundError('Pool');

      const phoneE164 = normalizePhone(body.phoneE164);

      try {
        const number = await prisma.warmupNumber.create({
          data: {
            poolId: body.poolId,
            accountId,
            evolutionInstance: body.evolutionInstance,
            phoneE164,
            displayName: body.displayName,
            status: 'cold',
            currentDay: 0,
            qualityScore: 100,
          },
        });

        logger.info('[warmup] number created', {
          accountId,
          poolId: body.poolId,
          numberId: number.id,
          phoneE164,
        });

        res.status(201).json({
          data: {
            id: number.id,
            poolId: number.poolId,
            accountId: number.accountId,
            evolutionInstance: number.evolutionInstance,
            phoneE164: number.phoneE164,
            displayName: number.displayName,
            status: number.status,
            currentDay: number.currentDay,
            qualityScore: number.qualityScore,
            createdAt: number.createdAt.toISOString(),
            updatedAt: number.updatedAt.toISOString(),
          },
        });
      } catch (err) {
        // Unique violation (accountId + phoneE164)
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          throw new ConflictError(
            'Telefone ja cadastrado nesta conta',
            { phoneE164 }
          );
        }
        throw err;
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(new ValidationError('Payload invalido', { issues: error.issues }));
        return;
      }
      next(error);
    }
  }

  /**
   * POST /api/warmup/numbers/:id/start
   * Gera plano, marca currentDay=1 e status='warming'.
   */
  async startNumber(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = req.user?.accountId;
      if (!accountId) throw new UnauthorizedError();

      const id = z.string().uuid().parse(req.params.id);

      const number = await prisma.warmupNumber.findFirst({
        where: { id, accountId },
        include: { pool: { select: { strategy: true } } },
      });
      if (!number) throw new NotFoundError('Number');

      const strategy = (number.pool?.strategy ?? 'moderate') as
        | 'conservative'
        | 'moderate'
        | 'aggressive';

      const plan = generateDailyPlan(strategy);

      const updated = await prisma.warmupNumber.update({
        where: { id },
        data: {
          status: 'warming',
          currentDay: 1,
          dailyEnvioPlan: plan as unknown as Prisma.InputJsonValue,
          startedAt: new Date(),
          dailyEnviadasHoje: 0,
          dailyRecebidasHoje: 0,
          pausedReason: null,
        },
      });

      logger.info('[warmup] number started', {
        accountId,
        numberId: id,
        strategy,
      });

      res.status(200).json({
        data: {
          id: updated.id,
          status: updated.status,
          currentDay: updated.currentDay,
          startedAt: updated.startedAt?.toISOString() ?? null,
          dailyEnvioPlan: updated.dailyEnvioPlan,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(new ValidationError('id invalido', { issues: error.issues }));
        return;
      }
      next(error);
    }
  }

  /**
   * POST /api/warmup/numbers/:id/pause
   * Body: { reason? }
   */
  async pauseNumber(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = req.user?.accountId;
      if (!accountId) throw new UnauthorizedError();

      const id = z.string().uuid().parse(req.params.id);
      const body = pauseNumberSchema.parse(req.body ?? {});

      const number = await prisma.warmupNumber.findFirst({
        where: { id, accountId },
      });
      if (!number) throw new NotFoundError('Number');

      const updated = await prisma.warmupNumber.update({
        where: { id },
        data: {
          status: 'paused',
          pausedReason: body.reason ?? 'manual',
        },
      });

      logger.info('[warmup] number paused', {
        accountId,
        numberId: id,
        reason: body.reason ?? 'manual',
      });

      res.status(200).json({
        data: {
          id: updated.id,
          status: updated.status,
          pausedReason: updated.pausedReason,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(new ValidationError('Payload invalido', { issues: error.issues }));
        return;
      }
      next(error);
    }
  }

  /**
   * POST /api/warmup/numbers/:id/resume
   */
  async resumeNumber(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = req.user?.accountId;
      if (!accountId) throw new UnauthorizedError();

      const id = z.string().uuid().parse(req.params.id);

      const number = await prisma.warmupNumber.findFirst({
        where: { id, accountId },
      });
      if (!number) throw new NotFoundError('Number');

      const updated = await prisma.warmupNumber.update({
        where: { id },
        data: {
          status: 'warming',
          pausedReason: null,
        },
      });

      logger.info('[warmup] number resumed', { accountId, numberId: id });

      res.status(200).json({
        data: {
          id: updated.id,
          status: updated.status,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(new ValidationError('id invalido', { issues: error.issues }));
        return;
      }
      next(error);
    }
  }

  /**
   * DELETE /api/warmup/numbers/:id
   */
  async deleteNumber(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = req.user?.accountId;
      if (!accountId) throw new UnauthorizedError();

      const id = z.string().uuid().parse(req.params.id);

      const number = await prisma.warmupNumber.findFirst({
        where: { id, accountId },
      });
      if (!number) throw new NotFoundError('Number');

      await prisma.warmupNumber.delete({ where: { id } });

      logger.info('[warmup] number deleted', { accountId, numberId: id });

      res.status(204).send();
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(new ValidationError('id invalido', { issues: error.issues }));
        return;
      }
      next(error);
    }
  }

  /**
   * GET /api/warmup/numbers/:id/stats
   * Retorna ultimos 30 dias de WarmupDailyStats.
   */
  async getNumberStats(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = req.user?.accountId;
      if (!accountId) throw new UnauthorizedError();

      const id = z.string().uuid().parse(req.params.id);

      const number = await prisma.warmupNumber.findFirst({
        where: { id, accountId },
      });
      if (!number) throw new NotFoundError('Number');

      const stats = await prisma.warmupDailyStats.findMany({
        where: { numberId: id },
        orderBy: { date: 'desc' },
        take: 30,
      });

      res.status(200).json({
        data: stats.map((s) => ({
          id: s.id,
          numberId: s.numberId,
          date: s.date.toISOString().split('T')[0],
          protocolDay: s.protocolDay,
          plannedSends: s.plannedSends,
          actualSends: s.actualSends,
          actualReceives: s.actualReceives,
          failedSends: s.failedSends,
          qualityEnd: s.qualityEnd,
          statusEnd: s.statusEnd,
        })),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(new ValidationError('id invalido', { issues: error.issues }));
        return;
      }
      next(error);
    }
  }
}

export const warmupController = new ApiWarmupController();

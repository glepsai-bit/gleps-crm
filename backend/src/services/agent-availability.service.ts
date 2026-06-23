/**
 * AGENT AVAILABILITY SERVICE — T-022 Sprint 4 (Chat interno)
 *
 * Gerencia presença/disponibilidade dos agentes (online | away | busy | offline)
 * usando a tabela `agent_availability` (model AgentAvailability, PK = userId).
 *
 * Responsabilidades:
 *   - Ler/atualizar status manualmente (setStatus).
 *   - Atualizar heartbeat periódico (mantém `lastActiveAt` fresco; promove
 *     'offline' → 'online' quando o agente volta a "bater").
 *   - Listar agentes "online" dentro de uma conta (multi-tenant via accountId).
 *   - Job de varredura para marcar 'offline' quem ficou inativo (cron).
 *
 * Singleton: `agentAvailabilityService`.
 */

import { AgentAvailability, User } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

// ============================================
// Types
// ============================================

export type AvailabilityStatus = 'online' | 'away' | 'busy' | 'offline';

const VALID_STATUSES: AvailabilityStatus[] = ['online', 'away', 'busy', 'offline'];

export interface MarkOfflineResult {
  markedOffline: number;
}

class AgentAvailabilityService {
  // ============================================
  // Helpers
  // ============================================

  private assertValidStatus(status: string): asserts status is AvailabilityStatus {
    if (!VALID_STATUSES.includes(status as AvailabilityStatus)) {
      throw new Error(`Status de disponibilidade inválido: ${status}`);
    }
  }

  /**
   * Garante que existe um registro de disponibilidade para o usuário.
   * Cria default ('offline') se ainda não houver.
   */
  private async ensureRow(userId: string): Promise<AgentAvailability> {
    const existing = await prisma.agentAvailability.findUnique({
      where: { userId },
    });
    if (existing) return existing;

    return prisma.agentAvailability.create({
      data: {
        userId,
        status: 'offline',
        lastActiveAt: new Date(),
      },
    });
  }

  // ============================================
  // API pública
  // ============================================

  /**
   * Retorna o status atual de um agente.
   * Se nunca registrado, cria com 'offline' e retorna.
   */
  async getStatus(userId: string): Promise<AgentAvailability> {
    return this.ensureRow(userId);
  }

  /**
   * Define manualmente o status do agente.
   * Upsert por userId.
   */
  async setStatus(userId: string, status: AvailabilityStatus): Promise<AgentAvailability> {
    this.assertValidStatus(status);

    const now = new Date();

    const row = await prisma.agentAvailability.upsert({
      where: { userId },
      create: {
        userId,
        status,
        lastActiveAt: now,
      },
      update: {
        status,
        lastActiveAt: now,
      },
    });

    logger.info('[agent-availability] status atualizado', { userId, status });

    return row;
  }

  /**
   * Lista agentes que estão atualmente 'online' dentro de uma conta.
   * Faz join com `users` filtrando por accountId.
   */
  async listOnline(accountId: string): Promise<User[]> {
    const rows = await prisma.agentAvailability.findMany({
      where: {
        status: 'online',
        user: {
          accountId,
        },
      },
      include: {
        user: true,
      },
      orderBy: {
        lastActiveAt: 'desc',
      },
    });

    return rows.map((r) => r.user);
  }

  /**
   * Heartbeat do agente: atualiza `lastActiveAt`. Se estava 'offline',
   * promove para 'online' (assume que ele voltou). Demais status (away/busy)
   * são preservados — o usuário escolheu manualmente.
   */
  async heartbeat(userId: string): Promise<void> {
    const current = await this.ensureRow(userId);

    const now = new Date();
    const shouldPromote = current.status === 'offline';

    await prisma.agentAvailability.update({
      where: { userId },
      data: {
        lastActiveAt: now,
        ...(shouldPromote ? { status: 'online' } : {}),
      },
    });

    if (shouldPromote) {
      logger.info(
        '[agent-availability] heartbeat promoveu agente de offline → online',
        { userId }
      );
    }
  }

  /**
   * Job de varredura (cron): marca como 'offline' todos os agentes cujo
   * `lastActiveAt` é anterior a (now - timeoutMs) e que ainda não estavam
   * offline. Retorna a quantidade marcada.
   *
   * @param timeoutMs Janela de inatividade tolerada (ex.: 5 * 60 * 1000).
   */
  async markOfflineAfterTimeout(timeoutMs: number): Promise<MarkOfflineResult> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('timeoutMs deve ser um número positivo');
    }

    const cutoff = new Date(Date.now() - timeoutMs);

    const result = await prisma.agentAvailability.updateMany({
      where: {
        status: { not: 'offline' },
        lastActiveAt: { lt: cutoff },
      },
      data: {
        status: 'offline',
      },
    });

    if (result.count > 0) {
      logger.info(
        '[agent-availability] agentes marcados como offline por inatividade',
        { markedOffline: result.count, cutoff: cutoff.toISOString(), timeoutMs }
      );
    }

    return { markedOffline: result.count };
  }
}

export const agentAvailabilityService = new AgentAvailabilityService();

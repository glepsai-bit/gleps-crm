/**
 * T-017 — Human-in-the-loop pós-consulta.
 *
 * Reaproveita CalendarEvent (type=appointment). 2 endpoints PATCH +
 * 1 GET de pendências. Disparo de webhook ao mudar attendance/outcome
 * é best-effort (não bloqueia a resposta).
 *
 * Multi-tenant: toda query filtra por accountId do JWT.
 * Transition guard: webhook dispara apenas quando o valor muda
 * (NULL/PENDING -> X) — evita clique duplo.
 */
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma, AttendanceStatus, AppointmentOutcome } from '@prisma/client';
import { prisma } from '../config/database';
import { AuthenticatedRequest } from '../types';
import { NotFoundError, ForbiddenError, ValidationError } from '../utils/errors';
import { n8nWebhookService } from '../services/n8n-webhook.service';

// ---------- schemas ----------
const attendanceSchema = z.object({
  status: z.enum(['ATTENDED', 'NO_SHOW', 'RESCHEDULED']),
});

const outcomeSchema = z.object({
  outcome: z.enum(['CLOSED', 'CONSIDERING', 'NOT_INTERESTED', 'RETURN_REQUESTED']),
  value: z.number().nonnegative().optional(),
  notes: z.string().max(2000).optional(),
});

const APPOINTMENT_INCLUDE = {
  contact: true,
  account: true,
} as const;

async function loadAppointmentScoped(id: string, accountId: string) {
  const appt = await prisma.calendarEvent.findUnique({
    where: { id },
    include: APPOINTMENT_INCLUDE,
  });
  if (!appt) throw new NotFoundError('Agendamento');
  if (appt.accountId !== accountId) {
    // Multi-tenant guard: trate como 403 (sabe que existe noutra conta).
    throw new ForbiddenError('Permissão negada');
  }
  return appt;
}

export class AppointmentController {
  /**
   * PATCH /api/appointments/:id/attendance
   * Body: { status: 'ATTENDED' | 'NO_SHOW' | 'RESCHEDULED' }
   */
  async markAttendance(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.user!.accountId!;
      const userId = req.user!.id;
      const userName = req.user!.nome;
      const id = req.params.id as string;

      const body = attendanceSchema.parse(req.body);

      const existing = await loadAppointmentScoped(id, accountId);

      // Transition guard: só dispara webhook se realmente mudar (idempotência).
      const willChange =
        existing.attendanceStatus !== body.status as AttendanceStatus;

      const updateData: Prisma.CalendarEventUpdateInput = {
        attendanceStatus: body.status as AttendanceStatus,
        attendanceMarkedAt: new Date(),
        attendanceMarkedBy: userId,
      };

      // Se compareceu -> evento muda pra completed; se faltou/reagendou
      // o outcome perde sentido, então força PENDING.
      if (body.status === 'ATTENDED') {
        updateData.status = 'completed';
      } else {
        updateData.outcome = 'PENDING';
        updateData.outcomeValue = null;
        updateData.outcomeNotes = null;
        updateData.outcomeMarkedAt = null;
        updateData.outcomeMarkedBy = null;
      }

      const updated = await prisma.calendarEvent.update({
        where: { id },
        data: updateData,
        include: APPOINTMENT_INCLUDE,
      });

      if (willChange) {
        // fire-and-forget: não bloqueia a resposta
        void n8nWebhookService.emitAttendanceChanged(updated, { userId, name: userName });
      }

      res.json({
        id: updated.id,
        attendanceStatus: updated.attendanceStatus,
        attendanceMarkedAt: updated.attendanceMarkedAt,
        attendanceMarkedBy: updated.attendanceMarkedBy,
        requiresOutcome: updated.attendanceStatus === 'ATTENDED',
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/appointments/:id/outcome
   * Body: { outcome, value?, notes? }
   * Requer attendanceStatus = ATTENDED.
   */
  async markOutcome(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.user!.accountId!;
      const userId = req.user!.id;
      const userName = req.user!.nome;
      const id = req.params.id as string;

      const body = outcomeSchema.parse(req.body);

      const existing = await loadAppointmentScoped(id, accountId);

      if (existing.attendanceStatus !== 'ATTENDED') {
        throw new ValidationError('Outcome só pode ser registrado para agendamentos com presença confirmada (ATTENDED).');
      }

      const willChange =
        existing.outcome !== body.outcome as AppointmentOutcome ||
        Number(existing.outcomeValue ?? 0) !== Number(body.value ?? 0) ||
        (existing.outcomeNotes ?? '') !== (body.notes ?? '');

      const updated = await prisma.calendarEvent.update({
        where: { id },
        data: {
          outcome: body.outcome as AppointmentOutcome,
          outcomeValue: body.value !== undefined ? new Prisma.Decimal(body.value) : null,
          outcomeNotes: body.notes ?? null,
          outcomeMarkedAt: new Date(),
          outcomeMarkedBy: userId,
        },
        include: APPOINTMENT_INCLUDE,
      });

      if (willChange) {
        void n8nWebhookService.emitOutcomeChanged(updated, { userId, name: userName });
      }

      res.json({
        id: updated.id,
        attendanceStatus: updated.attendanceStatus,
        outcome: updated.outcome,
        outcomeValue: updated.outcomeValue,
        outcomeNotes: updated.outcomeNotes,
        outcomeMarkedAt: updated.outcomeMarkedAt,
        outcomeMarkedBy: updated.outcomeMarkedBy,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/appointments/pending-status
   * Lista agendamentos já encerrados (endTime < now) que ainda precisam
   * de attendance ou de outcome. Limite por janela de 3 dias passados.
   */
  async listPendingStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.user!.accountId!;
      const now = new Date();
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

      const baseWhere = {
        accountId,
        type: 'appointment' as const,
        startTime: { gte: threeDaysAgo },
        endTime: { lt: now },
      };

      const [pendingAttendance, pendingOutcome] = await Promise.all([
        prisma.calendarEvent.findMany({
          where: {
            ...baseWhere,
            OR: [{ attendanceStatus: null }, { attendanceStatus: 'PENDING' }],
          },
          orderBy: { endTime: 'desc' },
          take: 50,
          include: { contact: { select: { id: true, nome: true, telefone: true } } },
        }),
        prisma.calendarEvent.findMany({
          where: {
            ...baseWhere,
            attendanceStatus: 'ATTENDED',
            OR: [{ outcome: null }, { outcome: 'PENDING' }],
          },
          orderBy: { endTime: 'desc' },
          take: 50,
          include: { contact: { select: { id: true, nome: true, telefone: true } } },
        }),
      ]);

      const toItem = (e: typeof pendingAttendance[number], needs: 'attendance' | 'outcome') => ({
        id: e.id,
        title: e.title,
        contactId: e.contactId,
        contactName: e.contact?.nome ?? null,
        startTime: e.startTime,
        endTime: e.endTime,
        needs,
      });

      res.json({
        pendingAttendance: pendingAttendance.map(e => toItem(e, 'attendance')),
        pendingOutcome: pendingOutcome.map(e => toItem(e, 'outcome')),
        total: pendingAttendance.length + pendingOutcome.length,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const appointmentController = new AppointmentController();

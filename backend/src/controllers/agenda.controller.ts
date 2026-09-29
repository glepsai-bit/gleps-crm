/**
 * T-039 — regras do agendamento (a tela "Atendimento IA › Agenda").
 *
 * Só configuração: quem atende, quando, quanto dura cada serviço e as regras
 * da conta. Marcar, remarcar e cancelar acontecem pelo agente (ferramentas em
 * services/agenda/ferramentas.ts), não por aqui.
 */
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { agendaService } from '../services/agenda.service';
import { AuthenticatedRequest } from '../types';

const configuracaoSchema = z.object({
  antecedenciaMinimaMinutos: z.number().int().optional(),
  janelaMaximaDias: z.number().int().optional(),
  passoMinutos: z.number().int().optional(),
  holdMinutos: z.number().int().optional(),
  etapaAoAgendar: z.string().max(120).nullable().optional(),
});

const profissionalSchema = z.object({
  ativo: z.boolean().optional(),
  horarios: z.record(z.array(z.object({ inicio: z.string(), fim: z.string() }))).optional(),
  intervaloMinutos: z.number().int().optional(),
});

const servicoSchema = z.object({
  duracaoMinutos: z.number().int().nullable(),
});

const horariosQuerySchema = z.object({
  profissionalId: z.string().uuid().optional(),
  produtoId: z.string().uuid(),
  dias: z.coerce.number().int().min(1).max(60).optional(),
});

class AgendaController {
  async configuracao(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await agendaService.configuracao(req.user!.accountId!);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  async salvarConfiguracao(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const input = configuracaoSchema.parse(req.body);
      const data = await agendaService.salvarConfiguracao(req.user!.accountId!, input);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  async salvarProfissional(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const input = profissionalSchema.parse(req.body);
      const data = await agendaService.salvarProfissional(req.user!.accountId!, String(req.params.userId), input);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  async salvarServico(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const input = servicoSchema.parse(req.body);
      const data = await agendaService.salvarServico(req.user!.accountId!, String(req.params.productId), input.duracaoMinutos);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  /**
   * "Testar" da tela de regras: os próximos horários que o agente ofereceria.
   * Usa TODOS os profissionais ativos (não há agente aqui pra restringir).
   */
  async horarios(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const q = horariosQuerySchema.parse(req.query);
      const accountId = req.user!.accountId!;
      const cfg = await agendaService.configuracao(accountId);
      const agenda = {
        profissionalIds: cfg.profissionais.filter((p) => p.ativo).map((p) => p.userId),
        produtoIds: [q.produtoId],
      };
      const { horarios, avisos } = await agendaService.consultarHorarios({
        accountId,
        agenda,
        produtoId: q.produtoId,
        profissionalId: q.profissionalId ?? null,
        limite: 12,
      });
      res.json({
        success: true,
        data: {
          horarios: horarios.map((h) => ({
            id: h.id,
            profissionalId: h.profissionalId,
            profissional: h.profissional,
            inicio: h.inicio.toISOString(),
            fim: h.fim.toISOString(),
            rotulo: h.rotulo,
          })),
          aviso: avisos.length > 0 ? avisos.join('; ') : undefined,
        },
      });
    } catch (err) {
      next(err);
    }
  }
}

export const agendaController = new AgendaController();

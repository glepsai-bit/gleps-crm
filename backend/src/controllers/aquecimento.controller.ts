/**
 * Aquecimento — endpoints REST (ETAPA W).
 *
 * Tudo escopado por conta (req.user.accountId) e restrito a admin/super_admin
 * pelo router. Erros de regra chegam como ValidationError (400) e
 * ConflictError (409) com `message` em português — o front mostra no toast.
 */

import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../types';
import { UnauthorizedError, ValidationError } from '../utils/errors';
import { aquecimentoService } from '../services/aquecimento.service';

const idSchema = z.string().uuid({ message: 'id inválido' });
const adicionarSchema = z.object({
  inboxId: z.string().uuid({ message: 'inboxId inválido' }),
});

function contaDe(req: AuthenticatedRequest): string {
  const accountId = req.user?.accountId;
  if (!accountId) throw new UnauthorizedError();
  return accountId;
}

class AquecimentoController {
  /** GET /api/aquecimento */
  async listar(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = contaDe(req);
      res.json({ data: await aquecimentoService.listar(accountId) });
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/aquecimento/inboxes-disponiveis */
  async inboxesDisponiveis(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = contaDe(req);
      res.json({ data: await aquecimentoService.inboxesDisponiveis(accountId) });
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/aquecimento/numeros { inboxId } */
  async adicionar(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = contaDe(req);
      const body = adicionarSchema.safeParse(req.body ?? {});
      if (!body.success) {
        throw new ValidationError('Escolha uma inbox para aquecer', { issues: body.error.issues });
      }
      const numero = await aquecimentoService.adicionar(accountId, body.data.inboxId);
      res.status(201).json({ data: { numero } });
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/aquecimento/numeros/:id/pausar */
  async pausar(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = contaDe(req);
      const id = this.idDe(req);
      const numero = await aquecimentoService.pausar(accountId, id);
      res.json({ data: { numero } });
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/aquecimento/numeros/:id/retomar */
  async retomar(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = contaDe(req);
      const id = this.idDe(req);
      const numero = await aquecimentoService.retomar(accountId, id);
      res.json({ data: { numero } });
    } catch (err) {
      next(err);
    }
  }

  /** DELETE /api/aquecimento/numeros/:id */
  async remover(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = contaDe(req);
      const id = this.idDe(req);
      await aquecimentoService.remover(accountId, id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/aquecimento/numeros/:id/historico */
  async historico(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = contaDe(req);
      const id = this.idDe(req);
      res.json({ data: await aquecimentoService.historico(accountId, id) });
    } catch (err) {
      next(err);
    }
  }

  private idDe(req: AuthenticatedRequest): string {
    const parsed = idSchema.safeParse(req.params.id);
    if (!parsed.success) throw new ValidationError('id inválido', { issues: parsed.error.issues });
    return parsed.data;
  }
}

export const aquecimentoController = new AquecimentoController();

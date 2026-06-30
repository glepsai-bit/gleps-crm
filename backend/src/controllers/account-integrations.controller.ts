/**
 * T-025 — Controller para self-service de chaves de IA (admin da propria conta).
 *
 * Rotas (montadas em /admin/integrations/ai):
 *   GET    /        -> sentinel/null por chave
 *   PATCH  /        -> aceita openaiApiKey/anthropicApiKey (string|null|'')
 *   POST   /test/:provider  -> testa chave salva (provider = openai|anthropic)
 */

import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../types';
import { ValidationError } from '../utils/errors';
import { accountIntegrationsService } from '../services/account-integrations.service';

// Zod aceita: string (qualquer tamanho, ja que sentinel '***SET***' eh string),
// null explicito (limpa) ou ausente (nao toca). String vazia = limpar.
const apiKeySchema = z.union([z.string(), z.null()]).optional();

const updateIntegrationsSchema = z.object({
  openaiApiKey: apiKeySchema,
  anthropicApiKey: apiKeySchema,
});

const PROVIDERS = ['openai', 'anthropic'] as const;
type Provider = (typeof PROVIDERS)[number];

function isProvider(v: string): v is Provider {
  return (PROVIDERS as readonly string[]).includes(v);
}

export class AccountIntegrationsController {
  /** GET /admin/integrations/ai */
  async get(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.user!.accountId!;
      const data = await accountIntegrationsService.getForAccount(accountId);
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }

  /** PATCH /admin/integrations/ai */
  async patch(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.user!.accountId!;
      const body = updateIntegrationsSchema.parse(req.body ?? {});
      const data = await accountIntegrationsService.update(accountId, body, req.user!.id);
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }

  /** POST /admin/integrations/ai/test/:provider */
  async test(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.user!.accountId!;
      const provider = String(req.params.provider ?? '').toLowerCase();
      if (!isProvider(provider)) {
        throw new ValidationError(
          `Provider invalido. Use: ${PROVIDERS.join(', ')}`,
          { provider }
        );
      }
      const result = await accountIntegrationsService.test(accountId, provider);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
}

export const accountIntegrationsController = new AccountIntegrationsController();

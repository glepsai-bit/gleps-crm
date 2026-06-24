import { Response as ExpressResponse, NextFunction } from 'express';
import { z } from 'zod';
import { systemSettingsService } from '../services/system-settings.service';
import { AuthenticatedRequest } from '../types';
import { ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';

// ============================================
// Validation schemas
// ============================================

/**
 * Preprocess: "" → undefined.
 * Permite ao frontend enviar campos vazios sem sobrescrever valores existentes.
 */
const emptyToUndefined = (val: unknown): unknown => {
  if (typeof val === 'string' && val.trim() === '') return undefined;
  return val;
};

const updateSystemSettingsSchema = z.object({
  evolutionBaseUrl: z.preprocess(
    emptyToUndefined,
    z.string().url('evolutionBaseUrl deve ser uma URL válida').optional()
  ),
  evolutionApiKey: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional()
  ),
  evolutionWebhookUrl: z.preprocess(
    emptyToUndefined,
    z.string().url('evolutionWebhookUrl deve ser uma URL válida').optional()
  ),
});

export type UpdateSystemSettingsInput = z.infer<typeof updateSystemSettingsSchema>;

// ============================================
// Controller
// ============================================

export class SystemSettingsController {
  /**
   * GET /api/system-settings
   * Retorna configurações globais. API key é mascarada (***SET*** se preenchida, null se não).
   */
  async get(req: AuthenticatedRequest, res: ExpressResponse, next: NextFunction): Promise<void> {
    try {
      const settings = await systemSettingsService.get();

      const hasKey = Boolean(settings?.evolutionApiKey && settings.evolutionApiKey.length > 0);

      res.json({
        data: {
          id: settings?.id ?? 'singleton',
          evolutionBaseUrl: settings?.evolutionBaseUrl ?? null,
          evolutionApiKey: hasKey ? '***SET***' : null,
          evolutionWebhookUrl: settings?.evolutionWebhookUrl ?? null,
          createdAt: settings?.createdAt ?? null,
          updatedAt: settings?.updatedAt ?? null,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/system-settings
   * Body: { evolutionBaseUrl?, evolutionApiKey?, evolutionWebhookUrl? }
   *
   * Regras:
   *  - "" no body → tratado como undefined (não altera o campo)
   *  - URLs validadas via z.string().url()
   *  - Se evolutionApiKey não vier (ou vier vazio) e já existir uma chave salva,
   *    a chave atual é mantida (não substitui por null).
   */
  async update(req: AuthenticatedRequest, res: ExpressResponse, next: NextFunction): Promise<void> {
    try {
      const parsed = updateSystemSettingsSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ValidationError('Payload inválido', {
          issues: parsed.error.flatten(),
        });
      }

      const body = parsed.data;
      const current = await systemSettingsService.get();
      const currentHasKey = Boolean(current?.evolutionApiKey && current.evolutionApiKey.length > 0);

      // Monta payload final: apenas campos definidos são atualizados.
      const patch: Record<string, string | null> = {};

      if (body.evolutionBaseUrl !== undefined) {
        patch.evolutionBaseUrl = body.evolutionBaseUrl;
      }
      if (body.evolutionWebhookUrl !== undefined) {
        patch.evolutionWebhookUrl = body.evolutionWebhookUrl;
      }
      // Para a API key: só atualiza se o cliente enviou um valor real.
      // Se vier undefined (ou "" → undefined) e já houver chave, mantém a atual.
      if (body.evolutionApiKey !== undefined) {
        patch.evolutionApiKey = body.evolutionApiKey;
      } else if (!currentHasKey) {
        // Não havia chave e cliente não enviou: mantém null (sem mudança real).
      }

      const updated = await systemSettingsService.update(patch);

      const hasKey = Boolean(updated?.evolutionApiKey && updated.evolutionApiKey.length > 0);

      logger.info('SystemSettings atualizado', {
        userId: req.user?.id,
        fields: Object.keys(patch),
      });

      res.json({
        data: {
          id: updated.id,
          evolutionBaseUrl: updated.evolutionBaseUrl ?? null,
          evolutionApiKey: hasKey ? '***SET***' : null,
          evolutionWebhookUrl: updated.evolutionWebhookUrl ?? null,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/system-settings/test-evolution
   * Faz um GET em {baseUrl}/instance/fetchInstances com header apikey
   * para validar conectividade. Retorna { ok, instanceCount, error? }.
   *
   * Usa as credenciais persistidas (não aceita override no body por hora).
   */
  async testEvolution(req: AuthenticatedRequest, res: ExpressResponse, next: NextFunction): Promise<void> {
    try {
      const settings = await systemSettingsService.get();

      const baseUrl = settings?.evolutionBaseUrl?.replace(/\/$/, '');
      const apiKey = settings?.evolutionApiKey;

      if (!baseUrl || !apiKey) {
        res.json({
          data: {
            ok: false,
            instanceCount: 0,
            error: 'Configuração incompleta: evolutionBaseUrl e evolutionApiKey são obrigatórios',
          },
        });
        return;
      }

      const url = `${baseUrl}/instance/fetchInstances`;

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: {
            apikey: apiKey,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(15000),
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Erro desconhecido';
        logger.warn('Evolution test falhou (network)', { url, error: msg });
        res.json({
          data: {
            ok: false,
            instanceCount: 0,
            error: `Falha de conexão: ${msg}`,
          },
        });
        return;
      }

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        logger.warn('Evolution test falhou (status)', {
          url,
          status: response.status,
          body: bodyText.slice(0, 200),
        });
        res.json({
          data: {
            ok: false,
            instanceCount: 0,
            error: `Evolution API retornou status ${response.status}`,
          },
        });
        return;
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = [];
      }

      const instanceCount = Array.isArray(payload) ? payload.length : 0;

      res.json({
        data: {
          ok: true,
          instanceCount,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

export const systemSettingsController = new SystemSettingsController();

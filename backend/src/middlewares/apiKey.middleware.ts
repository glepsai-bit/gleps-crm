import { Request, Response, NextFunction } from 'express';
import { apiKeyService } from '../services/api-key.service';

/* ============================================================================
 * TODO(t022-future): scopes são placeholder. Toda API key tem god-mode no
 * escopo da sua conta. Implementar requireScope() antes de produção sensível.
 *
 * Hoje:
 *   - O middleware abaixo apenas valida que a chave é válida e não-revogada,
 *     e popula req.apiKey + req.accountId.
 *   - O campo `scopes` é carregado do banco mas NUNCA é checado em nenhum
 *     endpoint. Qualquer chave válida pode chamar qualquer rota protegida
 *     por requireApiKey dentro do escopo da accountId dona da chave.
 *
 * Plano:
 *   1. Definir taxonomia de scopes (ex: "leads:read", "leads:write",
 *      "messages:send", "metrics:read", "*").
 *   2. Adicionar requireScope(...allowed: string[]) que rejeita 403 se
 *      req.apiKey.scopes não tiver intersecção com `allowed` (ou "*").
 *   3. Anotar cada rota sensível com requireScope(...).
 *   4. Reabilitar input de scopes na UI e validar no controller.
 *
 * Até lá: input de scopes foi removido da UI e o service força [] no insert.
 * ========================================================================= */

// Declaration merging: extend Express Request with apiKey + accountId fields
declare module 'express-serve-static-core' {
  interface Request {
    apiKey?: {
      id: string;
      accountId: string;
      scopes: string[];
    };
    accountId?: string;
  }
}

/**
 * Middleware to require a valid API key.
 * Accepts:
 *   - Authorization: Bearer <key>
 *   - x-api-key: <key>
 */
export async function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    let key: string | undefined;

    const authHeader = req.headers.authorization;
    if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      key = authHeader.substring(7).trim();
    }

    if (!key) {
      const headerKey = req.headers['x-api-key'];
      if (typeof headerKey === 'string' && headerKey.trim()) {
        key = headerKey.trim();
      }
    }

    if (!key) {
      res.status(401).json({ error: 'API key inválida ou revogada' });
      return;
    }

    const validated = await apiKeyService.validate(key);

    if (!validated) {
      res.status(401).json({ error: 'API key inválida ou revogada' });
      return;
    }

    req.apiKey = {
      id: validated.id,
      accountId: validated.accountId,
      scopes: validated.scopes,
    };
    req.accountId = validated.accountId;

    next();
  } catch (error) {
    next(error);
  }
}

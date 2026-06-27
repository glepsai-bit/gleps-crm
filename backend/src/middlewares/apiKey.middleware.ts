import { Request, Response, NextFunction } from 'express';
import { apiKeyService } from '../services/api-key.service';

/* ============================================================================
 * Scopes de API key (T-022 / CHAT-AUTH-H3)
 *
 * Modelo de autorização para chaves de integração (n8n, agentes IA externos):
 *
 *   - "*"                    → super-scope (god-mode dentro da accountId).
 *                              Só deve ser concedido a chaves administrativas.
 *   - "messages:write"       → envia mensagens públicas (chat / WhatsApp via
 *                              Evolution) em nome da conta.
 *   - "messages:notes"       → cria notas internas (isPrivate=true). É um
 *                              scope SEPARADO porque permite falsificar
 *                              histórico interno e por isso não deve vazar
 *                              em chaves de bot público.
 *   - "contacts:read"        → leitura do catálogo de contatos via API.
 *   - "campaigns:write"      → dispara campanhas WhatsApp (send-single /
 *                              send-batch).
 *   - "campaigns:read"       → leitura de lotes de campanha.
 *   - "kanban:write"         → move leads entre etapas do funil via
 *                              /api/integrations/kanban/leads/:leadId/stage.
 *                              Aceita também "leads:write" como alias
 *                              (semântica alinhada às permissões JWT).
 *   - "kanban:read"          → lista etapas disponíveis. Aceita
 *                              "leads:read", "kanban:write", "leads:write".
 *
 * Comportamento:
 *   - requireApiKey valida que a chave é válida/não-revogada e popula
 *     req.apiKey + req.accountId.
 *   - requireScope(...allowed) deve ser montado DEPOIS de requireApiKey em
 *     toda rota sensível. Aceita a chamada se req.apiKey.scopes contém "*"
 *     ou intersecta com `allowed`. Caso contrário 403.
 *
 * Compatibilidade:
 *   - Chaves antigas foram criadas com scopes=[] (god-mode implícito no
 *     middleware antigo). Para não quebrar integrações em produção sem
 *     migração, scopes=[] é tratado como scopes=["*"] APENAS quando a flag
 *     LEGACY_API_KEY_GOD_MODE=true. O default é negar (seguro).
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
      scopes: Array.isArray(validated.scopes) ? validated.scopes : [],
    };
    req.accountId = validated.accountId;

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Verifica se a chave possui pelo menos um dos scopes pedidos.
 * "*" é coringa e satisfaz qualquer requisito.
 *
 * Chaves com scopes=[] são tratadas como NEGADAS, exceto quando a env
 * LEGACY_API_KEY_GOD_MODE=true (modo de transição para compatibilidade com
 * chaves emitidas antes do T-022 endurecer o middleware).
 */
export function apiKeyHasScope(
  scopes: string[] | undefined,
  allowed: readonly string[]
): boolean {
  if (!allowed || allowed.length === 0) return true;
  const owned = Array.isArray(scopes) ? scopes : [];

  if (owned.length === 0) {
    return process.env.LEGACY_API_KEY_GOD_MODE === 'true';
  }

  if (owned.includes('*')) return true;
  return allowed.some(scope => owned.includes(scope));
}

/**
 * Middleware factory: exige que a chave já validada possua ao menos um dos
 * `allowed` scopes. Deve ser montado DEPOIS de requireApiKey.
 *
 * Ex:
 *   router.use(requireApiKey);
 *   router.post('/messages', requireScope('messages:write'), handler);
 */
export function requireScope(...allowed: string[]) {
  return function requireScopeMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    if (!req.apiKey) {
      res.status(401).json({ error: 'API key inválida ou revogada' });
      return;
    }

    if (!apiKeyHasScope(req.apiKey.scopes, allowed)) {
      res.status(403).json({
        error: 'API key sem permissão para esta operação',
        code: 'API_KEY_SCOPE_DENIED',
        requiredScopes: allowed,
      });
      return;
    }

    next();
  };
}

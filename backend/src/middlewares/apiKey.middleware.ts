import { Request, Response, NextFunction } from 'express';
import { apiKeyService } from '../services/api-key.service';

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

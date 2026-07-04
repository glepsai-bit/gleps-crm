/**
 * push.routes.ts — Web Push subscription/unsubscription endpoints
 *
 * GET    /api/push/vapid-public   — devolve VAPID publicKey (auth JWT)
 * POST   /api/push/subscribe      — salva subscription do browser autenticado
 * DELETE /api/push/unsubscribe    — remove subscription por endpoint
 *
 * Todas as rotas exigem JWT. Nao exigimos requireAccountId aqui porque a
 * feature vale ate mesmo pra super_admin (que pode nao ter conta escopada)
 * — o vinculo eh sempre por userId.
 */

import { Router, Response, NextFunction } from 'express';
import { pushService } from '../services/push.service';
import { authenticate } from '../middlewares/auth.middleware';
import type { AuthenticatedRequest } from '../types';
import { logger } from '../utils/logger';

const router = Router();

router.use(authenticate);

// GET /api/push/vapid-public
router.get('/vapid-public', (req: AuthenticatedRequest, res: Response) => {
  const publicKey = pushService.getPublicKey();
  if (!publicKey) {
    // 200 com enabled=false — frontend fica silencioso quando VAPID nao
    // foi configurada (feature opcional).
    res.json({ enabled: false, publicKey: null });
    return;
  }
  res.json({ enabled: true, publicKey });
});

// POST /api/push/subscribe
router.post('/subscribe', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Nao autenticado' } });
      return;
    }
    const { endpoint, keys } = (req.body ?? {}) as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      res.status(400).json({
        error: {
          code: 'INVALID_SUBSCRIPTION',
          message: 'endpoint e keys.p256dh/auth sao obrigatorios',
        },
      });
      return;
    }
    const userAgent = req.headers['user-agent'] ?? null;
    const result = await pushService.subscribe(req.user.id, {
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      userAgent: typeof userAgent === 'string' ? userAgent : null,
    });
    res.status(201).json({ id: result.id });
  } catch (err) {
    logger.warn('[push.routes] subscribe falhou', {
      error: err instanceof Error ? err.message : String(err),
    });
    next(err);
  }
});

// DELETE /api/push/unsubscribe
router.delete(
  '/unsubscribe',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { endpoint } = (req.body ?? {}) as { endpoint?: string };
      if (!endpoint) {
        res
          .status(400)
          .json({ error: { code: 'INVALID_ENDPOINT', message: 'endpoint obrigatorio' } });
        return;
      }
      const result = await pushService.unsubscribe(endpoint);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

export default router;

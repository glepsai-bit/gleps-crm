import { Router } from 'express';
import { slaController } from '../controllers/sla.controller';
import { authenticate, requireAccountId, requireRole } from '../middlewares/auth.middleware';

// ============================================
// Router para /api/sla-policies (CRUD + breaches recentes)
// ============================================
//
// Todas as rotas exigem autenticacao e role super_admin OU admin.
// O controller faz a verificacao fina de "admin so da propria conta"
// (via resolveAccountId, que forca ?accountId= apenas para super_admin),
// seguindo o mesmo padrao do webhook-outbound.routes.
const router = Router();

router.use(authenticate, requireRole('super_admin', 'admin'));

router.get('/', (req, res, next) => slaController.list(req, res, next));

router.post('/', (req, res, next) => slaController.create(req, res, next));

router.get('/:id', (req, res, next) => slaController.get(req, res, next));

router.patch('/:id', (req, res, next) => slaController.update(req, res, next));

router.delete('/:id', (req, res, next) => slaController.delete(req, res, next));

router.get('/:id/breaches', (req, res, next) =>
  slaController.listRecentBreaches(req, res, next)
);

export default router;

// ============================================
// Router auxiliar para /api/conversations/:id/sla
// ============================================
//
// Exposto como named export para que o index das rotas possa montar
// em '/conversations' (mesma estrategia de adminRouter em dashboard.routes
// e funnelRouter em tag.routes).
const conversationsRouter = Router();

conversationsRouter.use(authenticate, requireAccountId, requireRole('super_admin', 'admin'));

conversationsRouter.post('/:id/sla', (req, res, next) =>
  slaController.applyToConversation(req, res, next)
);

export { conversationsRouter };

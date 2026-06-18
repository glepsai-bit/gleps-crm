import { Router } from 'express';
import { accountController } from '../controllers/account.controller';
import { authenticate, requireSuperAdmin, verifyPassword } from '../middlewares/auth.middleware';

const router = Router();

// Todas as rotas exigem auth. Quase todas tambem exigem super_admin —
// EXCETO PUT /:id, que em T-019 passou a aceitar admin da propria conta
// (controller faz o gate fino + allowlist de campos editaveis).
router.use(authenticate);

router.get('/', requireSuperAdmin, (req, res, next) => accountController.list(req, res, next));
router.post('/', requireSuperAdmin, (req, res, next) => accountController.create(req, res, next));
router.get('/:id', requireSuperAdmin, (req, res, next) => accountController.getById(req, res, next));
// PUT: gate de role/ownership feito dentro do controller (super_admin | admin-da-conta).
router.put('/:id', (req, res, next) => accountController.update(req, res, next));
router.delete('/:id', requireSuperAdmin, verifyPassword, (req, res, next) => accountController.delete(req, res, next));

router.post('/:id/pause', requireSuperAdmin, (req, res, next) => accountController.pause(req, res, next));
router.post('/:id/activate', requireSuperAdmin, (req, res, next) => accountController.activate(req, res, next));
router.get('/:id/stats', requireSuperAdmin, (req, res, next) => accountController.getStats(req, res, next));

router.post('/:id/test-chatwoot', requireSuperAdmin, (req, res, next) => accountController.testChatwoot(req, res, next));
router.get('/:id/chatwoot-agents', requireSuperAdmin, (req, res, next) => accountController.getChatwootAgents(req, res, next));

export default router;

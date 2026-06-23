import { Router } from 'express';
import { webhookOutboundController } from '../controllers/webhook-outbound.controller';
import { authenticate, requireRole } from '../middlewares/auth.middleware';

const router = Router();

// Todas as rotas exigem autenticação e role super_admin OU admin.
// O controller faz a verificação fina de "admin só da própria conta"
// (via resolveAccountId, que força ?accountId= apenas para super_admin).
router.use(authenticate, requireRole('super_admin', 'admin'));

router.get('/', (req, res, next) => webhookOutboundController.list(req, res, next));

router.post('/', (req, res, next) => webhookOutboundController.create(req, res, next));

router.get('/:id', (req, res, next) => webhookOutboundController.get(req, res, next));

router.patch('/:id', (req, res, next) => webhookOutboundController.update(req, res, next));

router.delete('/:id', (req, res, next) => webhookOutboundController.delete(req, res, next));

router.get('/:id/deliveries', (req, res, next) =>
  webhookOutboundController.listDeliveries(req, res, next)
);

router.post('/:id/test', (req, res, next) => webhookOutboundController.test(req, res, next));

export default router;

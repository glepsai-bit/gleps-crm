import { Router } from 'express';
import { apiKeyController } from '../controllers/api-key.controller';
import { authenticate, requireRole } from '../middlewares/auth.middleware';

const router = Router();

// Todas as rotas exigem autenticação e role super_admin OU admin.
// O controller faz a verificação fina de "admin só da própria conta".
router.use(authenticate, requireRole('super_admin', 'admin'));

router.get('/accounts/:accountId', (req, res, next) =>
  apiKeyController.list(req, res, next)
);

router.post('/accounts/:accountId', (req, res, next) =>
  apiKeyController.generate(req, res, next)
);

router.delete('/:id', (req, res, next) =>
  apiKeyController.revoke(req, res, next)
);

export default router;

import { Router } from 'express';
import { inboxChannelController } from '../controllers/inbox.controller';
import {
  authenticate,
  requireRole,
  requireAccountId,
} from '../middlewares/auth.middleware';

const router = Router();

// ============================================
// CRUD de Inboxes (canais de atendimento — T-022)
// JWT + (super_admin ou admin) + accountId obrigatório.
// ============================================
router.use(authenticate);
router.use(requireRole('super_admin', 'admin'));
router.use(requireAccountId);

router.get('/', (req, res, next) =>
  inboxChannelController.list(req, res, next)
);

router.post('/', (req, res, next) =>
  inboxChannelController.create(req, res, next)
);

router.get('/:id', (req, res, next) =>
  inboxChannelController.getById(req, res, next)
);

router.put('/:id', (req, res, next) =>
  inboxChannelController.update(req, res, next)
);

router.delete('/:id', (req, res, next) =>
  inboxChannelController.delete(req, res, next)
);

export default router;

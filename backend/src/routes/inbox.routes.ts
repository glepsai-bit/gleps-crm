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
// JWT + accountId obrigatório para todas as rotas.
// Leitura (GET) liberada para agent (necessário p/ filtros/badges no Chat UI).
// Mutação (POST/PUT/DELETE) restrita a super_admin/admin.
// ============================================
router.use(authenticate);
router.use(requireAccountId);

// Leitura — liberada para agent, admin e super_admin
router.get('/', (req, res, next) =>
  inboxChannelController.list(req, res, next)
);

router.get('/:id', (req, res, next) =>
  inboxChannelController.getById(req, res, next)
);

// Mutação — restrita a super_admin/admin
router.post('/', requireRole('super_admin', 'admin'), (req, res, next) =>
  inboxChannelController.create(req, res, next)
);

router.put('/:id', requireRole('super_admin', 'admin'), (req, res, next) =>
  inboxChannelController.update(req, res, next)
);

router.delete('/:id', requireRole('super_admin', 'admin'), (req, res, next) =>
  inboxChannelController.delete(req, res, next)
);

export default router;

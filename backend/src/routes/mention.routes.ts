import { Router } from 'express';
import {
  authenticate,
  requireAccountId,
  requireRole,
} from '../middlewares/auth.middleware';
import { mentionController } from '../controllers/mention.controller';

// ============================================
// /api/mentions — histórico de menções ao usuário autenticado
// ============================================
// Complementa o socket emit `mention:new` (T-022 Sprint 4) fornecendo o
// snapshot inicial quando o AdminLayout monta.

const router = Router();

router.use(authenticate);
router.use(requireRole('super_admin', 'admin', 'agent'));
router.use(requireAccountId);

router.get('/', (req, res, next) => mentionController.list(req, res, next));
router.patch('/:id/read', (req, res, next) =>
  mentionController.markRead(req, res, next)
);

export default router;

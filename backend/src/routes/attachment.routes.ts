/**
 * Attachment routes — Bug A (T-022)
 *
 * GET /api/attachments/:id
 *   Streama a mídia anexada a uma Message. JWT obrigatório + RBAC por
 *   conta (controller valida que attachment pertence à accountId do usuário).
 */

import { Router } from 'express';
import { attachmentController } from '../controllers/attachment.controller';
import { authenticate, requireAccountId } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticate);
router.use(requireAccountId);

router.get('/:id', (req, res, next) => attachmentController.stream(req, res, next));

export default router;

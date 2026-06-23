import { Router } from 'express';
import { whatsappTemplateController } from '../controllers/whatsapp-template.controller';
import {
  authenticate,
  requireAccountId,
  requirePermission,
  requireRole,
} from '../middlewares/auth.middleware';

const router = Router();

// All routes require authentication and an account context
router.use(authenticate);
router.use(requireRole('super_admin', 'admin'));
router.use(requireAccountId);

router.get('/', requirePermission('emails'), (req, res, next) =>
  whatsappTemplateController.list(req, res, next)
);
router.post('/', requirePermission('emails'), (req, res, next) =>
  whatsappTemplateController.create(req, res, next)
);
router.get('/:id', requirePermission('emails'), (req, res, next) =>
  whatsappTemplateController.get(req, res, next)
);
router.patch('/:id', requirePermission('emails'), (req, res, next) =>
  whatsappTemplateController.update(req, res, next)
);
router.delete('/:id', requirePermission('emails'), (req, res, next) =>
  whatsappTemplateController.delete(req, res, next)
);

export default router;

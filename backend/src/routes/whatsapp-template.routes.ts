import { Router } from 'express';
import { whatsappTemplateController } from '../controllers/whatsapp-template.controller';
import {
  authenticate,
  requireAccountId,
  requirePermission,
} from '../middlewares/auth.middleware';

const router = Router();

// All routes require authentication and an account context
router.use(authenticate);
router.use(requireAccountId);

router.get('/', requirePermission('campaigns', 'emails'), (req, res, next) =>
  whatsappTemplateController.list(req, res, next)
);
router.post('/', requirePermission('campaigns', 'emails'), (req, res, next) =>
  whatsappTemplateController.create(req, res, next)
);
router.get('/:id', requirePermission('campaigns', 'emails'), (req, res, next) =>
  whatsappTemplateController.get(req, res, next)
);
router.patch('/:id', requirePermission('campaigns', 'emails'), (req, res, next) =>
  whatsappTemplateController.update(req, res, next)
);
router.delete('/:id', requirePermission('campaigns', 'emails'), (req, res, next) =>
  whatsappTemplateController.delete(req, res, next)
);

export default router;

import { Router } from 'express';
import { systemSettingsController } from '../controllers/system-settings.controller';
import { authenticate, requireRole } from '../middlewares/auth.middleware';

const router = Router();

// Configurações globais do sistema — somente super_admin.
router.use(authenticate);
router.use(requireRole('super_admin'));

router.get('/', (req, res, next) => systemSettingsController.get(req, res, next));
router.patch('/', (req, res, next) => systemSettingsController.update(req, res, next));
router.post('/test-evolution', (req, res, next) =>
  systemSettingsController.testEvolution(req, res, next)
);

export default router;

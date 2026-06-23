import { Router } from 'express';
import { authenticate, requireRole } from '../middlewares/auth.middleware';
import { whatsappConsentController } from '../controllers/whatsapp-consent.controller';

// ============================================
// Router — autenticado via Bearer JWT
// ============================================

const router = Router();
router.use(authenticate);
router.use(requireRole('super_admin', 'admin'));

// GET /api/whatsapp-consents/export?format=csv
// Declarado ANTES de qualquer rota dinâmica para evitar colisão de matching.
router.get('/export', (req, res, next) =>
  whatsappConsentController.exportCsv(req, res, next)
);

// POST /api/whatsapp-consents/check-batch
// Declarado ANTES das rotas dinâmicas (/:contactIdOrPhone/...) para evitar
// que "check-batch" seja interpretado como um contactIdOrPhone.
router.post('/check-batch', (req, res, next) =>
  whatsappConsentController.checkBatch(req, res, next)
);

// GET /api/whatsapp-consents?status=opted_out&search=&fromDate=&toDate=
router.get('/', (req, res, next) =>
  whatsappConsentController.listOptedOut(req, res, next)
);

// POST /api/whatsapp-consents/:contactIdOrPhone/opt-in
router.post('/:contactIdOrPhone/opt-in', (req, res, next) =>
  whatsappConsentController.optIn(req, res, next)
);

// POST /api/whatsapp-consents/:contactIdOrPhone/opt-out
router.post('/:contactIdOrPhone/opt-out', (req, res, next) =>
  whatsappConsentController.optOut(req, res, next)
);

export default router;

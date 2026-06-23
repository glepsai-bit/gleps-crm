import { Router } from 'express';
import { inboundIntegrationController } from '../controllers/inbound-integration.controller';
import { authenticate } from '../middlewares/auth.middleware';

// ============================================
// JWT router — CRUD (autenticado)
// ============================================

export const jwtRouter = Router();
jwtRouter.use(authenticate);

jwtRouter.get('/', (req, res, next) =>
  inboundIntegrationController.list(req, res, next)
);

jwtRouter.post('/', (req, res, next) =>
  inboundIntegrationController.create(req, res, next)
);

jwtRouter.delete('/:slug', (req, res, next) =>
  inboundIntegrationController.delete(req, res, next)
);

// ============================================
// Public router — webhook receiver
// Auth via HMAC (opcional) dentro do service
// ============================================

export const publicRouter = Router();

publicRouter.post('/:accountId/:slug', (req, res, next) =>
  inboundIntegrationController.receive(req, res, next)
);

export default jwtRouter;

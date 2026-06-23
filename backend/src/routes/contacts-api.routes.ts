import { Router } from 'express';
import { requireApiKey, requireScope } from '../middlewares/apiKey.middleware';
import { contactController } from '../controllers/contact.controller';

const router = Router();
router.use(requireApiKey);
router.get('/', requireScope('contacts:read'), (req, res, next) =>
  contactController.queryForApi(req, res, next)
);

export default router;

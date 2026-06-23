import { Router } from 'express';
import { requireApiKey } from '../middlewares/apiKey.middleware';
import { contactController } from '../controllers/contact.controller';

const router = Router();
router.use(requireApiKey);
router.get('/', (req, res, next) => contactController.queryForApi(req, res, next));

export default router;

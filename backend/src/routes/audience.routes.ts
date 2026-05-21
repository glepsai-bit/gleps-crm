import { Router } from 'express';
import { audienceController } from '../controllers/audience.controller';
import { authenticate, requirePermission, requireAccountId } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticate);
router.use(requireAccountId);

// Audiences CRUD
router.get('/', requirePermission('emails'), (req, res, next) => audienceController.list(req, res, next));
router.post('/', requirePermission('emails'), (req, res, next) => audienceController.create(req, res, next));
router.get('/:id', requirePermission('emails'), (req, res, next) => audienceController.get(req, res, next));
router.put('/:id', requirePermission('emails'), (req, res, next) => audienceController.update(req, res, next));
router.delete('/:id', requirePermission('emails'), (req, res, next) => audienceController.delete(req, res, next));

// Audience contacts
router.get('/:id/contacts', requirePermission('emails'), (req, res, next) => audienceController.listContacts(req, res, next));
router.post('/:id/contacts', requirePermission('emails'), (req, res, next) => audienceController.addContacts(req, res, next));
router.delete('/:id/contacts/:contactId', requirePermission('emails'), (req, res, next) => audienceController.removeContact(req, res, next));
router.post('/:id/import', requirePermission('emails'), (req, res, next) => audienceController.importContacts(req, res, next));

export default router;

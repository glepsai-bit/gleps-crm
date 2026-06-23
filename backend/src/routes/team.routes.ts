import { Router } from 'express';
import { teamController } from '../controllers/team.controller';
import {
  authenticate,
  requireAdmin,
  requireAccountId,
} from '../middlewares/auth.middleware';

const router = Router();

// All routes require authentication + a bound account.
router.use(authenticate);
router.use(requireAccountId);

// Logged-in user's own teams — must come BEFORE '/:id' to avoid being shadowed.
router.get('/by-user/me', (req, res, next) => teamController.listByMe(req, res, next));

// CRUD
router.get('/', (req, res, next) => teamController.list(req, res, next));
router.post('/', requireAdmin, (req, res, next) => teamController.create(req, res, next));
router.get('/:id', (req, res, next) => teamController.getById(req, res, next));
router.patch('/:id', requireAdmin, (req, res, next) => teamController.update(req, res, next));
router.delete('/:id', requireAdmin, (req, res, next) => teamController.delete(req, res, next));

// Membership (admin OR leader of the team — checked inside the controller)
router.post('/:id/members', (req, res, next) => teamController.addMember(req, res, next));
router.delete('/:id/members/:userId', (req, res, next) =>
  teamController.removeMember(req, res, next)
);

export default router;

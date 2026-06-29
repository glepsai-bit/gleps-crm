import { Router } from 'express';
import { conversationController } from '../controllers/conversation.controller';
import {
  authenticate,
  requireAccountId,
  requireRole,
} from '../middlewares/auth.middleware';

const router = Router();

// Todas as rotas exigem JWT + accountId + role (admin/super_admin/agent)
router.use(authenticate);
router.use(requireAccountId);
router.use(requireRole('super_admin', 'admin', 'agent'));

// ============================================
// Listagem / leitura
// ============================================

router.get('/', (req, res, next) => conversationController.list(req, res, next));
router.get('/:id', (req, res, next) => conversationController.get(req, res, next));

// ============================================
// Create (admin manual)
// ============================================

router.post('/', (req, res, next) => conversationController.create(req, res, next));

// ============================================
// Status / prioridade
// ============================================

router.patch('/:id/status', (req, res, next) =>
  conversationController.updateStatus(req, res, next)
);
router.patch('/:id/priority', (req, res, next) =>
  conversationController.updatePriority(req, res, next)
);

// ============================================
// Atribuição / transferência
// ============================================

router.post('/:id/assign', (req, res, next) =>
  conversationController.assign(req, res, next)
);
router.post('/:id/assign-team', (req, res, next) =>
  conversationController.assignTeam(req, res, next)
);
router.post('/:id/transfer', (req, res, next) =>
  conversationController.transfer(req, res, next)
);

// ============================================
// Ciclo de vida
// ============================================

router.post('/:id/snooze', (req, res, next) =>
  conversationController.snooze(req, res, next)
);
router.post('/:id/resolve', (req, res, next) =>
  conversationController.resolve(req, res, next)
);
router.post('/:id/reopen', (req, res, next) =>
  conversationController.reopen(req, res, next)
);

// SLA v2.1 — dispara CSAT imediato (botao "Pedir avaliacao" na UI)
router.post('/:id/send-csat', (req, res, next) =>
  conversationController.sendCsat(req, res, next)
);

// ============================================
// Labels
// ============================================

router.post('/:id/labels', (req, res, next) =>
  conversationController.addLabel(req, res, next)
);
router.delete('/:id/labels/:tagId', (req, res, next) =>
  conversationController.removeLabel(req, res, next)
);

// ============================================
// Participants
// ============================================

router.post('/:id/participants', (req, res, next) =>
  conversationController.addParticipant(req, res, next)
);
router.delete('/:id/participants/:userId', (req, res, next) =>
  conversationController.removeParticipant(req, res, next)
);

// ============================================
// Atributos customizados / leitura
// ============================================

router.patch('/:id/custom-attributes', (req, res, next) =>
  conversationController.setCustomAttributes(req, res, next)
);
router.post('/:id/read', (req, res, next) =>
  conversationController.markAsRead(req, res, next)
);

// ============================================
// Cycles (Bug B) — histórico de ConversationCycle
// ============================================

router.get('/:id/cycles', (req, res, next) =>
  conversationController.listCycles(req, res, next)
);

export default router;

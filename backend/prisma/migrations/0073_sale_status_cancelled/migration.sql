-- 0073 — Etapa E: "Perdido" cancela a venda pendente do fechamento.
-- A venda que nasceu quando o lead entrou em Fechado (origem 'fechamento',
-- status 'pending', valor 0) vira 'cancelled' quando o lead vai pra Perdido —
-- sem Purchase, sem webhook de pago, e o Kanban deixa de pedir o valor.
--
-- Fora de DO/transação: ADD VALUE não pode ser usado na mesma transação em
-- que foi criado. IF NOT EXISTS torna idempotente (start.sh reaplica no boot).
ALTER TYPE "SaleStatus" ADD VALUE IF NOT EXISTS 'cancelled';

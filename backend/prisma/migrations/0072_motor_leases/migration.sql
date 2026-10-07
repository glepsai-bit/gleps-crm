-- 0072 — lease dos motores (aquecimento) em tabela, em vez de advisory lock
-- segurando uma conexão do pool numa transação de vários minutos.
-- Idempotente: start.sh reaplica no boot.
CREATE TABLE IF NOT EXISTS motor_leases (
  nome VARCHAR(60) PRIMARY KEY,
  ate  TIMESTAMPTZ NOT NULL DEFAULT now(),
  dono TEXT NULL
);

INSERT INTO motor_leases (nome, ate)
VALUES ('aquecimento-tick', now() - interval '1 second')
ON CONFLICT (nome) DO NOTHING;

-- T-029b — Discador via SIP sobre WebSocket.
--
-- Alternativa à Twilio: provedores nacionais vendem plano fechado (ilimitado
-- para fixo e celular) por uma fração do custo por minuto do varejo de API.
-- Quando o provedor suporta SIP sobre WebSocket, o navegador conecta DIRETO
-- nele — sem Asterisk, sem servidor de mídia, sem webhook de status.
--
-- Idempotente: start.sh roda no boot mesmo se `migrate deploy` falhar.

ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "voice_provider" VARCHAR(20) NOT NULL DEFAULT 'sip';
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "sip_ws_server"  VARCHAR(300);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "sip_domain"     VARCHAR(200);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "sip_username"   VARCHAR(120);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "sip_password"   VARCHAR(200);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "sip_caller_id"  VARCHAR(30);

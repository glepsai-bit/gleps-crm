-- Foto de perfil do contato (WhatsApp Business avatar).
-- Populada pelo evolutionService.fetchProfilePictureUrl no primeiro contato
-- via findOrCreateForCustomer + refresh periodico (24h).
-- Text pra caber URLs longas do WhatsApp CDN (mmg.whatsapp.net com queries).
-- Colunas sao nullable e idempotentes (IF NOT EXISTS) — sao apenas anexadas.
ALTER TABLE "contacts"
  ADD COLUMN IF NOT EXISTS "profile_pic_url" TEXT,
  ADD COLUMN IF NOT EXISTS "profile_pic_fetched_at" TIMESTAMPTZ;

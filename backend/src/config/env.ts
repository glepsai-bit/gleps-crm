import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  // Application
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).default('3000'),
  API_URL: z.string().url().default('http://localhost:3000'),
  /**
   * URL base pública usada para derivar o webhookUrl que enviamos pra Evolution.
   * Se ausente, cai em API_URL. Em dev, dá pra apontar pra um túnel
   * (ngrok/cloudflared) ou pra `http://host.docker.internal:3010` quando
   * a Evolution roda em container e o backend roda no host.
   */
  WEBHOOK_BASE_URL: z.string().url().optional(),
  FRONTEND_URL: z.string().url().default('http://localhost:8080'),

  // Database
  DATABASE_URL: z.string().url(),

  // JWT
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('1h'),
  REFRESH_TOKEN_SECRET: z.string().min(32),
  REFRESH_TOKEN_EXPIRES_IN: z.string().default('7d'),

  // Password
  BCRYPT_SALT_ROUNDS: z.string().transform(Number).default('12'),

  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: z.string().transform(Number).default('900000'),
  RATE_LIMIT_MAX: z.string().transform(Number).default('300'),

  // CORS (optional - comma-separated origins)
  CORS_ORIGINS: z.string().optional(),

  // Evolution webhook hardening (optional)
  // EVOLUTION_ALLOWED_IPS: comma-separated allow-list (CIDR or exact IPv4/IPv6).
  //   Quando definido, requests vindas de IPs fora dessa lista são rejeitadas (401).
  // EVOLUTION_WEBHOOK_TOKEN: token bearer fixo aceito via header x-evolution-token.
  //   Útil para Evolution API v2 que NÃO calcula HMAC sobre o body — repassa apenas
  //   headers fixos configurados em webhook.headers.
  // EVOLUTION_HMAC_REQUIRED: 'true' força HMAC obrigatório mesmo em dev (default: prod=true, dev=false).
  EVOLUTION_ALLOWED_IPS: z.string().optional(),
  EVOLUTION_WEBHOOK_TOKEN: z.string().optional(),
  EVOLUTION_HMAC_REQUIRED: z
    .enum(['true', 'false'])
    .optional(),

  // RapidAPI (for prospecting) — sem fallback hardcoded.
  // Se ausente, prospecting endpoints retornam 503 (fail-loud) — não há mais
  // chave embutida no código.
  RAPIDAPI_KEY: z.string().optional(),

  // Encryption key for sensitive fields at rest (AES-256-GCM).
  // Formato: hex (64 chars = 32 bytes) ou base64 (32 bytes decoded).
  // Em produção é OBRIGATÓRIA — usada para criptografar Google OAuth tokens
  // e outros segredos persistidos. Em dev/test pode ser omitida (operações
  // que dependem dela falham com mensagem clara).
  ENCRYPTION_KEY: z.string().optional(),

  // Logging
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Warmup AI providers (T-023 Fase 2) — TODAS opcionais.
  // Se a chave de um provider estiver vazia, o provider eh marcado disabled
  // e o registry ignora ele; a geracao cai pra template automaticamente.
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  WARMUP_AI_TIMEOUT_MS: z.string().transform(Number).default('5000'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';

// Soft validation: ENCRYPTION_KEY eh OPCIONAL. So eh USADA para criptografar
// tokens OAuth do Google Calendar (T-026). Se ausente, o app sobe normalmente
// e SOMENTE o fluxo OAuth do Calendar vai falhar — com erro claro na hora
// (utils/encryption.ts ja lanca se chave faltar e algo tentar criptografar).
//
// Antes essa validacao matava o processo em prod (process.exit(1)), o que
// derrubava o backend inteiro mesmo pra quem nao usa Calendar. Trocado por
// warning visivel no log.
if (isProduction) {
  const key = (env.ENCRYPTION_KEY || '').trim();
  if (!key) {
    console.warn(
      '⚠️  ENCRYPTION_KEY ausente em producao. App sobe normalmente, mas OAuth do Google Calendar vai falhar ate a chave ser configurada. Veja backend/.env.example.'
    );
  } else {
    const validHex = /^[0-9a-fA-F]{64}$/.test(key);
    let validBase64 = false;
    if (!validHex) {
      try {
        validBase64 = Buffer.from(key, 'base64').length === 32;
      } catch {
        validBase64 = false;
      }
    }
    if (!validHex && !validBase64) {
      console.warn(
        '⚠️  ENCRYPTION_KEY presente mas com formato invalido (esperado hex 64 chars ou base64 32 bytes). Tokens OAuth do Google Calendar vao falhar.'
      );
    }
  }
}

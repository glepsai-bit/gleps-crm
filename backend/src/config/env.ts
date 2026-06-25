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

  // RapidAPI (for prospecting)
  RAPIDAPI_KEY: z.string().optional(),

  // Logging
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
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

import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive(),
  APP_URL: z.string().url(),
  APP_TIMEZONE: z.string().min(1),
  APP_KEY: z.string().regex(/^[0-9a-f]{64}$/, 'APP_KEY must be 64 hex chars (32 random bytes)'),
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive(),
  DB_DATABASE: z.string().min(1),
  DB_USERNAME: z.string().min(1),
  DB_PASSWORD: z.string(),
  DB_HWC_DATABASE: z.string().min(1),
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive(),
  // T14: APP_ENV mirrors the old app's .env (local -> error details in JSON).
  APP_ENV: z.string().default('production'),
  // T14: OpenAI / MCP (old config/services.php 'openai' + 'mcp' entries).
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().default('gpt-4o'),
  OPENAI_TRANSCRIPTION_MODEL: z.string().default('gpt-4o-mini-transcribe'),
  N8N_MCP_URL: z.string().default(''),
  PUBLIC_DIR: z.string().min(1),
  OLD_APP_URL: z.string().url(),
  // Used only by scripts/parity.ts (T03); allowed to be empty until then.
  PARITY_EMAIL: z.string(),
  PARITY_PASSWORD: z.string(),
  SCHEDULER_ENABLED: z.enum(['0', '1']).default('0'),
  // T23: /api/orders image fallback (old config/app.php use_local_image).
  USE_LOCAL_IMAGE: z.string().default(''),
  // T30: X-Import-Token for /api/products/import-faire-images (old config/app.php product_image_import_token).
  PRODUCT_IMAGE_IMPORT_TOKEN: z.string().default(''),
});

export const config = EnvSchema.parse(process.env);

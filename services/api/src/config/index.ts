import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3001),

  DATABASE_URL: z.string(),
  DATABASE_POOL_MAX: z.coerce.number().default(20),

  REDIS_URL: z.string(),

  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('7d'),

  TELEGRAM_BOT_TOKEN: z.string(),

  TON_RPC_URL: z.string().default('https://toncenter.com/api/v2'),
  TON_API_KEY: z.string(),
  TON_NETWORK: z.enum(['mainnet', 'testnet']).default('mainnet'),
  PLATFORM_WALLET_ADDRESS: z.string(),
  PLATFORM_WALLET_MNEMONIC: z.string(), // 24-word mnemonic, store in secrets manager

  CORS_ORIGIN: z.string().default('*'),

  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
});

export type Config = z.infer<typeof envSchema>;

let config: Config;

export function loadConfig(): Config {
  if (config) return config;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.format());
    process.exit(1);
  }
  config = parsed.data;
  return config;
}

export { config };

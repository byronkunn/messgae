import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const config = {
  root,
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: int(env.PORT, 3000),
  host: env.HOST || '127.0.0.1',
  // Public origin of the web app, used for share/recovery/device-link URLs and
  // for WebSocket Origin checks. In development the Vite dev server proxies to us.
  publicOrigin: env.PUBLIC_ORIGIN || 'http://localhost:5173',
  allowedOrigins: (env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173,http://127.0.0.1:3000')
    .split(',').map((s) => s.trim()).filter(Boolean),
  dataDir: path.resolve(env.DATA_DIR || path.join(root, 'data')),
  // Keys live outside the database. In production supply them via env/secret manager;
  // in development they are generated into a separate key directory on first run.
  keyDir: path.resolve(env.KEY_DIR || path.join(env.DATA_DIR || path.join(root, 'data'), 'keys')),
  keys: {
    filePassword: env.FILE_PASSWORD_KEY, // 32 bytes base64 — encrypts recoverable file passwords
    storage: env.STORAGE_KEY, // 32 bytes base64 — encrypts blobs at rest
    app: env.APP_SECRET_KEY, // 32 bytes base64 — encrypts TOTP secrets, signs tickets
  },
  trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  sessionCookie: 'sid',
  sessionTtlMs: 1000 * 60 * 60 * 24 * 90, // idle sessions expire after 90 days
  elevationTtlMs: 1000 * 60 * 10, // privileged admin sessions last 10 minutes
  // scrypt work factor for recovery-key and file-password verifiers.
  scryptN: int(env.SCRYPT_N, 1 << 15),
  plans: {
    free: {
      label: 'Free', priceMonthly: 0,
      storageBytes: 5 * GB, uploadBytes: 100 * MB, activeLinks: 25, groupMembers: 200,
      trashRetentionDays: 30, bandwidthBytesMonthly: 50 * GB, animatedProfile: false,
    },
    plus: {
      label: 'Plus', priceMonthly: 4.99,
      storageBytes: 200 * GB, uploadBytes: 4 * GB, activeLinks: 500, groupMembers: 5000,
      trashRetentionDays: 90, bandwidthBytesMonthly: 1024 * GB, animatedProfile: true,
    },
  },
  spacePlans: {
    free: { label: 'Space', priceMonthly: 0, storageBytes: 10 * GB, uploadBytes: 100 * MB, roles: 20, channels: 50, auditDays: 30 },
    pro: { label: 'Space Pro', priceMonthly: 9.99, storageBytes: 500 * GB, uploadBytes: 4 * GB, roles: 250, channels: 500, auditDays: 365 },
  },
  maxUploadBytes: int(env.MAX_UPLOAD_BYTES, 4 * GB),
  maxMessageLength: 4000,
};

export const UNITS = { MB, GB };

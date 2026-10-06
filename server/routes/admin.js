import { Router } from 'express';
import { requireUser, requireCap } from '../lib/auth.js';
import adminUsers from './admin/users.js';
import adminContent from './admin/content.js';
import adminAnalytics from './admin/analytics.js';
import adminSystem from './admin/system.js';

/**
 * Site administration API. Every route requires a staff capability; staff must have
 * 2FA enabled, and sensitive capabilities require a short-lived privileged session.
 */
export default function adminRoutes(ctx) {
  const r = Router();
  r.use(requireUser, requireCap('admin.access'));
  adminAnalytics(r, ctx);
  adminUsers(r, ctx);
  adminContent(r, ctx);
  adminSystem(r, ctx);
  return r;
}

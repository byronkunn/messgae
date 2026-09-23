import { h, oneOf } from '../../lib/http.js';
import { requireCap } from '../../lib/auth.js';
import { siteCaps } from '../../lib/perms.js';
import { trendScore, WINDOWS } from '../../lib/trending.js';
import { parseRange, series, HOUR, DAY } from './common.js';
import { config } from '../../config.js';

const n = (v) => Number(v || 0);

/** Least-squares slope (bytes per ms) over daily cumulative points. */
function linearForecast(points) {
  if (points.length < 2) return { slopePerDay: 0 };
  const xs = points.map((p) => p.t / DAY);
  const ys = points.map((p) => p.value);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return { slopePerDay: den ? num / den : 0 };
}

export function storageForecast(db) {
  const total = n(db.value('SELECT COALESCE(SUM(size),0) FROM files WHERE purged_at IS NULL'));
  const since = Date.now() - 28 * DAY;
  const daily = db.all(
    `SELECT CAST(created_at / ${DAY} AS INTEGER) AS b, SUM(size) AS value FROM files WHERE created_at > ? GROUP BY b`, since,
  );
  const filled = series(daily, since, Date.now(), DAY);
  // Cumulative series of logical storage growth over the window.
  let running = total - filled.reduce((a, p) => a + p.value, 0);
  const cumulative = filled.map((p) => ({ t: p.t, value: (running += p.value) }));
  const { slopePerDay } = linearForecast(cumulative);
  const perWeek = Math.max(0, slopePerDay * 7);
  return {
    currentBytes: total,
    physicalBytes: n(db.value('SELECT COALESCE(SUM(size),0) FROM blobs WHERE deleted_at IS NULL')),
    growthPerWeekBytes: Math.round(perWeek),
    estimate90dBytes: Math.round(total + perWeek * (90 / 7)),
    estimate180dBytes: Math.round(total + perWeek * (180 / 7)),
    daily: cumulative,
  };
}

export default function adminAnalytics(r, ctx) {
  const { db, hub } = ctx;

  r.get('/overview', h((req, res) => {
    const t = Date.now();
    const caps = siteCaps(req.user);
    const out = {
      me: { role: req.user.site_role, capabilities: [...caps], elevatedUntil: req.session.elevated_until > t ? req.session.elevated_until : null, totpEnabled: !!req.user.totp_enabled },
      reports: {
        open: n(db.value("SELECT COUNT(*) FROM reports WHERE status = 'open'")),
        reviewing: n(db.value("SELECT COUNT(*) FROM reports WHERE status = 'reviewing'")),
        escalated: n(db.value("SELECT COUNT(*) FROM reports WHERE status = 'escalated'")),
      },
    };
    if (caps.has('analytics.view') || caps.has('users.view')) {
      Object.assign(out, {
        users: {
          total: n(db.value('SELECT COUNT(*) FROM users')),
          new24h: n(db.value('SELECT COUNT(*) FROM users WHERE created_at > ?', t - DAY)),
          dau: n(db.value('SELECT COUNT(*) FROM users WHERE last_seen_at > ?', t - DAY)),
          onlineNow: hub.onlineUserIds().length,
          suspended: n(db.value("SELECT COUNT(*) FROM users WHERE state IN ('suspended','banned')")),
        },
        messaging: {
          today: n(db.value('SELECT COUNT(*) FROM messages WHERE created_at > ?', t - DAY)),
          activeConversations24h: n(db.value('SELECT COUNT(DISTINCT conversation_id) FROM messages WHERE created_at > ?', t - DAY)),
        },
        storage: {
          totalBytes: n(db.value('SELECT COALESCE(SUM(size),0) FROM files WHERE purged_at IS NULL')),
          uploads24h: n(db.value('SELECT COUNT(*) FROM files WHERE created_at > ?', t - DAY)),
        },
        spaces: n(db.value('SELECT COUNT(*) FROM spaces WHERE removed_at IS NULL')),
        groups: n(db.value("SELECT COUNT(*) FROM conversations WHERE type = 'group' AND removed_at IS NULL")),
        messagesSeries: series(db.all(`SELECT CAST(created_at / ${HOUR} AS INTEGER) AS b, COUNT(*) AS value FROM messages WHERE created_at > ? GROUP BY b`, t - DAY), t - DAY, t, HOUR),
      });
    }
    res.json(out);
  }));

  // ---- Communications dashboard ----------------------------------------------------------------

  r.get('/communications', requireCap('analytics.view'), h((req, res) => {
    const { from, to, bucket, range } = parseRange(req.query, '7d');
    const t = Date.now();
    const count = (sql, ...p) => n(db.value(sql, ...p));
    const inRange = 'm.created_at >= ? AND m.created_at <= ?';
    const activeByType = (type) => count(
      `SELECT COUNT(DISTINCT m.conversation_id) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.type = ? AND ${inRange}`, type, from, to,
    );
    const messages = count(`SELECT COUNT(*) FROM messages m WHERE ${inRange}`, from, to);
    const senders = count(`SELECT COUNT(DISTINCT m.sender_id) FROM messages m WHERE ${inRange}`, from, to);
    const kpis = {
      messagesToday: count('SELECT COUNT(*) FROM messages WHERE created_at > ?', t - DAY),
      messagesWeek: count('SELECT COUNT(*) FROM messages WHERE created_at > ?', t - 7 * DAY),
      messagesMonth: count('SELECT COUNT(*) FROM messages WHERE created_at > ?', t - 30 * DAY),
      messagesInRange: messages,
      activeConversations: count(`SELECT COUNT(DISTINCT m.conversation_id) FROM messages m WHERE ${inRange}`, from, to),
      activeDms: activeByType('dm'),
      activeGroups: activeByType('group'),
      activeChannels: activeByType('channel'),
      activeSpaces: count(`SELECT COUNT(DISTINCT c.space_id) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.space_id IS NOT NULL AND ${inRange}`, from, to),
      activeUsers: senders,
      messagesPerActiveUser: senders ? Math.round((messages / senders) * 10) / 10 : 0,
      mediaMessages: count(`SELECT COUNT(*) FROM messages m WHERE m.kind IN ('media','voice') AND ${inRange}`, from, to),
      fileMessages: count(`SELECT COUNT(*) FROM messages m WHERE m.kind = 'file' AND ${inRange}`, from, to),
    };
    const rows = db.all(
      `SELECT CAST(m.created_at / ${bucket} AS INTEGER) AS b, COUNT(*) AS value,
         SUM(CASE WHEN c.type = 'dm' THEN 1 ELSE 0 END) AS dm,
         SUM(CASE WHEN c.type = 'group' THEN 1 ELSE 0 END) AS grp,
         SUM(CASE WHEN c.type = 'channel' THEN 1 ELSE 0 END) AS channel
       FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE ${inRange} GROUP BY b`, from, to,
    );
    // Rankings. DMs are shown by ID only — never by participants' names — in rankings.
    const rank = (typeFilter, extra = '', order = 'messages') => db.all(
      `SELECT c.id, c.type, c.name, c.space_id, s.name AS space_name, COUNT(m.id) AS messages,
         SUM(CASE WHEN m.kind IN ('media','voice') THEN 1 ELSE 0 END) AS media,
         SUM(CASE WHEN m.kind = 'file' THEN 1 ELSE 0 END) AS files
       FROM messages m JOIN conversations c ON c.id = m.conversation_id LEFT JOIN spaces s ON s.id = c.space_id
       WHERE ${inRange} ${typeFilter} GROUP BY c.id ${extra} ORDER BY ${order} DESC LIMIT 10`, from, to,
    ).map((x) => ({ id: x.id, type: x.type, name: x.type === 'dm' ? `DM ${x.id.slice(-6)}` : x.name, spaceId: x.space_id, spaceName: x.space_name, messages: x.messages, media: x.media, files: x.files }));
    const spaces = db.all(
      `SELECT s.id, s.name, COUNT(m.id) AS messages FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN spaces s ON s.id = c.space_id
       WHERE ${inRange} GROUP BY s.id ORDER BY messages DESC LIMIT 10`, from, to,
    );
    const span = to - from;
    const growth = db.all(
      `SELECT c.id, c.name,
         (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.id AND m.joined_at >= ?) AS joined,
         (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.id AND m.joined_at < ?) AS before
       FROM conversations c WHERE c.type = 'group' AND c.removed_at IS NULL ORDER BY joined DESC LIMIT 10`, from, from,
    ).filter((g) => g.joined > 0).map((g) => ({ id: g.id, name: g.name, newMembers: g.joined, growthPct: Math.round((g.joined / Math.max(g.before, 1)) * 100) }));
    const storageConsumers = db.all(
      `SELECT u.id, u.username, SUM(f.size) AS bytes, COUNT(*) AS files FROM files f JOIN users u ON u.id = f.owner_id
       WHERE f.purged_at IS NULL GROUP BY u.id ORDER BY bytes DESC LIMIT 10`,
    );
    res.json({
      range, from, to, bucket, kpis,
      series: series(rows, from, to, bucket, ['value', 'dm', 'grp', 'channel']),
      rankings: {
        conversations: rank(''),
        groups: rank("AND c.type = 'group'"),
        channels: rank("AND c.type = 'channel'"),
        spaces,
        fastestGrowingGroups: growth,
        mediaHeavy: rank('', 'HAVING media > 0', 'media'),
        fileHeavy: rank('', 'HAVING files > 0', 'files'),
        storageConsumers,
      },
      spanMs: span,
    });
  }));

  // ---- Trending (files, groups, spaces, channels) --------------------------------------------------

  r.get('/trending', requireCap('analytics.view'), h((req, res) => {
    const type = oneOf(req.query.type, 'type', ['files', 'groups', 'spaces', 'channels'], 'groups');
    const win = WINDOWS[req.query.window] || WINDOWS['24h'];
    const t = Date.now();
    const base = 7 * DAY;
    let rows;
    if (type === 'files') {
      rows = db.all(
        `SELECT f.id, f.filename AS name, f.size, COUNT(CASE WHEN e.created_at > ? THEN 1 END) AS recent,
           COUNT(CASE WHEN e.created_at <= ? THEN 1 END) AS baseline
         FROM file_events e JOIN files f ON f.id = e.file_id
         WHERE e.type IN ('download','link_download') AND e.created_at > ? GROUP BY f.id HAVING recent > 0 LIMIT 2000`,
        t - win, t - win, t - win - base,
      );
    } else if (type === 'spaces') {
      rows = db.all(
        `SELECT s.id, s.name, COUNT(CASE WHEN m.created_at > ? THEN 1 END) AS recent, COUNT(CASE WHEN m.created_at <= ? THEN 1 END) AS baseline
         FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN spaces s ON s.id = c.space_id
         WHERE m.created_at > ? GROUP BY s.id HAVING recent > 0 LIMIT 2000`, t - win, t - win, t - win - base,
      );
    } else {
      rows = db.all(
        `SELECT c.id, c.name, c.space_id, COUNT(CASE WHEN m.created_at > ? THEN 1 END) AS recent, COUNT(CASE WHEN m.created_at <= ? THEN 1 END) AS baseline
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE c.type = ? AND m.created_at > ? GROUP BY c.id HAVING recent > 0 LIMIT 2000`,
        t - win, t - win, type === 'groups' ? 'group' : 'channel', t - win - base,
      );
    }
    const items = rows.map((x) => ({ ...x, ...trendScore(x.recent, x.baseline, win, base) })).sort((a, b) => b.score - a.score).slice(0, 50);
    res.json({ type, windowMs: win, items });
  }));

  // ---- Storage ------------------------------------------------------------------------------------

  r.get('/storage', requireCap('analytics.view'), h((req, res) => {
    const byType = db.all('SELECT category, COUNT(*) AS files, SUM(size) AS bytes FROM files WHERE purged_at IS NULL GROUP BY category ORDER BY bytes DESC');
    const byPlan = db.all('SELECT u.plan, COUNT(DISTINCT u.id) AS users, COALESCE(SUM(f.size),0) AS bytes FROM users u LEFT JOIN files f ON f.owner_id = u.id AND f.purged_at IS NULL GROUP BY u.plan');
    const largestAccounts = db.all('SELECT u.id, u.username, SUM(f.size) AS bytes, COUNT(*) AS files FROM files f JOIN users u ON u.id = f.owner_id WHERE f.purged_at IS NULL GROUP BY u.id ORDER BY bytes DESC LIMIT 10');
    const convStorage = (type) => db.all(
      `SELECT c.id, c.name, SUM(f.size) AS bytes FROM conversations c JOIN messages m ON m.conversation_id = c.id
       JOIN message_attachments a ON a.message_id = m.id JOIN files f ON f.id = a.file_id
       WHERE c.type = ? AND m.deleted_at IS NULL GROUP BY c.id ORDER BY bytes DESC LIMIT 10`, type,
    );
    const largestSpaces = db.all(
      `SELECT s.id, s.name, SUM(f.size) AS bytes FROM spaces s JOIN conversations c ON c.space_id = s.id JOIN messages m ON m.conversation_id = c.id
       JOIN message_attachments a ON a.message_id = m.id JOIN files f ON f.id = a.file_id WHERE m.deleted_at IS NULL
       GROUP BY s.id ORDER BY bytes DESC LIMIT 10`,
    );
    const t = Date.now();
    const bandwidth30d = n(db.value("SELECT COALESCE(SUM(bytes),0) FROM file_events WHERE type IN ('download','link_download','view') AND created_at > ?", t - 30 * DAY));
    res.json({
      forecast: storageForecast(db),
      totals: {
        files: n(db.value('SELECT COUNT(*) FROM files WHERE purged_at IS NULL')),
        blobs: n(db.value('SELECT COUNT(*) FROM blobs WHERE deleted_at IS NULL')),
        averageFileSize: Math.round(n(db.value('SELECT AVG(size) FROM files WHERE purged_at IS NULL'))),
        trashBytes: n(db.value('SELECT COALESCE(SUM(size),0) FROM files WHERE trashed_at IS NOT NULL AND purged_at IS NULL')),
        uploads30d: n(db.value('SELECT COUNT(*) FROM files WHERE created_at > ?', t - 30 * DAY)),
        downloads30d: n(db.value("SELECT COUNT(*) FROM file_events WHERE type IN ('download','link_download') AND created_at > ?", t - 30 * DAY)),
        bandwidth30d,
      },
      byType, byPlan, largestAccounts,
      largestGroups: convStorage('group'),
      largestSpaces,
    });
  }));

  // ---- Site analytics -----------------------------------------------------------------------------------

  r.get('/analytics', requireCap('analytics.view'), h((req, res) => {
    const section = oneOf(req.query.section, 'section',
      ['users', 'messaging', 'groups', 'spaces', 'storage', 'bandwidth', 'engagement', 'revenue', 'moderation', 'security'], 'users');
    const { from, to, bucket, range } = parseRange(req.query, '30d');
    const t = Date.now();
    const c = (sql, ...p) => n(db.value(sql, ...p));
    const ts = (sql, keys = ['value'], ...p) => series(db.all(sql, ...p), from, to, bucket, keys);
    const B = `CAST(created_at / ${bucket} AS INTEGER)`;
    let kpis = {};
    let charts = {};
    let tables = {};

    if (section === 'users') {
      kpis = {
        totalUsers: c('SELECT COUNT(*) FROM users'),
        dau: c('SELECT COUNT(*) FROM users WHERE last_seen_at > ?', t - DAY),
        wau: c('SELECT COUNT(*) FROM users WHERE last_seen_at > ?', t - 7 * DAY),
        mau: c('SELECT COUNT(*) FROM users WHERE last_seen_at > ?', t - 30 * DAY),
        newRegistrations: c('SELECT COUNT(*) FROM users WHERE created_at >= ? AND created_at <= ?', from, to),
        returningUsers: c('SELECT COUNT(*) FROM users WHERE last_seen_at >= ? AND created_at < ?', from, from),
      };
      charts = {
        registrations: ts(`SELECT ${B} AS b, COUNT(*) AS value FROM users WHERE created_at >= ? AND created_at <= ? GROUP BY b`, ['value'], from, to),
        activeSenders: ts(`SELECT CAST(created_at / ${bucket} AS INTEGER) AS b, COUNT(DISTINCT sender_id) AS value FROM messages WHERE created_at >= ? AND created_at <= ? GROUP BY b`, ['value'], from, to),
      };
    } else if (section === 'messaging') {
      kpis = {
        messagesPerHour: Math.round(c('SELECT COUNT(*) FROM messages WHERE created_at > ?', t - DAY) / 24),
        messagesPerDay: c('SELECT COUNT(*) FROM messages WHERE created_at > ?', t - DAY),
        messagesPerMonth: c('SELECT COUNT(*) FROM messages WHERE created_at > ?', t - 30 * DAY),
        dmsCreated: c("SELECT COUNT(*) FROM conversations WHERE type = 'dm' AND created_at >= ? AND created_at <= ?", from, to),
        groupsCreated: c("SELECT COUNT(*) FROM conversations WHERE type = 'group' AND created_at >= ? AND created_at <= ?", from, to),
        activeConversations: c('SELECT COUNT(DISTINCT conversation_id) FROM messages WHERE created_at >= ? AND created_at <= ?', from, to),
        replies: c('SELECT COUNT(*) FROM messages WHERE reply_to_id IS NOT NULL AND created_at >= ? AND created_at <= ?', from, to),
        reactions: c('SELECT COUNT(*) FROM reactions WHERE created_at >= ? AND created_at <= ?', from, to),
        attachments: c('SELECT COUNT(*) FROM message_attachments a JOIN messages m ON m.id = a.message_id WHERE m.created_at >= ? AND m.created_at <= ?', from, to),
      };
      charts = {
        messages: ts(`SELECT ${B} AS b, COUNT(*) AS value, SUM(CASE WHEN kind IN ('media','voice','file') THEN 1 ELSE 0 END) AS attachments FROM messages WHERE created_at >= ? AND created_at <= ? GROUP BY b`, ['value', 'attachments'], from, to),
        reactions: ts(`SELECT ${B} AS b, COUNT(*) AS value FROM reactions WHERE created_at >= ? AND created_at <= ? GROUP BY b`, ['value'], from, to),
      };
      tables.byKind = db.all('SELECT kind, COUNT(*) AS count FROM messages WHERE created_at >= ? AND created_at <= ? GROUP BY kind ORDER BY count DESC', from, to);
    } else if (section === 'groups') {
      kpis = {
        totalGroups: c("SELECT COUNT(*) FROM conversations WHERE type = 'group' AND removed_at IS NULL"),
        newGroups: c("SELECT COUNT(*) FROM conversations WHERE type = 'group' AND created_at >= ? AND created_at <= ?", from, to),
        activeGroups: c("SELECT COUNT(DISTINCT m.conversation_id) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.type = 'group' AND m.created_at >= ? AND m.created_at <= ?", from, to),
        publicGroups: c("SELECT COUNT(*) FROM conversations WHERE type = 'group' AND visibility = 'public' AND removed_at IS NULL"),
        averageMembers: Math.round(n(db.value("SELECT AVG(cnt) FROM (SELECT COUNT(*) AS cnt FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id WHERE c.type = 'group' GROUP BY c.id)")) * 10) / 10,
      };
      charts = { created: ts(`SELECT ${B} AS b, COUNT(*) AS value FROM conversations WHERE type = 'group' AND created_at >= ? AND created_at <= ? GROUP BY b`, ['value'], from, to) };
      tables.largest = db.all("SELECT c.id, c.name, COUNT(m.user_id) AS members FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id WHERE c.type = 'group' AND c.removed_at IS NULL GROUP BY c.id ORDER BY members DESC LIMIT 10");
    } else if (section === 'spaces') {
      kpis = {
        totalSpaces: c('SELECT COUNT(*) FROM spaces WHERE removed_at IS NULL'),
        newSpaces: c('SELECT COUNT(*) FROM spaces WHERE created_at >= ? AND created_at <= ?', from, to),
        publicSpaces: c("SELECT COUNT(*) FROM spaces WHERE visibility = 'public' AND removed_at IS NULL"),
        discoverable: c('SELECT COUNT(*) FROM spaces WHERE discoverable = 1 AND explore_removed = 0 AND removed_at IS NULL'),
        channels: c("SELECT COUNT(*) FROM conversations WHERE type = 'channel' AND removed_at IS NULL"),
        spacePro: c("SELECT COUNT(*) FROM spaces WHERE plan = 'pro' AND removed_at IS NULL"),
      };
      charts = { created: ts(`SELECT ${B} AS b, COUNT(*) AS value FROM spaces WHERE created_at >= ? AND created_at <= ? GROUP BY b`, ['value'], from, to) };
      tables.largest = db.all('SELECT s.id, s.name, COUNT(m.user_id) AS members FROM spaces s JOIN space_members m ON m.space_id = s.id WHERE s.removed_at IS NULL GROUP BY s.id ORDER BY members DESC LIMIT 10');
      tables.channelTypes = db.all("SELECT channel_type, COUNT(*) AS count FROM conversations WHERE type = 'channel' AND removed_at IS NULL GROUP BY channel_type");
    } else if (section === 'storage') {
      const f = storageForecast(db);
      kpis = {
        totalStorage: f.currentBytes, physicalStorage: f.physicalBytes, dedupSavings: Math.max(0, f.currentBytes - f.physicalBytes),
        growthPerWeek: f.growthPerWeekBytes, estimate90d: f.estimate90dBytes,
        uploads: c('SELECT COUNT(*) FROM files WHERE created_at >= ? AND created_at <= ?', from, to),
        averageFileSize: Math.round(n(db.value('SELECT AVG(size) FROM files WHERE purged_at IS NULL'))),
      };
      charts = {
        uploads: ts(`SELECT ${B} AS b, COUNT(*) AS value, SUM(size) AS bytes FROM files WHERE created_at >= ? AND created_at <= ? GROUP BY b`, ['value', 'bytes'], from, to),
        cumulative: f.daily,
      };
      tables.byType = db.all('SELECT category, COUNT(*) AS files, SUM(size) AS bytes FROM files WHERE purged_at IS NULL GROUP BY category ORDER BY bytes DESC');
      tables.byPlan = db.all('SELECT u.plan, COALESCE(SUM(f.size),0) AS bytes FROM users u LEFT JOIN files f ON f.owner_id = u.id AND f.purged_at IS NULL GROUP BY u.plan');
    } else if (section === 'bandwidth') {
      kpis = {
        bandwidth: c("SELECT COALESCE(SUM(bytes),0) FROM file_events WHERE type IN ('download','link_download','view') AND created_at >= ? AND created_at <= ?", from, to),
        downloads: c("SELECT COUNT(*) FROM file_events WHERE type IN ('download','link_download') AND created_at >= ? AND created_at <= ?", from, to),
        linkDownloads: c("SELECT COUNT(*) FROM file_events WHERE type = 'link_download' AND created_at >= ? AND created_at <= ?", from, to),
        views: c("SELECT COUNT(*) FROM file_events WHERE type = 'view' AND created_at >= ? AND created_at <= ?", from, to),
      };
      charts = { bandwidth: ts(`SELECT ${B} AS b, SUM(bytes) AS value, COUNT(*) AS requests FROM file_events WHERE type IN ('download','link_download','view') AND created_at >= ? AND created_at <= ? GROUP BY b`, ['value', 'requests'], from, to) };
      tables.topFiles = db.all('SELECT id, filename, bandwidth_bytes AS bytes, download_count AS downloads FROM files ORDER BY bandwidth_bytes DESC LIMIT 10');
    } else if (section === 'engagement') {
      const mau = c('SELECT COUNT(*) FROM users WHERE last_seen_at > ?', t - 30 * DAY);
      const dau = c('SELECT COUNT(*) FROM users WHERE last_seen_at > ?', t - DAY);
      const senders = c('SELECT COUNT(DISTINCT sender_id) FROM messages WHERE created_at >= ? AND created_at <= ?', from, to);
      const msgs = c('SELECT COUNT(*) FROM messages WHERE created_at >= ? AND created_at <= ?', from, to);
      kpis = {
        stickiness: mau ? Math.round((dau / mau) * 1000) / 10 : 0,
        messagesPerSender: senders ? Math.round((msgs / senders) * 10) / 10 : 0,
        reactionsPerMessage: msgs ? Math.round((c('SELECT COUNT(*) FROM reactions WHERE created_at >= ? AND created_at <= ?', from, to) / msgs) * 100) / 100 : 0,
        replyRate: msgs ? Math.round((c('SELECT COUNT(*) FROM messages WHERE reply_to_id IS NOT NULL AND created_at >= ? AND created_at <= ?', from, to) / msgs) * 1000) / 10 : 0,
        pollVotes: c('SELECT COUNT(*) FROM poll_votes'),
        shareLinksCreated: c('SELECT COUNT(*) FROM file_links WHERE created_at >= ? AND created_at <= ?', from, to),
      };
      charts = { senders: ts(`SELECT ${B} AS b, COUNT(DISTINCT sender_id) AS value FROM messages WHERE created_at >= ? AND created_at <= ? GROUP BY b`, ['value'], from, to) };
    } else if (section === 'revenue') {
      const plus = c("SELECT COUNT(*) FROM users WHERE plan = 'plus'");
      const pro = c("SELECT COUNT(*) FROM spaces WHERE plan = 'pro' AND removed_at IS NULL");
      kpis = {
        plusSubscribers: plus,
        spaceProSubscriptions: pro,
        estimatedMrr: Math.round((plus * config.plans.plus.priceMonthly + pro * config.spacePlans.pro.priceMonthly) * 100) / 100,
        conversionRate: Math.round((plus / Math.max(1, c('SELECT COUNT(*) FROM users'))) * 1000) / 10,
      };
      tables.note = [{ message: 'Estimated from plan assignments. No payment processor is connected in this MVP.' }];
    } else if (section === 'moderation') {
      kpis = {
        reportsFiled: c('SELECT COUNT(*) FROM reports WHERE created_at >= ? AND created_at <= ?', from, to),
        open: c("SELECT COUNT(*) FROM reports WHERE status IN ('open','reviewing')"),
        escalated: c("SELECT COUNT(*) FROM reports WHERE status = 'escalated'"),
        resolved: c("SELECT COUNT(*) FROM reports WHERE status IN ('resolved','dismissed') AND updated_at >= ? AND updated_at <= ?", from, to),
        actions: c("SELECT COUNT(*) FROM moderation_actions WHERE scope = 'site' AND created_at >= ? AND created_at <= ?", from, to),
        medianHoursToResolve: (() => {
          const rows = db.all("SELECT (updated_at - created_at) AS d FROM reports WHERE status IN ('resolved','dismissed') AND updated_at >= ? ORDER BY d", from);
          return rows.length ? Math.round((rows[Math.floor(rows.length / 2)].d / HOUR) * 10) / 10 : 0;
        })(),
      };
      charts = { reports: ts(`SELECT ${B} AS b, COUNT(*) AS value FROM reports WHERE created_at >= ? AND created_at <= ? GROUP BY b`, ['value'], from, to) };
      tables.byReason = db.all('SELECT reason, COUNT(*) AS count FROM reports WHERE created_at >= ? AND created_at <= ? GROUP BY reason ORDER BY count DESC', from, to);
      tables.byAction = db.all("SELECT action, COUNT(*) AS count FROM moderation_actions WHERE created_at >= ? AND created_at <= ? GROUP BY action ORDER BY count DESC LIMIT 15", from, to);
    } else if (section === 'security') {
      kpis = {
        failedLogins: c("SELECT COUNT(*) FROM security_events WHERE type = 'login_failed' AND created_at >= ? AND created_at <= ?", from, to),
        logins: c("SELECT COUNT(*) FROM security_events WHERE type = 'login' AND created_at >= ? AND created_at <= ?", from, to),
        lockedAccounts: c('SELECT COUNT(*) FROM users WHERE locked_until > ?', t),
        recoveryRotations: c("SELECT COUNT(*) FROM security_events WHERE type = 'recovery_key_rotated' AND created_at >= ? AND created_at <= ?", from, to),
        staffWithout2fa: c("SELECT COUNT(*) FROM users WHERE site_role != 'user' AND totp_enabled = 0"),
        privilegedElevations: c("SELECT COUNT(*) FROM audit_log WHERE action = 'admin.reauthenticated' AND created_at >= ? AND created_at <= ?", from, to),
      };
      charts = {
        logins: ts(`SELECT ${B} AS b, SUM(CASE WHEN type = 'login' THEN 1 ELSE 0 END) AS value, SUM(CASE WHEN type = 'login_failed' THEN 1 ELSE 0 END) AS failed FROM security_events WHERE created_at >= ? AND created_at <= ? GROUP BY b`, ['value', 'failed'], from, to),
      };
      tables.topFailedIps = db.all("SELECT ip, COUNT(*) AS count FROM security_events WHERE type = 'login_failed' AND created_at >= ? GROUP BY ip ORDER BY count DESC LIMIT 10", from);
    }
    res.json({ section, range, from, to, bucket, kpis, charts, tables });
  }));
}

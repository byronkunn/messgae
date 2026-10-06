import { Router } from 'express';
import { h, oneOf, int } from '../lib/http.js';
import { requireUser } from '../lib/auth.js';
import { publicProfile, privacyOf } from '../lib/users.js';
import { spaceSummary } from './spaces.js';
import { EXPLORE_TOPICS } from './conversations.js';
import { trendScore } from '../lib/trending.js';

const TABS = ['for-you', 'trending', 'spaces', 'groups', 'channels', 'topics', 'new', 'people'];
const DAY = 86400_000;

export default function exploreRoutes(ctx) {
  const r = Router();
  const { db, limiter } = ctx;
  r.use(requireUser);

  const esc = (q) => `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;

  function spaces(f) {
    const where = ["s.visibility = 'public'", 's.discoverable = 1', 's.explore_removed = 0', 's.removed_at IS NULL'];
    const params = [];
    if (f.q) {
      where.push("(s.name LIKE ? ESCAPE '\\' OR s.description LIKE ? ESCAPE '\\' OR s.topic LIKE ? ESCAPE '\\')");
      params.push(esc(f.q), esc(f.q), esc(f.q));
    }
    if (f.topic) { where.push('s.topic = ?'); params.push(f.topic); }
    if (f.language) { where.push('s.language = ?'); params.push(f.language); }
    if (f.membership) { where.push('s.join_mode = ?'); params.push(f.membership); }
    if (f.since) { where.push('s.created_at > ?'); params.push(f.since); }
    const rows = db.all(
      `SELECT s.*,
         (SELECT COUNT(*) FROM space_members m WHERE m.space_id = s.id) AS members,
         (SELECT COUNT(*) FROM messages msg JOIN conversations c ON c.id = msg.conversation_id WHERE c.space_id = s.id AND msg.created_at > ?) AS recent,
         (SELECT COUNT(*) FROM messages msg JOIN conversations c ON c.id = msg.conversation_id WHERE c.space_id = s.id AND msg.created_at > ? AND msg.created_at <= ?) AS baseline
       FROM spaces s WHERE ${where.join(' AND ')} LIMIT 500`,
      Date.now() - DAY, Date.now() - 8 * DAY, Date.now() - DAY, ...params,
    );
    return rows.map((s) => ({
      kind: 'space', ...spaceSummary(ctx, s), memberCount: s.members, activity24h: s.recent,
      trend: trendScore(s.recent, s.baseline, DAY, 7 * DAY),
      isMember: !!db.get('SELECT 1 FROM space_members WHERE space_id = ? AND user_id = ?', s.id, f.userId),
    }));
  }

  function groups(f) {
    const where = ["c.type = 'group'", "c.visibility = 'public'", 'c.discoverable = 1', 'c.explore_removed = 0', 'c.removed_at IS NULL'];
    const params = [];
    if (f.q) { where.push("(c.name LIKE ? ESCAPE '\\' OR c.description LIKE ? ESCAPE '\\')"); params.push(esc(f.q), esc(f.q)); }
    if (f.topic) { where.push('c.topic = ?'); params.push(f.topic); }
    if (f.language) { where.push('c.language = ?'); params.push(f.language); }
    if (f.membership) { where.push('c.join_mode = ?'); params.push(f.membership); }
    if (f.since) { where.push('c.created_at > ?'); params.push(f.since); }
    const rows = db.all(
      `SELECT c.*,
         (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.id) AS members,
         (SELECT COUNT(*) FROM messages msg WHERE msg.conversation_id = c.id AND msg.created_at > ?) AS recent,
         (SELECT COUNT(*) FROM messages msg WHERE msg.conversation_id = c.id AND msg.created_at > ? AND msg.created_at <= ?) AS baseline
       FROM conversations c WHERE ${where.join(' AND ')} LIMIT 500`,
      Date.now() - DAY, Date.now() - 8 * DAY, Date.now() - DAY, ...params,
    );
    return rows.map((c) => ({
      kind: 'group', id: c.id, name: c.name, description: c.description, avatarFileId: c.avatar_file_id, topic: c.topic,
      language: c.language, joinMode: c.join_mode, createdAt: c.created_at, memberCount: c.members, activity24h: c.recent,
      trend: trendScore(c.recent, c.baseline, DAY, 7 * DAY),
      isMember: !!db.get('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?', c.id, f.userId),
    }));
  }

  function channels(f) {
    const where = ["c.type = 'channel'", 'c.is_private = 0', 'c.removed_at IS NULL', "s.visibility = 'public'", 's.discoverable = 1', 's.explore_removed = 0', 's.removed_at IS NULL'];
    const params = [];
    if (f.q) { where.push("(c.name LIKE ? ESCAPE '\\' OR c.description LIKE ? ESCAPE '\\')"); params.push(esc(f.q), esc(f.q)); }
    if (f.topic) { where.push('s.topic = ?'); params.push(f.topic); }
    if (f.language) { where.push('s.language = ?'); params.push(f.language); }
    const rows = db.all(
      `SELECT c.*, s.name AS space_name, s.icon_file_id AS space_icon,
         (SELECT COUNT(*) FROM space_members m WHERE m.space_id = s.id) AS members,
         (SELECT COUNT(*) FROM messages msg WHERE msg.conversation_id = c.id AND msg.created_at > ?) AS recent,
         (SELECT COUNT(*) FROM messages msg WHERE msg.conversation_id = c.id AND msg.created_at > ? AND msg.created_at <= ?) AS baseline
       FROM conversations c JOIN spaces s ON s.id = c.space_id WHERE ${where.join(' AND ')} LIMIT 500`,
      Date.now() - DAY, Date.now() - 8 * DAY, Date.now() - DAY, ...params,
    );
    return rows.map((c) => ({
      kind: 'channel', id: c.id, name: c.name, description: c.description, channelType: c.channel_type, spaceId: c.space_id,
      spaceName: c.space_name, spaceIconFileId: c.space_icon, memberCount: c.members, activity24h: c.recent, createdAt: c.created_at,
      trend: trendScore(c.recent, c.baseline, DAY, 7 * DAY),
    }));
  }

  function people(f) {
    if (!f.q || f.q.length < 2) return [];
    const rows = db.all(
      `SELECT * FROM users WHERE state = 'active' AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\') AND id != ? LIMIT 100`,
      esc(f.q), esc(f.q), f.userId,
    );
    return rows.filter((u) => privacyOf(u).discoverable).slice(0, 30).map((u) => ({ kind: 'person', ...publicProfile(ctx, u, f.userId) }));
  }

  const sizeOk = (item, size) => !size || (size === 'small' ? item.memberCount < 50 : size === 'medium' ? item.memberCount < 1000 : item.memberCount >= 1000);
  const activityOk = (item, activity) => !activity || (activity === 'quiet' ? item.activity24h < 10 : activity === 'active' ? item.activity24h >= 10 : item.activity24h >= 200);

  r.get('/', h((req, res) => {
    limiter.check(`explore:${req.user.id}`, 120, 60_000);
    const tab = oneOf(req.query.tab, 'tab', TABS, 'for-you');
    const f = {
      userId: req.user.id,
      q: String(req.query.q || '').trim().slice(0, 100),
      topic: req.query.topic ? oneOf(req.query.topic, 'topic', EXPLORE_TOPICS) : null,
      language: req.query.language ? String(req.query.language).slice(0, 8) : null,
      membership: req.query.membership ? oneOf(req.query.membership, 'membership', ['open', 'approval']) : null,
      since: tab === 'new' ? Date.now() - 30 * DAY : null,
    };
    const types = req.query.types ? String(req.query.types).split(',') : null;
    const size = req.query.size ? oneOf(req.query.size, 'size', ['small', 'medium', 'large']) : null;
    const activity = req.query.activity ? oneOf(req.query.activity, 'activity', ['quiet', 'active', 'very_active']) : null;
    const sort = oneOf(req.query.sort, 'sort', ['relevance', 'newest', 'most_active', 'members'], tab === 'new' ? 'newest' : tab === 'trending' ? 'relevance' : 'most_active');

    if (tab === 'topics' && !f.q && !f.topic) {
      const topics = EXPLORE_TOPICS.map((t) => ({
        topic: t,
        spaces: Number(db.value("SELECT COUNT(*) FROM spaces WHERE topic = ? AND visibility = 'public' AND discoverable = 1 AND explore_removed = 0 AND removed_at IS NULL", t)),
        groups: Number(db.value("SELECT COUNT(*) FROM conversations WHERE type = 'group' AND topic = ? AND visibility = 'public' AND discoverable = 1 AND explore_removed = 0 AND removed_at IS NULL", t)),
      }));
      return res.json({ tab, topics });
    }

    let items = [];
    const want = (k) => !types || types.includes(k);
    if (tab === 'spaces') items = spaces(f);
    else if (tab === 'groups') items = groups(f);
    else if (tab === 'channels') items = channels(f);
    else if (tab === 'people') items = people(f);
    else {
      if (want('space')) items.push(...spaces(f));
      if (want('group')) items.push(...groups(f));
      if (want('channel') && (tab === 'trending' || f.q)) items.push(...channels(f));
      if (want('person') && f.q) items.push(...people(f));
    }
    items = items.filter((i) => i.kind === 'person' || (sizeOk(i, size) && activityOk(i, activity)));

    if (tab === 'for-you' && !f.q) {
      // Personalised by the topics of Spaces/groups you already belong to — no behavioural ad profile.
      const myTopics = new Set(db.all(
        `SELECT s.topic FROM spaces s JOIN space_members m ON m.space_id = s.id WHERE m.user_id = ? AND s.topic != ''
         UNION SELECT c.topic FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id WHERE m.user_id = ? AND c.topic != ''`,
        req.user.id, req.user.id,
      ).map((x) => x.topic));
      items = items.filter((i) => !i.isMember);
      items.sort((a, b) => (myTopics.has(b.topic) - myTopics.has(a.topic)) || (b.trend.score - a.trend.score) || (b.memberCount - a.memberCount));
    } else if (tab === 'trending' || sort === 'relevance') {
      items = items.filter((i) => i.kind === 'person' || tab !== 'trending' || i.activity24h > 0);
      items.sort((a, b) => (b.trend?.score ?? 0) - (a.trend?.score ?? 0));
    } else if (sort === 'newest') items.sort((a, b) => b.createdAt - a.createdAt);
    else if (sort === 'members') items.sort((a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0));
    else items.sort((a, b) => (b.activity24h ?? 0) - (a.activity24h ?? 0) || (b.memberCount ?? 0) - (a.memberCount ?? 0));

    const offset = int(req.query.offset, 'offset', { min: 0, max: 10000, fallback: 0 });
    res.json({ tab, total: items.length, items: items.slice(offset, offset + 30), nextOffset: offset + 30 < items.length ? offset + 30 : null });
  }));

  return r;
}

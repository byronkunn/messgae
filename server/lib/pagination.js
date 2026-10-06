import { bad } from './http.js';

export const PAGE_SIZES = [25, 50, 100];
const MAX_OFFSET = 10_000;

const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const dec = (s) => {
  try {
    return JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'));
  } catch {
    throw bad('Invalid pagination cursor.');
  }
};

/**
 * Server-side pagination with filtering and sorting.
 *
 * - Page-number navigation (page=N) uses OFFSET for shallow pages only.
 * - Next/Previous navigation uses keyset (seek) cursors on (sortColumn, id), which
 *   stays fast at any depth. Deep page jumps beyond MAX_OFFSET must use cursors.
 *
 * @param db
 * @param {object} o
 * @param {string} o.columns  SELECT column list
 * @param {string} o.from     FROM clause including joins
 * @param {string[]} [o.where]
 * @param {any[]} [o.params]
 * @param {Record<string,string>} o.sorts  sort key -> SQL expression
 * @param {string} o.defaultSort
 * @param {string} o.idCol    unique tiebreaker column
 * @param {object} o.query    request query: page, pageSize, cursor, sort, dir
 */
export function paginate(db, o) {
  const q = o.query || {};
  const pageSize = PAGE_SIZES.includes(Number(q.pageSize)) ? Number(q.pageSize) : o.defaultPageSize || 50;
  const sortKey = o.sorts[q.sort] ? q.sort : o.defaultSort;
  const sortCol = o.sorts[sortKey];
  const dir = q.dir === 'asc' ? 'asc' : q.dir === 'desc' ? 'desc' : o.defaultDir || 'desc';
  const where = [...(o.where || [])];
  const params = [...(o.params || [])];
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = o.skipCount
    ? null
    : Number(db.value(`SELECT COUNT(*) FROM ${o.from} ${whereSql}`, ...params));

  let page = Math.max(1, Number.parseInt(q.page, 10) || 1);
  let rows;
  const select = `SELECT ${o.columns}, ${sortCol} AS _sort, ${o.idCol} AS _id FROM ${o.from}`;

  if (q.cursor) {
    const c = dec(q.cursor);
    page = Math.max(1, Number(c.p) || 1);
    const forward = c.d === 'next';
    // Walking forward in a desc sort means values smaller than the cursor.
    const lt = (dir === 'desc') === forward;
    const op = lt ? '<' : '>';
    const order = lt ? 'DESC' : 'ASC';
    const seek = `(${sortCol} ${op} ? OR (${sortCol} = ? AND ${o.idCol} ${op} ?))`;
    rows = db.all(
      `${select} ${where.length ? `WHERE ${where.join(' AND ')} AND ${seek}` : `WHERE ${seek}`}
       ORDER BY ${sortCol} ${order}, ${o.idCol} ${order} LIMIT ?`,
      ...params, c.v, c.v, c.id, pageSize,
    );
    if (!forward) rows.reverse();
  } else {
    const offset = (page - 1) * pageSize;
    if (offset > MAX_OFFSET) throw bad('Page is too deep for direct jumps. Use Next/Previous or narrow the filters.');
    const order = dir.toUpperCase();
    rows = db.all(
      `${select} ${whereSql} ORDER BY ${sortCol} ${order}, ${o.idCol} ${order} LIMIT ? OFFSET ?`,
      ...params, pageSize, offset,
    );
  }

  const pages = total === null ? null : Math.max(1, Math.ceil(total / pageSize));
  const first = rows[0];
  const last = rows[rows.length - 1];
  const hasNext = total === null ? rows.length === pageSize : page < pages;
  const items = rows.map(({ _sort, _id, ...rest }) => (o.map ? o.map(rest) : rest));
  return {
    items,
    total,
    page,
    pageSize,
    pages,
    sort: sortKey,
    dir,
    from: rows.length ? (page - 1) * pageSize + 1 : 0,
    to: (page - 1) * pageSize + rows.length,
    nextCursor: hasNext && last ? enc({ v: last._sort, id: last._id, d: 'next', p: page + 1 }) : null,
    prevCursor: page > 1 && first ? enc({ v: first._sort, id: first._id, d: 'prev', p: page - 1 }) : null,
    maxJumpPage: Math.floor(MAX_OFFSET / pageSize) + 1,
  };
}

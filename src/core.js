export const KINDS = ['video', 'dynamic', 'live'];
export const KIND_LABELS = { video: '视频投稿', dynamic: '动态', live: '直播开播' };
export const LIVE_ORIGIN = 'https://api.live.bilibili.com';
export const LIVE_PERMISSION = { origins: [`${LIVE_ORIGIN}/*`] };
const DYNAMIC_TYPES = new Set([
  'DYNAMIC_TYPE_WORD', 'DYNAMIC_TYPE_DRAW', 'DYNAMIC_TYPE_FORWARD', 'DYNAMIC_TYPE_ARTICLE',
  'DYNAMIC_TYPE_OPUS'
]);
const BV = /^BV[A-Za-z0-9]{10}$/;
const DIGITS = /^[1-9]\d{0,19}$/;

function normalizeRule(input, fallback) {
  const mode = ['all', 'selected', 'off'].includes(input?.mode) ? input.mode : fallback;
  const uids = Array.isArray(input?.uids) ? input.uids.map(String).filter(uid => DIGITS.test(uid)) : [];
  return { mode, uids: [...new Set(uids)] };
}

export function normalizeSettings(input = {}) {
  const number = (value, fallback, min, max) => Number.isFinite(Number(value))
    ? Math.min(max, Math.max(min, Math.round(Number(value)))) : fallback;
  return {
    enabled: input.enabled !== false,
    interval: number(input.interval ?? 3, 3, 1, 60),
    rules: {
      // 保留升级前的视频提醒范围和 UID。
      video: normalizeRule(input.rules?.video ?? input, 'all'),
      dynamic: normalizeRule(input.rules?.dynamic, 'off'),
      live: normalizeRule(input.rules?.live, 'off')
    },
    silent: input.silent === true,
    maxPages: number(input.maxPages ?? 5, 5, 1, 10)
  };
}

function numericId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  return (typeof value === 'string' || typeof value === 'number') && DIGITS.test(String(value)) ? String(value) : '';
}

export function itemUrl(kind, id) {
  if (kind === 'video' && BV.test(id)) return `https://www.bilibili.com/video/${id}/`;
  if (kind === 'dynamic' && numericId(id)) return `https://t.bilibili.com/${id}`;
  if (kind === 'live' && numericId(id)) return `https://live.bilibili.com/${id}`;
  return '';
}

export function videoFromItem(item) {
  // 仅接收原创视频动态，不把转发里的视频当成 UP 主的新投稿。
  if (item?.type !== 'DYNAMIC_TYPE_AV') return null;
  const author = item.modules?.module_author;
  const archive = item.modules?.module_dynamic?.major?.archive;
  const uid = numericId(author?.mid);
  if (!uid || !BV.test(archive?.bvid ?? '')) return null;
  return {
    kind: 'video', id: archive.bvid, uid, author: String(author.name ?? 'UP 主'),
    title: String(archive.title ?? '新视频'), published: Number(author.pub_ts) || 0,
    url: `https://www.bilibili.com/video/${archive.bvid}/`
  };
}

export function dynamicFromItem(item) {
  if (!DYNAMIC_TYPES.has(item?.type)) return null;
  const author = item.modules?.module_author;
  const dynamic = item.modules?.module_dynamic;
  const uid = numericId(author?.mid);
  const id = numericId(item.id_str);
  if (!uid || !id) return null;
  // 只使用动态文本和标题，转发以发出转发的 UP 主为准。
  const message = dynamic?.desc?.text || dynamic?.major?.opus?.summary?.text
    || dynamic?.major?.article?.title || dynamic?.major?.opus?.title;
  const fallback = item.type === 'DYNAMIC_TYPE_FORWARD' ? '转发了一条动态' : '查看动态';
  const title = typeof message === 'string' ? message.replace(/\s+/g, ' ').trim().slice(0, 180) : '';
  return { kind: 'dynamic', id, uid, author: String(author.name ?? 'UP 主'),
    title: title || fallback, published: Number(author.pub_ts) || 0 };
}

export function dynamicFeedId(item) {
  return numericId(item?.id_str);
}

export function liveFromResponse(data) {
  const list = Array.isArray(data?.rooms) ? data.rooms : data?.list;
  if (!Array.isArray(list)) throw new Error('B站没有返回关注直播列表。');
  const rooms = new Map();
  for (const room of list) {
    if (String(room?.live_status) !== '1') continue;
    const id = numericId(room.room_id) || numericId(room.roomid);
    const uid = numericId(room.uid);
    if (!id || !uid) throw new Error('B站直播列表缺少有效的房间号或 UID。');
    rooms.set(id, { kind: 'live', id, uid,
      author: String(room.uname || room.nickname || `UID ${uid}`),
      title: String(room.title || room.roomname || '点击进入直播间') });
  }
  return [...rooms.values()];
}

export function matches(item, settings) {
  const rule = settings.rules[item.kind ?? 'video'];
  return rule?.mode === 'all' || (rule?.mode === 'selected' && rule.uids.includes(item.uid));
}

export async function scanFeed(getPage, previousIds, maxPages, parseItem = videoFromItem, feedId) {
  const known = new Set(previousIds);
  const found = new Map();
  const seen = new Set();
  const offsets = new Set();
  let offset = '';
  let exhausted = false;
  let overlap = false;
  let pages = 0;
  for (; pages < maxPages;) {
    const data = await getPage(offset);
    if (!Array.isArray(data.items)) throw new Error('B站返回的数据格式发生变化：缺少动态列表。');
    pages++;
    for (const item of data.items) {
      const record = parseItem(item);
      if (record) found.set(record.id, record);
      // 非投稿动态用完整关注流的 ID 衔接，避免仅有投稿的页面没有检查边界。
      const id = feedId ? feedId(item) : record?.id;
      if (id) {
        seen.add(id);
        if (known.has(id)) overlap = true;
      }
    }
    // 初次启用只使用首页建立基线，不通知已有内容。
    if (!previousIds.length || overlap || !data.has_more) {
      exhausted = !data.has_more;
      break;
    }
    if (!data.offset || offsets.has(String(data.offset))) {
      throw new Error('B站分页游标异常，本次检查未提交，稍后重试。');
    }
    offset = String(data.offset);
    offsets.add(offset);
  }
  return {
    items: [...found.values()],
    seen: [...seen],
    fresh: [...found.values()].filter(item => !known.has(item.id)),
    gap: previousIds.length > 0 && !overlap && !exhausted,
    pages
  };
}

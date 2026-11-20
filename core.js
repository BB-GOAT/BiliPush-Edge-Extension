export const DEFAULTS = { enabled: true, interval: 3, mode: 'all', uids: [], silent: false, maxPages: 5 };

export function normalizeSettings(input = {}) {
  const number = (value, fallback, min, max) => Number.isFinite(Number(value))
    ? Math.min(max, Math.max(min, Math.round(Number(value)))) : fallback;
  return {
    enabled: input.enabled !== false,
    interval: number(input.interval ?? 3, 3, 1, 60),
    mode: input.mode === 'selected' ? 'selected' : 'all',
    uids: [...new Set((Array.isArray(input.uids) ? input.uids : [])
      .map(String).filter(uid => /^\d{1,20}$/.test(uid)))],
    silent: input.silent === true,
    maxPages: number(input.maxPages ?? 5, 5, 1, 10)
  };
}

export function videoFromItem(item) {
  // 仅接收原创视频动态，不把转发里的视频当成 UP 主的新投稿。
  if (item?.type !== 'DYNAMIC_TYPE_AV') return null;
  const author = item.modules?.module_author;
  const archive = item.modules?.module_dynamic?.major?.archive;
  if (!author || !/^BV[A-Za-z0-9]{10}$/.test(archive?.bvid ?? '')) return null;
  return {
    id: archive.bvid, uid: String(author.mid), author: String(author.name ?? 'UP主'),
    title: String(archive.title ?? '新视频'), published: Number(author.pub_ts) || 0,
    url: `https://www.bilibili.com/video/${archive.bvid}/`
  };
}

export function matches(video, settings) {
  return settings.mode === 'all' || settings.uids.includes(video.uid);
}

export async function scanFeed(getPage, previousIds, maxPages) {
  const known = new Set(previousIds);
  const videos = new Map();
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
      const video = videoFromItem(item);
      if (video) {
        videos.set(video.id, video);
        if (known.has(video.id)) overlap = true;
      }
    }
    // 初次启用只使用首页建立基线，不通知既有投稿。
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
    videos: [...videos.values()],
    fresh: [...videos.values()].filter(video => !known.has(video.id)),
    gap: previousIds.length > 0 && !overlap && !exhausted,
    pages
  };
}

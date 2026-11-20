import {
  KINDS, KIND_LABELS, LIVE_ORIGIN, LIVE_PERMISSION, normalizeSettings,
  videoFromItem, dynamicFromItem, dynamicFeedId, liveFromResponse, itemUrl, scanFeed, matches
} from './core.js';

const ALARM = 'check-videos';
// 使用扩展根目录下的完整地址，避免通知图标随后台脚本目录解析。
const NOTIFICATION_ICON = chrome.runtime.getURL('assets/icon.png');
const API = 'https://api.bilibili.com';
const emptyState = () => ({
  account: '', seen: [], baseline: false, dynamicSeen: [], dynamicBaseline: false,
  liveRooms: null, sources: {}, pending: [], history: [], failures: 0
});
const enabledKinds = settings => KINDS.filter(kind => settings.rules[kind].mode !== 'off');
const feed = (type, offset = '') => api(`/x/polymer/web-dynamic/v1/feed/all?type=${type}&timezone_offset=-480`
  + (offset ? `&offset=${encodeURIComponent(offset)}` : ''));
const sourceErrors = (state, kinds) => kinds.filter(kind => state.sources[kind]?.error)
  .map(kind => `${KIND_LABELS[kind]}：${state.sources[kind].error}`).join('；');
let queue = Promise.resolve();
function serial(task) {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
}
async function read() {
  const stored = await chrome.storage.local.get(['settings', 'state']);
  return { settings: normalizeSettings(stored.settings), state: { ...emptyState(), ...stored.state } };
}
async function api(path, origin = API) {
  let response;
  try {
    // Cookie 由浏览器自动附带；不读取、复制或保存登录凭据。
    response = await fetch(origin + path, {
      credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(20000)
    });
  } catch {
    throw new Error('请求失败或超时，请检查网络后重试。');
  }
  if (!response.ok) throw new Error(`B站请求失败（HTTP ${response.status}），已降低重试频率。`);
  let body;
  try { body = await response.json(); }
  catch { throw new Error('B站返回了非 JSON 内容，可能需要在网页完成验证。'); }
  if (body.code !== 0) {
    if (body.code === -101) throw new Error('B站登录已失效，请在当前 Edge 配置文件中重新登录 B站。');
    throw new Error(`B站接口返回 ${body.code}：${String(body.message ?? '请打开 B站网页检查登录或验证状态').slice(0, 160)}`);
  }
  return body.data;
}
async function currentAccount() {
  const account = await api('/x/web-interface/nav');
  if (!account?.isLogin || !account.mid) throw new Error('请先在当前 Edge 配置文件中登录 B站。');
  return account;
}
async function badge(text, color = '#d55435') {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}
async function schedule(settings, state, preserve = false) {
  if (!settings.enabled || !enabledKinds(settings).length) {
    await chrome.alarms.clear(ALARM);
    state.nextCheck = null;
  } else {
    const existing = preserve ? await chrome.alarms.get(ALARM) : null;
    const delay = Math.min(60, settings.interval * 2 ** Math.min(state.failures || 0, 6));
    state.nextCheck = existing?.scheduledTime ?? Date.now() + delay * 60000;
    if (!existing) await chrome.alarms.create(ALARM, { when: state.nextCheck });
  }
}
function notify(item, id, silent, test = false) {
  const kind = item.kind ?? 'video';
  const verb = { video: '投稿了新视频', dynamic: '发布了新动态', live: '开播了' }[kind];
  return chrome.notifications.create(id, {
    type: 'basic', iconUrl: NOTIFICATION_ICON, title: `${test ? '【测试】' : ''}${item.author} ${verb}`,
    message: item.title, silent
  });
}
async function flush(state, settings, liveChecked) {
  for (let index = 0; index < state.pending.length;) {
    const item = state.pending[index];
    const kind = item.kind ?? 'video';
    // 设置变更后尚未发送的通知也遵循最新筛选规则。
    if (matches(item, settings) && itemUrl(kind, item.id)) {
      // 直播列表读取失败时保留待发项，等下一次确认还在播再通知。
      if (kind === 'live' && !liveChecked) {
        index++;
        continue;
      }
      const session = kind === 'live' ? `:${item.session}` : '';
      await notify(item, `${kind}:${item.id}${session}`, settings.silent);
    }
    state.pending.splice(index, 1);
    await chrome.storage.local.set({ state });
  }
}

async function scanKind(kind, settings, state) {
  if (kind === 'live') {
    if (!await chrome.permissions.contains(LIVE_PERMISSION)) {
      throw new Error('请在设置中重新保存直播提醒并允许访问 B站直播接口。');
    }
    const rooms = liveFromResponse(await api('/xlive/web-ucenter/v1/xfetter/GetWebList?hit_ab=true', LIVE_ORIGIN));
    const previous = new Set(state.liveRooms ?? []);
    const ready = state.liveRooms !== null;
    const fresh = ready ? rooms.filter(room => !previous.has(room.id)) : [];
    return { records: fresh, fresh, ready, liveRooms: rooms.map(room => room.id) };
  }
  const video = kind === 'video';
  const ready = video ? state.baseline : state.dynamicBaseline;
  const seen = video ? state.seen : state.dynamicSeen;
  const scan = await scanFeed(offset => feed(video ? 'video' : 'all', offset), ready ? seen : [], settings.maxPages,
    video ? videoFromItem : dynamicFromItem, video ? undefined : dynamicFeedId);
  const known = new Set(seen);
  return { ready, records: scan.items.filter(item => !known.has(item.id)), fresh: ready ? scan.fresh : [],
    seen: [...new Set([...scan.seen, ...seen])].slice(0, 3000), gap: scan.gap };
}

function recordScan(kind, result, state, settings) {
  if (kind === 'video') {
    state.baseline = true;
    state.seen = result.seen;
  } else if (kind === 'dynamic') {
    state.dynamicBaseline = true;
    state.dynamicSeen = result.seen;
  } else {
    state.liveRooms = result.liveRooms;
    const active = new Set(result.liveRooms);
    state.pending = state.pending.filter(item => item.kind !== 'live' || active.has(item.id));
  }
  const detected = Date.now();
  const fresh = result.fresh.filter(item => matches(item, settings));
  state.pending.push(...fresh.sort((a, b) => (a.published ?? 0) - (b.published ?? 0))
    .map(item => kind === 'live' ? { ...item, session: crypto.randomUUID() } : item));
  const records = result.records.map(item => ({ ...item, detected }));
  const note = !result.ready ? '已建立基线' : `${fresh.length} 条新提醒${result.gap ? '，页数不足，可能遗漏更早更新' : ''}`;
  return { records, note };
}

async function check(manual = false) {
  const { settings, state: saved } = await read();
  let state = saved;
  if (!settings.enabled && !manual) return;
  const kinds = enabledKinds(settings);
  if (!kinds.length) return { settings, state };
  state.lastAttempt = Date.now();
  try {
    const account = await currentAccount();
    const mid = String(account.mid);
    if (state.account !== mid) state = { ...emptyState(), account: mid, lastAttempt: Date.now() };
    state.accountName = String(account.uname ?? mid);
    // 各来源并行读取、分别记录错误，直播或动态接口失败不阻塞投稿检查。
    const due = kinds.filter(kind => manual || !(state.sources[kind]?.retryAt > Date.now()));
    const scans = await Promise.allSettled(due.map(kind => scanKind(kind, settings, state)));
    const records = [];
    let liveChecked = false;
    for (const [index, kind] of due.entries()) {
      const scan = scans[index];
      if (scan.status === 'rejected') {
        const failures = (state.sources[kind]?.failures ?? 0) + 1;
        const delay = Math.min(60, settings.interval * 2 ** Math.min(failures, 6));
        state.sources[kind] = { failures, retryAt: Date.now() + delay * 60000,
          error: scan.reason?.message ?? String(scan.reason) };
        continue;
      }
      const result = recordScan(kind, scan.value, state, settings);
      if (kind === 'live') liveChecked = true;
      records.push(...result.records);
      state.sources[kind] = { note: result.note };
      state.lastSuccess = Date.now();
    }
    records.sort((a, b) => (b.published || b.detected / 1000) - (a.published || a.detected / 1000));
    state.history = [...records, ...state.history].slice(0, 100);
    state.note = kinds.map(kind => `${KIND_LABELS[kind]}：${state.sources[kind]?.note ?? '等待重试'}`).join('；');
    state.failures = 0;
    state.error = sourceErrors(state, kinds);
    // 先落盘待发送列表，避免后台休眠时丢失整批通知。
    await chrome.storage.local.set({ state });
    await flush(state, settings, liveChecked);
    if (state.error) await badge('!');
    else await badge(settings.enabled ? '' : '停', '#64748b');
  } catch (error) {
    state.failures = (state.failures || 0) + 1;
    state.error = error.message || String(error);
    await badge('!');
  }
  await schedule(settings, state);
  await chrome.storage.local.set({ state });
  return { settings, state };
}

async function saveSettings(input) {
  const { state } = await read();
  const settings = normalizeSettings(input);
  for (const kind of KINDS) {
    if (settings.rules[kind].mode !== 'off') continue;
    delete state.sources[kind];
    if (kind === 'video') state.baseline = false;
    if (kind === 'dynamic') state.dynamicBaseline = false;
    if (kind === 'live') state.liveRooms = null;
  }
  state.pending = state.pending.filter(item => matches(item, settings));
  const kinds = enabledKinds(settings);
  if (!state.failures) state.error = sourceErrors(state, kinds);
  await schedule(settings, state);
  await chrome.storage.local.set({ settings, state });
  await badge(settings.enabled && kinds.length ? (state.error ? '!' : '') : '停', '#64748b');
  return { settings, state };
}

async function testNotification() {
  await currentAccount();
  const data = await feed('video');
  if (!Array.isArray(data?.items)) throw new Error('B站未返回关注视频列表。');
  const latest = data.items.map(videoFromItem).filter(Boolean).sort((a, b) => b.published - a.published)[0];
  if (!latest) throw new Error('关注流里没有可用于测试的视频。');
  // 每次创建新测试通知。用 BV 号点击直达视频，不写入检查状态。
  const active = await chrome.notifications.getAll();
  for (const id of Object.keys(active)) {
    if (id === 'test' || id.startsWith('test:')) await chrome.notifications.clear(id);
  }
  await notify(latest, `test:${latest.id}:${crypto.randomUUID()}`, false, true);
  return { title: latest.title };
}
async function initialize() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const { settings, state } = await read();
  await schedule(settings, state, true);
  await chrome.storage.local.set({ settings, state });
}
chrome.runtime.onInstalled.addListener(() => { void serial(async () => { await initialize(); await check(); }); });
chrome.runtime.onStartup.addListener(() => { void serial(async () => { await initialize(); await check(); }); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) void serial(() => check());
});
chrome.action.onClicked.addListener(() => { void chrome.runtime.openOptionsPage(); });
chrome.notifications.onClicked.addListener(id => {
  const [kind, itemId] = id.split(':');
  const url = itemUrl(kind === 'test' ? 'video' : kind, itemId);
  if (url) void chrome.tabs.create({ url });
  else if (kind === 'test') void chrome.runtime.openOptionsPage();
  void chrome.notifications.clear(id);
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  // 设置面板作为标签页打开时也可能带有 sender.tab，不能据此拒绝。
  // 按扩展身份和完整页面地址校验，只接受本扩展的设置页。
  let trusted = false;
  try {
    const page = new URL(sender.url);
    page.search = '';
    page.hash = '';
    trusted = page.href === chrome.runtime.getURL('src/options/settings.html');
  } catch {}
  if (!trusted) {
    respond({ error: '消息来源不是本扩展的设置页，请关闭此页后重新点击扩展图标打开。' });
    return;
  }
  serial(async () => {
    switch (message.type) {
      case 'status': return read();
      case 'check': return check(true);
      case 'save': return saveSettings(message.settings);
      case 'test': return testNotification();
      default: throw new Error('未知操作');
    }
  }).then(result => respond({ result }), error => respond({ error: error.message }));
  return true;
});
// 后台可能被浏览器回收；每次唤醒都确认定时任务仍然存在。
void serial(initialize);

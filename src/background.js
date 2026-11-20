import { DEFAULTS, normalizeSettings, scanFeed, matches } from './core.js';

const ALARM = 'check-videos';
// 使用扩展根目录下的完整地址，避免通知图标随后台脚本目录解析。
const NOTIFICATION_ICON = chrome.runtime.getURL('assets/icon.png');
const API = 'https://api.bilibili.com';
const EMPTY = { account: '', seen: [], baseline: false, pending: [], history: [], failures: 0 };
const emptyState = () => ({ ...EMPTY, seen: [], pending: [], history: [] });
let queue = Promise.resolve();
function serial(task) {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
}
async function read() {
  const stored = await chrome.storage.local.get(['settings', 'state']);
  return { settings: normalizeSettings(stored.settings ?? DEFAULTS), state: { ...emptyState(), ...stored.state } };
}
async function api(path) {
  let response;
  try {
    // Cookie 由浏览器自动附带；不读取、复制或保存登录凭据。
    response = await fetch(API + path, {
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
async function badge(text, color = '#d55435') {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}
async function schedule(settings, state, preserve = false) {
  if (!settings.enabled) {
    await chrome.alarms.clear(ALARM);
    state.nextCheck = null;
  } else {
    const existing = preserve ? await chrome.alarms.get(ALARM) : null;
    const delay = Math.min(60, settings.interval * 2 ** Math.min(state.failures || 0, 6));
    state.nextCheck = existing?.scheduledTime ?? Date.now() + delay * 60000;
    if (!existing) await chrome.alarms.create(ALARM, { when: state.nextCheck });
  }
}
async function flush(state, settings) {
  while (state.pending.length) {
    const video = state.pending[0];
    // 设置变更后尚未发送的通知也遵循最新筛选规则。
    if (matches(video, settings)) {
      await chrome.notifications.create(`video:${video.id}`, {
        type: 'basic', iconUrl: NOTIFICATION_ICON, title: `${video.author} 投稿了新视频`,
        message: video.title, silent: settings.silent
      });
    }
    state.pending.shift();
    await chrome.storage.local.set({ state });
  }
}
async function check(manual = false) {
  const { settings, state: saved } = await read();
  let state = saved;
  if (!settings.enabled && !manual) return;
  state.lastAttempt = Date.now();
  try {
    const account = await api('/x/web-interface/nav');
    if (!account?.isLogin || !account.mid) throw new Error('请先在当前 Edge 配置文件中登录 B站。');
    const mid = String(account.mid);
    if (state.account !== mid) state = { ...emptyState(), account: mid, lastAttempt: Date.now() };
    state.accountName = String(account.uname ?? mid);
    await flush(state, settings);
    const scan = await scanFeed(offset => api('/x/polymer/web-dynamic/v1/feed/all?type=video&timezone_offset=-480'
      + (offset ? `&offset=${encodeURIComponent(offset)}` : '')), state.baseline ? state.seen : [], settings.maxPages);
    const fresh = state.baseline ? scan.fresh.filter(video => matches(video, settings)) : [];
    const old = new Set(state.seen);
    state.seen = [...new Set([...scan.videos.map(video => video.id), ...state.seen])].slice(0, 3000);
    const records = scan.videos.filter(video => !old.has(video.id)).map(video => ({ ...video, detected: Date.now() }));
    state.history = [...records, ...state.history].slice(0, 100);
    state.pending.push(...fresh.sort((a, b) => a.published - b.published));
    state.note = !state.baseline ? '已建立基线，现有视频不会弹出通知。'
      : scan.gap ? `已检查 ${scan.pages} 页，仍未衔接上次记录，更早更新可能遗漏。可增大检查页数。`
      : `检查完成，发现 ${fresh.length} 个符合设置的新视频。`;
    state.baseline = true;
    state.lastSuccess = Date.now();
    state.failures = 0;
    state.error = '';
    // 先落盘待发送列表，避免后台休眠时丢失整批通知。
    await chrome.storage.local.set({ state });
    await flush(state, settings);
    await badge(settings.enabled ? '' : '停', '#64748b');
  } catch (error) {
    state.failures = (state.failures || 0) + 1;
    state.error = error.message || String(error);
    await badge('!');
  }
  await schedule(settings, state);
  await chrome.storage.local.set({ state });
  return { settings, state };
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
  if (id.startsWith('video:') && /^BV[A-Za-z0-9]{10}$/.test(id.slice(6))) {
    void chrome.tabs.create({ url: `https://www.bilibili.com/video/${id.slice(6)}/` });
  } else if (id === 'test' || id.startsWith('test:')) void chrome.runtime.openOptionsPage();
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
      case 'save': {
        const { state } = await read();
        const settings = normalizeSettings(message.settings);
        await schedule(settings, state);
        await chrome.storage.local.set({ settings, state });
        await badge(settings.enabled ? (state.error ? '!' : '') : '停', '#64748b');
        return { settings, state };
      }
      case 'test': {
        // 独立 ID 使连续测试创建新通知，避免系统只更新已有通知而不再显示横幅。
        // 只清理测试通知，保留真实投稿提醒。
        const active = await chrome.notifications.getAll();
        for (const id of Object.keys(active)) {
          if (id === 'test' || id.startsWith('test:')) await chrome.notifications.clear(id);
        }
        await chrome.notifications.create(`test:${crypto.randomUUID()}`, { type: 'basic', iconUrl: NOTIFICATION_ICON,
          title: 'B站关注视频提醒', message: '系统通知测试成功。点击通知可返回设置面板。', silent: false });
        return { ok: true };
      }
      default: throw new Error('未知操作');
    }
  }).then(result => respond({ result }), error => respond({ error: error.message }));
  return true;
});
// 后台可能被浏览器回收；每次唤醒都确认定时任务仍然存在。
void serial(initialize);

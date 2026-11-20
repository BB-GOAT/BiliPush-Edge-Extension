import {
  KINDS, KIND_LABELS, LIVE_ORIGIN, LIVE_PERMISSION, ISSUE_LIMITS, CheckError, normalizeSettings,
  videoFromItem, dynamicFromItem, dynamicFeedId, liveFromResponse, itemUrl, scanFeed, matches,
  numericId, followingFromItem
} from './core.js';
import { describeIssue, readIssueHistory, recordIssue, updateIssueHistory } from './diagnostics.js';

const ALARM = 'check-videos';
// 使用扩展根目录下的完整地址，避免通知图标随后台脚本目录解析。
const NOTIFICATION_ICON = chrome.runtime.getURL('assets/icon.png');
const API = 'https://api.bilibili.com';
const emptyState = () => ({
  account: '', seen: [], baseline: false, dynamicSeen: [], dynamicBaseline: false,
  liveRooms: null, sources: {}, globalIssues: {}, diagnosticScope: null, pending: [], history: [], failures: 0
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
async function status() {
  const current = await read();
  return { ...current, diagnostics: await readIssueHistory(current.settings.issueLimit, current.state.diagnosticScope) };
}
function requestFailure(signal, error) {
  return signal.aborted || error?.name === 'TimeoutError'
    ? new CheckError('timeout', '请求超时。')
    : new CheckError('network', '网络请求失败，请检查网络连接。');
}
async function api(path, origin = API) {
  const signal = AbortSignal.timeout(20000);
  let response;
  try {
    // Cookie 由浏览器自动附带；不读取、复制或保存登录凭据。
    response = await fetch(origin + path, {
      credentials: 'include', cache: 'no-store', signal
    });
  } catch (error) {
    throw requestFailure(signal, error);
  }
  if (!response.ok) {
    const code = `HTTP ${response.status}`;
    if (response.status === 429) throw new CheckError('rate-limit', `B 站限制了请求（${code}）。`, code);
    if (response.status === 412) throw new CheckError('rejected', `B 站拒绝了请求（${code}）。`, code);
    throw new CheckError('http', `B 站请求失败（${code}）。`, code);
  }
  let body;
  try { body = await response.json(); }
  catch (error) {
    if (signal.aborted || error?.name === 'TimeoutError' || error instanceof TypeError) {
      throw requestFailure(signal, error);
    }
    throw new CheckError('response', 'B 站返回了无法读取的响应，可打开 B 站网页确认是否需要验证。');
  }
  if (!Number.isSafeInteger(body?.code)) throw new CheckError('response', 'B 站响应缺少有效的状态码。');
  if (body.code !== 0) {
    const code = String(body.code);
    if (body.code === -101) {
      throw new CheckError('login', 'B 站登录已失效，请在当前 Edge 配置文件中重新登录 B 站。', code);
    }
    if (body.code === -412) throw new CheckError('rejected', `B 站拒绝了请求（${code}）。`, code);
    throw new CheckError('api', `B 站接口返回错误（${code}）。`, code);
  }
  return body.data;
}
async function currentAccount() {
  const account = await api('/x/web-interface/nav');
  if (!account?.isLogin || !account.mid) {
    throw new CheckError('login', '请先在当前 Edge 配置文件中登录 B 站。');
  }
  return account;
}
async function followingPage(page, expectedAccount) {
  if (!Number.isSafeInteger(page) || page < 1 || (page > 1 && !expectedAccount)) {
    throw new Error('关注列表页码无效，请重新打开选择面板。');
  }
  const account = numericId((await currentAccount()).mid);
  if (!account) throw new Error('B站未返回有效的登录账号。');
  if (expectedAccount && account !== expectedAccount) return { accountChanged: true };
  const pageSize = 50;
  const data = await api(`/x/relation/followings?vmid=${account}&pn=${page}&ps=${pageSize}&order=desc`);
  if (!Array.isArray(data?.list) || !Number.isSafeInteger(data.total) || data.total < 0) {
    throw new Error('B站未返回有效的关注列表。');
  }
  return { account, total: data.total, people: data.list.map(followingFromItem).filter(Boolean),
    hasMore: page * pageSize < data.total };
}
async function whisperFollowings(expectedAccount) {
  if (!expectedAccount || numericId(expectedAccount) !== expectedAccount) {
    throw new Error('无法确认当前账号，请重新打开选择面板。');
  }
  if (numericId((await currentAccount()).mid) !== expectedAccount) return { accountChanged: true };
  const data = await api('/x/relation/whispers');
  const list = data?.list === null ? [] : data?.list;
  if (!Array.isArray(list)) throw new Error('B站未返回有效的悄悄关注列表。');
  const people = list.map(followingFromItem).filter(Boolean);
  // 旧接口按登录状态返回名单，交付前再确认期间没有切换账号。
  if (people.length && numericId((await currentAccount()).mid) !== expectedAccount) return { accountChanged: true };
  return { people };
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
function notify(item, id, silent, prefix = '') {
  const kind = item.kind ?? 'video';
  const verb = { video: '投稿了新视频', dynamic: '发布了新动态', live: '开播了' }[kind];
  return chrome.notifications.create(id, {
    type: 'basic', iconUrl: NOTIFICATION_ICON, title: `${prefix}${item.author} ${verb}`,
    message: item.title, silent
  });
}

async function liveRooms() {
  if (!await chrome.permissions.contains(LIVE_PERMISSION)) {
    throw new CheckError('permission', '请在设置中允许访问 B站直播接口。');
  }
  return liveFromResponse(await api('/xlive/web-ucenter/v1/xfetter/GetWebList?hit_ab=true', LIVE_ORIGIN));
}
async function flush(state, settings, liveChecked) {
  let sent = false;
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
      try {
        await notify(item, `${kind}:${item.id}${session}`, settings.silent);
      } catch {
        throw new CheckError('notification', '无法发送 Windows 通知，请检查 Edge 和 Windows 的通知设置。');
      }
      sent = true;
    }
    state.pending.splice(index, 1);
    await chrome.storage.local.set({ state });
  }
  return sent;
}

async function scanKind(kind, settings, state) {
  if (kind === 'live') {
    const rooms = await liveRooms();
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

function setGlobalIssue(state, events, source, issue) {
  const previous = state.globalIssues[source];
  const at = Date.now();
  recordIssue(events, source, issue, previous, at);
  if (issue) state.globalIssues[source] = { ...issue, at, failures: (previous?.failures ?? 0) + 1 };
  else delete state.globalIssues[source];
}

async function check(manual = false) {
  const { settings, state: saved } = await read();
  let state = saved;
  if (!settings.enabled && !manual) return;
  const kinds = enabledKinds(settings);
  if (!kinds.length) return;
  state.lastAttempt = Date.now();
  const events = [];
  let resetHistory = false;
  let phase = 'account';
  try {
    const account = await currentAccount();
    const mid = String(account.mid);
    if (state.account !== mid) {
      resetHistory = Boolean(state.account);
      const globalIssues = resetHistory ? {} : state.globalIssues;
      // 用随机标记隔离会话历史，换号时即使会话存储写入失败，也不会显示上一账号的异常。
      const diagnosticScope = resetHistory ? crypto.randomUUID() : state.diagnosticScope;
      state = { ...emptyState(), account: mid, lastAttempt: state.lastAttempt, globalIssues, diagnosticScope };
    }
    state.accountName = String(account.uname ?? mid);
    setGlobalIssue(state, events, 'account', null);
    phase = 'check';
    // 各来源并行读取、分别记录错误，直播或动态接口失败不阻塞投稿检查。
    const due = kinds.filter(kind => manual || !(state.sources[kind]?.retryAt > Date.now()));
    const scans = await Promise.allSettled(due.map(kind => scanKind(kind, settings, state)));
    const records = [];
    let liveChecked = false;
    for (const [index, kind] of due.entries()) {
      const scan = scans[index];
      const previous = state.sources[kind];
      const checkedAt = Date.now();
      if (scan.status === 'rejected') {
        const failures = (previous?.failures ?? 0) + 1;
        const delay = Math.min(60, settings.interval * 2 ** Math.min(failures, 6));
        const issue = describeIssue(scan.reason, { category: 'check', message: '检查此项目时发生异常。', code: null });
        state.sources[kind] = { failures, lastAttempt: checkedAt, lastSuccess: previous?.lastSuccess,
          retryAt: checkedAt + delay * 60000, error: issue.message, issue };
        recordIssue(events, kind, issue, previous?.issue, checkedAt);
        continue;
      }
      const result = recordScan(kind, scan.value, state, settings);
      if (kind === 'live') liveChecked = true;
      records.push(...result.records);
      state.sources[kind] = { note: result.note, lastAttempt: checkedAt, lastSuccess: checkedAt };
      state.lastSuccess = checkedAt;
      recordIssue(events, kind, null, previous?.issue, checkedAt);
    }
    records.sort((a, b) => (b.published || b.detected / 1000) - (a.published || a.detected / 1000));
    state.history = [...records, ...state.history].slice(0, 100);
    state.note = kinds.map(kind => `${KIND_LABELS[kind]}：${state.sources[kind]?.note ?? '等待重试'}`).join('；');
    state.failures = 0;
    state.error = sourceErrors(state, kinds);
    // 先落盘待发送列表，避免后台休眠时丢失整批通知。
    await chrome.storage.local.set({ state });
    if (await flush(state, settings, liveChecked)) setGlobalIssue(state, events, 'notification', null);
    else if (!state.pending.length) delete state.globalIssues.notification;
    setGlobalIssue(state, events, 'check', null);
    if (state.error || Object.keys(state.globalIssues).length) await badge('!');
    else await badge(settings.enabled ? '' : '停', '#64748b');
  } catch (error) {
    const source = error instanceof CheckError && error.category === 'notification' ? 'notification' : phase;
    const issue = describeIssue(error, { category: 'check', message: '扩展运行异常，请重新打开设置页后重试。', code: null });
    setGlobalIssue(state, events, source, issue);
    state.failures = (state.failures || 0) + 1;
    state.error = issue.message;
    await badge('!');
  }
  await schedule(settings, state);
  await chrome.storage.local.set({ state });
  if (events.length || resetHistory) await updateIssueHistory(settings.issueLimit, state.diagnosticScope, events);
}

async function saveSettings(input) {
  const { settings: current, state } = await read();
  const settings = normalizeSettings({ ...input, issueLimit: current.issueLimit });
  for (const kind of KINDS) {
    if (settings.rules[kind].mode !== 'off') continue;
    delete state.sources[kind];
    if (kind === 'video') state.baseline = false;
    if (kind === 'dynamic') state.dynamicBaseline = false;
    if (kind === 'live') state.liveRooms = null;
  }
  state.pending = state.pending.filter(item => matches(item, settings));
  if (!state.pending.length) delete state.globalIssues.notification;
  const kinds = enabledKinds(settings);
  if (!state.failures) state.error = sourceErrors(state, kinds);
  await schedule(settings, state);
  await chrome.storage.local.set({ settings, state });
  const warning = state.error || Object.keys(state.globalIssues).length;
  await badge(settings.enabled && kinds.length ? (warning ? '!' : '') : '停', '#64748b');
}

async function saveIssueLimit(limit) {
  if (!ISSUE_LIMITS.includes(limit)) throw new Error('请选择有效的异常记录保留上限。');
  const { settings, state } = await read();
  await chrome.storage.local.set({ settings: { ...settings, issueLimit: limit } });
  await updateIssueHistory(limit, state.diagnosticScope);
  return status();
}

async function latestTestPost(kind) {
  const video = kind === 'video';
  const maxPages = video ? 1 : (await read()).settings.maxPages;
  const offsets = new Set();
  let offset = '';
  for (let page = 1; page <= maxPages; page++) {
    const data = await feed(video ? 'video' : 'all', offset);
    if (!Array.isArray(data?.items)) throw new Error('B站未返回有效的关注动态列表。');
    const latest = data.items.map(video ? videoFromItem : dynamicFromItem).filter(Boolean)
      .sort((a, b) => b.published - a.published)[0];
    if (latest) return latest;
    if (!data.has_more || page === maxPages) break;
    if (!data.offset || offsets.has(String(data.offset))) throw new Error('B站关注流分页异常，请稍后重试。');
    offset = String(data.offset);
    offsets.add(offset);
  }
  throw new Error(video ? '关注流里没有可用于测试的视频。' : '已检查的关注流里没有可用于测试的普通动态。');
}

async function testNotification(kind = 'video', demo = false) {
  if (!KINDS.includes(kind) || (demo && kind !== 'live')) throw new Error('测试类型无效。');
  let item;
  if (demo) {
    item = { kind, id: 'demo', author: '示例 UP 主', title: '示例直播间 · 点击返回扩展设置' };
  } else {
    await currentAccount();
    item = kind === 'live' ? (await liveRooms())[0] : await latestTestPost(kind);
    if (!item) return { noLive: true };
  }
  // 仅替换同类型的测试横幅，正式通知与检查状态均不受影响。
  const active = await chrome.notifications.getAll();
  for (const id of Object.keys(active)) {
    if (id.startsWith(`test:${kind}:`) || (kind === 'video' && (id === 'test' || id.startsWith('test:BV')))) {
      await chrome.notifications.clear(id);
    }
  }
  await notify(item, `test:${kind}:${item.id}:${crypto.randomUUID()}`, false, demo ? '【测试·演示样例】' : '【测试】');
  return { title: item.title };
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
  const [kind, itemId, testId] = id.split(':');
  const test = kind === 'test';
  const url = test && KINDS.includes(itemId) ? itemUrl(itemId, testId) : itemUrl(test ? 'video' : kind, itemId);
  if (url) void chrome.tabs.create({ url });
  else if (test) void chrome.runtime.openOptionsPage();
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
  // 关注面板只读取数据，无需排队等待状态写入。
  let operation;
  if (message.type === 'followings') operation = followingPage(message.page, message.account);
  else if (message.type === 'whispers') operation = whisperFollowings(message.account);
  else operation = serial(async () => {
    switch (message.type) {
      case 'status': return status();
      case 'check': await check(true); return status();
      case 'save': await saveSettings(message.settings); return status();
      case 'issue-limit': return saveIssueLimit(message.limit);
      case 'test': return testNotification(message.kind, message.demo === true);
      default: throw new Error('未知操作');
    }
  });
  operation.then(result => respond({ result }), error => respond({ error: error.message }));
  return true;
});
// 后台可能被浏览器回收；每次唤醒都确认定时任务仍然存在。
void serial(initialize);

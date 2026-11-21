import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const optionsPage = 'src/options/settings.html';
const { normalizeSettings, videoFromItem, scanFeed, followingFromItem } = await import(new URL('src/core.js', root));
let checks = 0;
function equal(actual, expected) {
  assert.deepEqual(actual, expected);
  checks++;
}

// 所有账号与视频编号均为虚构数据。
function item(number, uid = '10') {
  return {
    id_str: String(number + 1000),
    type: 'DYNAMIC_TYPE_AV',
    modules: {
      module_author: { mid: uid, name: '测试UP', pub_ts: 100 + number },
      module_dynamic: {
        major: { archive: { bvid: `BV${String(number).padStart(10, '0')}`, title: `视频 ${number}` } }
      }
    }
  };
}
function dynamic(number, uid = '20', type = 'DYNAMIC_TYPE_WORD') {
  return { id_str: String(number + 2000), type, modules: {
    module_author: { mid: uid, name: '动态作者', pub_ts: 200 + number },
    module_dynamic: { desc: { text: `动态 ${number}` } }
  } };
}
function room(number, uid = '30', status = 1) {
  return { room_id: number + 3000, uid, live_status: status, uname: '主播', title: `直播 ${number}` };
}

// 设置边界、原创投稿与分页。
equal(normalizeSettings({ interval: 0 }).interval, 1);
equal(normalizeSettings({}).quickCheck, true);
equal(normalizeSettings({}).fullInterval, 15);
equal(normalizeSettings({ interval: 25 }).fullInterval, 25);
equal(normalizeSettings({ fullInterval: 0, quickCheck: false }).fullInterval, 5);
equal(normalizeSettings({ maxPages: 99 }).maxPages, 10);
equal(normalizeSettings({}).issueLimit, 50);
equal(normalizeSettings({ issueLimit: 99 }).issueLimit, 50);
equal(normalizeSettings({ mode: 'selected', uids: ['10', 'abc', '10'] }).rules, {
  video: { mode: 'selected', uids: ['10'] }, dynamic: { mode: 'off', uids: [] }, live: { mode: 'off', uids: [] }
});
equal(videoFromItem({ ...item(1), type: 'DYNAMIC_TYPE_FORWARD' }), null);
equal(videoFromItem({ type: 'DYNAMIC_TYPE_AV' }), null);
equal(followingFromItem({ mid: 42, uname: ' 示例 UP ', face: 'http://i1.hdslb.com/bfs/face/sample.png' }),
  { uid: '42', name: '示例 UP', avatar: 'https://i1.hdslb.com/bfs/face/sample.png' });
equal(followingFromItem({ mid: '42', face: 'https://i1.hdslb.com.example.test/bfs/face/sample.png' }),
  { uid: '42', name: 'UID 42', avatar: '' });
equal(followingFromItem({ mid: Number.MAX_SAFE_INTEGER + 1 }), null);

let calls = 0;
let scan = await scanFeed(async () => {
  calls++;
  return { items: [item(2)], has_more: true, offset: 'a' };
}, [], 5);
equal(calls, 1);
equal(scan.fresh.length, 1);

scan = await scanFeed(async offset => offset
  ? { items: [item(2), item(1)], has_more: false }
  : { items: [item(3)], has_more: true, offset: 'a' }, ['BV0000000001'], 5);
equal(scan.fresh.map(video => video.id), ['BV0000000003', 'BV0000000002']);
equal(scan.pages, 2);
equal(scan.gap, false);
scan = await scanFeed(async () => ({ items: [item(3)], has_more: true, offset: 'a' }), ['BV0000000001'], 1);
equal(scan.gap, true);
await assert.rejects(scanFeed(async () => ({ items: [], has_more: true, offset: 'a' }), ['x'], 3));
checks++;
await assert.rejects(scanFeed(async () => ({}), ['x'], 3));
checks++;

// 后台集成模拟：存储、定时任务、通知、消息与 B站响应均留在本进程。
const store = { settings: { mode: 'all', uids: ['77'], quickCheck: false } };
const sessionStore = {};
const issueEntries = (entries = sessionStore.recentIssues.entries) => entries.filter(entry => Object.hasOwn(entry, 'issue'));
const alarms = new Map();
const sent = [];
const activeNotifications = new Map();
const cleared = [];
const opened = [];
const focusedWindows = [];
const newWindows = [];
let currentWindow = { id: 1, state: 'normal', focused: true };
let closeWindowOnOpen = false;
let notificationFail = false;
let mid = '100';
let feed = [item(1)];
let dynamics = [];
let rooms = [];
let apiFailure = false;
let missingLivePermission = false;
let liveFailure = false;
let liveHttpStatus = 0;
let dynamicError;
let unavailableSession = false;
let liveCalls = 0;
let accountCalls = 0;
let updateBaseline;
let updateNum = 0;
let updateStatus = 0;
const probeCalls = [];
const feedCalls = [];
const followingCalls = [];
const followingPages = new Map();
let whisperResponse = { code: 0, data: { list: [{ mid: '70', uname: '旧悄悄关注样例', attribute: 1 }] } };
let switchAccountOnWhispers = false;
let whisperCalls = 0;
const dynamicPages = new Map();
const event = () => ({ addListener(listener) { this.listener = listener; } });

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        return structuredClone(Object.fromEntries(keys.map(key => [key, store[key]])));
      },
      async set(value) { Object.assign(store, structuredClone(value)); },
      async setAccessLevel() {}
    },
    session: {
      async get(key) { return structuredClone({ [key]: sessionStore[key] }); },
      async set(value) {
        if (unavailableSession) throw Error('会话存储不可用');
        Object.assign(sessionStore, structuredClone(value));
      }
    }
  },
  alarms: {
    async get(name) { return alarms.get(name); },
    async create(name, options) { alarms.set(name, { scheduledTime: options.when }); },
    async clear(name) { alarms.delete(name); },
    onAlarm: event()
  },
  action: {
    async setBadgeText() {},
    async setBadgeBackgroundColor() {},
    onClicked: event()
  },
  notifications: {
    async create(id, options) {
      // 按后台脚本位置解析图标，实际读取图片，覆盖移动目录后的资源加载。
      const icon = new URL(options.iconUrl, chrome.runtime.getURL('src/background.js'));
      assert.equal(icon.protocol, 'chrome-extension:');
      assert.equal(icon.hostname, chrome.runtime.id);
      const bytes = await fs.readFile(new URL(`.${icon.pathname}`, root));
      assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      if (notificationFail) throw Error('通知失败');
      sent.push({ id, ...options });
      activeNotifications.set(id, options);
    },
    async getAll() { return Object.fromEntries(activeNotifications); },
    async clear(id) {
      cleared.push(id);
      return activeNotifications.delete(id);
    },
    onClicked: event()
  },
  tabs: {
    async create(options) {
      if (closeWindowOnOpen) currentWindow = null;
      if (!currentWindow || options.windowId !== currentWindow.id) throw Error('没有可用的浏览器窗口');
      opened.push(options);
    }
  },
  windows: {
    async getLastFocused() {
      if (!currentWindow) throw Error('没有可用的浏览器窗口');
      return { ...currentWindow };
    },
    async create(options) { newWindows.push(options); },
    async update(id, options) { focusedWindows.push({ id, ...options }); }
  },
  permissions: {
    async contains({ origins }) {
      equal(origins, ['https://api.live.bilibili.com/*']);
      return !missingLivePermission;
    }
  },
  runtime: {
    id: 'test-extension',
    getURL: relative => `chrome-extension://test-extension/${relative}`,
    onInstalled: event(),
    onStartup: event(),
    onMessage: event(),
    async openOptionsPage() { opened.push('options'); }
  }
};
globalThis.fetch = async (url, options) => {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith('/feed/all/update')) {
    assert.equal(options.credentials, 'include');
    probeCalls.push(Object.fromEntries(parsed.searchParams));
    if (updateStatus) return { ok: false, status: updateStatus };
    return { ok: true, async json() { return { code: 0, data: { update_num: updateNum } }; } };
  }
  if (parsed.pathname.endsWith('/feed/all')) feedCalls.push(parsed.searchParams.get('type'));
  if (parsed.pathname === '/x/web-interface/nav') accountCalls++;
  if (parsed.hostname === 'api.live.bilibili.com') {
    liveCalls++;
    if (liveHttpStatus) return { ok: false, status: liveHttpStatus };
  }
  if (parsed.searchParams.get('type') === 'all' && dynamicError) throw dynamicError;
  return {
    ok: true,
    async json() {
      if (apiFailure) return { code: -101 };
      if (parsed.hostname === 'api.live.bilibili.com') {
        return liveFailure ? { code: -412, message: '模拟服务端原始响应，不应被保存' } : { code: 0, data: { rooms } };
      }
      if (parsed.pathname === '/x/relation/followings') {
        const query = Object.fromEntries(parsed.searchParams);
        followingCalls.push(query);
        return { code: 0, data: followingPages.get(query.pn) };
      }
      if (parsed.pathname === '/x/relation/whispers') {
        assert.equal(options.credentials, 'include');
        assert.equal(parsed.search, '');
        whisperCalls++;
        if (switchAccountOnWhispers) mid = '300';
        return whisperResponse;
      }
      if (parsed.searchParams.get('type') === 'all') {
        const page = dynamicPages.get(parsed.searchParams.get('offset') ?? '');
        if (page) return { code: 0, data: page };
      }
      return { code: 0, data: parsed.pathname.endsWith('/nav')
        ? { isLogin: true, mid, uname: '测试账号' }
        : { items: parsed.searchParams.get('type') === 'all' ? [...dynamics, ...feed] : feed,
          has_more: false, update_baseline: updateBaseline } };
    }
  };
};
await import(new URL('src/background.js', root));

function request(message, sender = {
  id: chrome.runtime.id, url: chrome.runtime.getURL(optionsPage), tab: { id: 123 }
}) {
  return new Promise((resolve, reject) => {
    const held = chrome.runtime.onMessage.listener(message, sender, response => {
      if (response.error) reject(Error(response.error));
      else resolve(response.result);
    });
    if (held !== true) reject(Error('合法设置页未保持响应通道'));
  });
}
const message = (type, extra = {}) => request({ type, ...extra,
  ...(type === 'save' ? { settings: { quickCheck: false, ...extra.settings } } : {}) });
function fireAlarm(name = 'check-videos') {
  const alarm = alarms.get(name);
  assert.ok(alarm, `缺少闹钟 ${name}`);
  alarms.delete(name);
  chrome.alarms.onAlarm.listener({ name, ...alarm });
  return message('status');
}

// 首次基线、定时新投稿与重复查询。
await message('check');
equal(store.state.lastTrigger, 'manual');
equal(store.settings.rules.video, { mode: 'all', uids: ['77'] });
equal(store.state.baseline, true);
equal(sent.length, 0);
equal(store.state.account, '100');
feed = [item(2), item(1)];
await fireAlarm();
equal(store.state.lastTrigger, 'alarm');
equal(sent.length, 1);
equal(sent[0].id, 'video:BV0000000002');
await message('check');
equal(sent.length, 1);

// 保存设置后按 UID 过滤；账号切换重建基线。
await message('save', { settings: { interval: 7, enabled: true, mode: 'selected', uids: ['99'] } });
equal(store.settings.interval, 7);
equal(Math.round((store.state.nextCheck - Date.now()) / 60000), 7);
feed = [item(3), ...feed];
await message('check');
equal(sent.length, 1);
feed = [item(4, '99'), ...feed];
await message('check');
equal(sent.length, 2);
mid = '200';
await message('check');
equal(sent.length, 2);
equal(store.state.account, '200');

// 面板只能查询当前账号，后续页发现账号切换时不混入其他账号列表。
const beforeFollowing = structuredClone(store);
followingPages.set('1', { total: 51, list: Array.from({ length: 50 }, (_, index) => ({
  mid: index + 10, uname: `测试关注 ${index + 1}`
})) });
followingPages.set('2', { total: 51, list: [{ mid: '60', uname: '第二页关注' }] });
const firstFollowing = await message('followings', { page: 1 });
equal(firstFollowing.account, '200');
equal(firstFollowing.total, 51);
equal(firstFollowing.hasMore, true);
equal(firstFollowing.people.length, 50);
equal(await message('followings', { page: 2, account: firstFollowing.account }), {
  account: '200', total: 51, hasMore: false, people: [{ uid: '60', name: '第二页关注', avatar: '' }]
});
equal(followingCalls, [1, 2].map(page => ({ vmid: '200', pn: String(page), ps: '50', order: 'desc' })));
mid = '300';
equal(await message('followings', { page: 2, account: firstFollowing.account }), { accountChanged: true });
equal(followingCalls.length, 2);
mid = '200';
await assert.rejects(message('followings', { page: 2 }), /页码无效/);
checks++;
followingPages.set('1', { total: 0, list: [] });
equal(await message('followings', { page: 1 }), { account: '200', total: 0, hasMore: false, people: [] });
followingPages.set('1', { total: 51, list: null });
await assert.rejects(message('followings', { page: 1 }), /有效的关注列表/);
checks++;
equal(store, beforeFollowing);

// 普通分页之外读取旧悄悄关注。错误或换号时不影响既有设置与普通关注。
equal(await message('whispers', { account: '200' }), {
  people: [{ uid: '70', name: '旧悄悄关注样例', avatar: '' }]
});
equal(await message('whispers', { account: '300' }), { accountChanged: true });
equal(whisperCalls, 1);
switchAccountOnWhispers = true;
equal(await message('whispers', { account: '200' }), { accountChanged: true });
equal(whisperCalls, 2);
mid = '200';
switchAccountOnWhispers = false;
whisperResponse = { code: 0, data: { list: null } };
equal(await message('whispers', { account: '200' }), { people: [] });
whisperResponse = { code: 0, data: {} };
await assert.rejects(message('whispers', { account: '200' }), /有效的悄悄关注列表/);
checks++;
whisperResponse = { code: -404, message: '不存在' };
await assert.rejects(message('whispers', { account: '200' }), /-404/);
checks++;
followingPages.set('1', { total: 1, list: [{ mid: '10', uname: '普通关注样例' }] });
equal((await message('followings', { page: 1 })).people.map(person => person.uid), ['10']);
equal(store, beforeFollowing);

// 连续失败退避，成功后恢复正常间隔。
apiFailure = true;
await message('check');
equal(store.state.failures, 1);
equal(store.state.globalIssues.account.category, 'login');
equal(issueEntries().at(-1).issue.code, '-101');
equal(Math.round((store.state.nextCheck - Date.now()) / 60000), 14);
await message('check');
equal(store.state.failures, 2);
equal(issueEntries().at(-1).count, 2);
equal(Math.round((store.state.nextCheck - Date.now()) / 60000), 28);
// Edge 在退避期间重新启动时，保留原检查时间，闹钟丢失时按原时间补建。
const beforeRestart = { state: structuredClone(store.state), accountCalls };
const retryAlarm = alarms.get('check-videos');
equal(retryAlarm.scheduledTime, beforeRestart.state.nextCheck);
chrome.runtime.onStartup.listener();
await message('status');
equal(store.state, beforeRestart.state);
equal(accountCalls, beforeRestart.accountCalls);
equal(alarms.get('check-videos'), retryAlarm);
alarms.delete('check-videos');
chrome.runtime.onStartup.listener();
await message('status');
equal(alarms.get('check-videos'), retryAlarm);
equal(store.state, beforeRestart.state);
equal(accountCalls, beforeRestart.accountCalls);
apiFailure = false;
await message('check');
equal(store.state.failures, 0);
equal(store.state.error, '');
equal(issueEntries().at(-1).source, 'account');
equal(issueEntries().at(-1).issue, null);

// 暂停取消定时任务，但仍允许手动检查。
await message('save', { settings: { enabled: false } });
equal(alarms.size, 0);
feed = [item(5), ...feed];
await message('check');
equal(store.state.seen.includes('BV0000000005'), true);
equal(alarms.size, 0);

// 通知失败保留待发送项，恢复后只补发一次。
await message('save', { settings: { enabled: true } });
notificationFail = true;
feed = [item(6), ...feed];
await message('check');
equal(store.state.pending.length, 1);
equal(issueEntries().at(-1).issue.category, 'notification');
equal(issueEntries().at(-1).level, 'error');
notificationFail = false;
await message('check');
equal(store.state.pending.length, 0);
equal(sessionStore.recentIssues.entries.some(entry => entry.source === 'notification' &&
  entry.level === 'info' && entry.message === '视频投稿：Edge 已接受 1 条通知。'), true);
equal(issueEntries().at(-1).source, 'notification');
equal(issueEntries().at(-1).issue, null);
equal(sent.at(-1).id, 'video:BV0000000006');
await message('check');
equal(sent.filter(notification => notification.id === 'video:BV0000000006').length, 1);

// 连续点击均创建新通知，清理旧测试提醒但保留真实视频通知。
activeNotifications.set('test', { message: '旧版测试通知' });
const beforeTest = structuredClone(store);
const beforeTestIssues = structuredClone(issueEntries());
feed = [item(6), item(7), ...feed.slice(1)];
equal(await message('test'), { title: '视频 7' });
const firstTest = sent.at(-1).id;
equal(firstTest.startsWith('test:video:BV0000000007:'), true);
equal(sent.at(-1).title, '【测试】测试UP 投稿了新视频');
equal(sent.at(-1).message, '视频 7');
equal(cleared.includes('test'), true);
await message('test');
const secondTest = sent.at(-1).id;
equal(secondTest !== firstTest, true);
equal(activeNotifications.has(firstTest), false);
equal(activeNotifications.has(secondTest), true);
equal(activeNotifications.has('video:BV0000000006'), true);
await chrome.notifications.onClicked.listener(secondTest);
equal(opened.at(-1).url, 'https://www.bilibili.com/video/BV0000000007/');
await chrome.notifications.onClicked.listener('video:BV0000000006');
equal(opened.at(-1).url, 'https://www.bilibili.com/video/BV0000000006/');
equal(store, beforeTest);
equal(issueEntries(), beforeTestIssues);
equal(sessionStore.recentIssues.entries.slice(-2).map(({ source, level, message }) => [source, level, message]), [
  ['test', 'info', '视频投稿测试：Edge 已接受通知。'], ['test', 'info', '视频投稿测试：Edge 已接受通知。']
]);
equal(liveCalls, 0);

// 测试动态跳过纯视频首页，测试直播跳过未开播房间，两者都不消耗正式检查记录。
await message('test', { kind: 'video' });
const previewVideo = sent.at(-1).id;
dynamicPages.set('', { items: [item(7), dynamic(8, '30', 'DYNAMIC_TYPE_LIVE_RCMD')], has_more: true, offset: 'next' });
dynamicPages.set('next', { items: [dynamic(1), dynamic(2), item(6)], has_more: false });
equal(await message('test', { kind: 'dynamic' }), { title: '动态 2' });
const firstPreviewDynamic = sent.at(-1).id;
equal(firstPreviewDynamic.startsWith('test:dynamic:2002:'), true);
equal(sent.at(-1).title, '【测试】动态作者 发布了新动态');
await message('test', { kind: 'dynamic' });
const previewDynamic = sent.at(-1).id;
equal(previewDynamic !== firstPreviewDynamic, true);
equal(activeNotifications.has(firstPreviewDynamic), false);
equal(activeNotifications.has(previewVideo), true);
await chrome.notifications.onClicked.listener(previewDynamic);
equal(opened.at(-1).url, 'https://t.bilibili.com/2002');
await chrome.notifications.onClicked.listener('test:BV0000000007:legacy');
equal(opened.at(-1).url, 'https://www.bilibili.com/video/BV0000000007/');
dynamicPages.clear();
await assert.rejects(message('test', { kind: 'dynamic' }), /没有可用于测试的普通动态/);
checks++;

missingLivePermission = true;
await assert.rejects(message('test', { kind: 'live' }), /允许访问 B站直播接口/);
checks++;
missingLivePermission = false;
rooms = [room(1, '30', 0), room(2)];
equal(await message('test', { kind: 'live' }), { title: '直播 2' });
const previewLive = sent.at(-1).id;
equal(previewLive.startsWith('test:live:3002:'), true);
equal(sent.at(-1).title, '【测试】主播 开播了');
await chrome.notifications.onClicked.listener(previewLive);
equal(opened.at(-1).url, 'https://live.bilibili.com/3002');
rooms = [];
const beforeEmptyLive = sent.length;
equal(await message('test', { kind: 'live' }), { noLive: true });
equal(sent.length, beforeEmptyLive);
const beforeDemo = liveCalls;
await message('test', { kind: 'live', demo: true });
const previewDemo = sent.at(-1).id;
equal(liveCalls, beforeDemo);
equal(previewDemo.startsWith('test:live:demo:'), true);
equal(sent.at(-1).title, '【测试·演示样例】示例 UP 主 开播了');
await chrome.notifications.onClicked.listener(previewDemo);
equal(opened.at(-1), 'options');
equal(store, beforeTest);
equal(issueEntries().slice(0, -2), beforeTestIssues);
equal(issueEntries().slice(-2).map(({ source, level }) => [source, level]), [['test', 'warning'], ['test', 'warning']]);

// 新增类别各自建立基线，不能改写已保存的投稿进度。
const rules = {
  video: { mode: 'selected', uids: ['10'] },
  dynamic: { mode: 'selected', uids: ['20'] },
  live: { mode: 'selected', uids: ['30'] }
};
feed = feed.filter(video => video.id_str !== '1007');
dynamics = [dynamic(1)];
rooms = [room(1)];
await message('save', { settings: { interval: 7, rules } });
const sentBeforeNewKinds = sent.length;
await message('check');
equal(sent.length, sentBeforeNewKinds);
equal(store.state.seen.includes('BV0000000006'), true);
equal(store.state.dynamicSeen.includes('2001'), true);
equal(store.state.liveRooms, ['3001']);
equal(sessionStore.recentIssues.entries.some(entry => entry.source === 'live' &&
  entry.level === 'info' && entry.message.includes('已建立基线')), true);

// 各类别只按自己的 UID 过滤，视频和直播推荐不会再触发动态提醒。
feed = [item(8, '20'), item(9), ...feed];
dynamics = [dynamic(2, '20', 'DYNAMIC_TYPE_DRAW'), dynamic(3, '30'),
  dynamic(4, '20', 'DYNAMIC_TYPE_LIVE_RCMD'), dynamic(5, '20', 'DYNAMIC_TYPE_FORWARD'), ...dynamics];
rooms = [room(1), room(2), room(3, '20'), room(4, '30', 2)];
await message('check');
equal(sent.slice(sentBeforeNewKinds).map(entry => entry.id.replace(/^(live:\d+):.+$/, '$1')),
  ['video:BV0000000009', 'dynamic:2002', 'dynamic:2005', 'live:3002']);
const firstLive = sent.at(-1).id;
const dynamicLog = sessionStore.recentIssues.entries.findLast(entry => entry.source === 'dynamic');
equal(dynamicLog.message, '读取 1 页，发现 3 条新内容，筛掉 1 条，2 条加入待发队列。');
equal(dynamicLog.trigger, 'manual');
equal(dynamicLog.details.groups, [
  { outcome: 'filtered', total: 1, items: [
    { kind: 'dynamic', id: '2003', author: '动态作者', title: '动态 3' }
  ] },
  { outcome: 'queued', total: 2, items: [
    { kind: 'dynamic', id: '2002', author: '动态作者', title: '动态 2' },
    { kind: 'dynamic', id: '2005', author: '动态作者', title: '动态 5' }
  ] }
]);
const acceptedLog = sessionStore.recentIssues.entries.findLast(entry =>
  entry.source === 'notification' && entry.message.startsWith('普通动态'));
equal(acceptedLog.details.groups, [{ ...dynamicLog.details.groups[1], outcome: 'accepted' }]);
equal(acceptedLog.trigger, 'manual');
await chrome.notifications.onClicked.listener('dynamic:2002');
equal(opened.at(-1).url, 'https://t.bilibili.com/2002');
await chrome.notifications.onClicked.listener(firstLive);
equal(opened.at(-1).url, 'https://live.bilibili.com/3002');

// Edge 在后台运行时，点击通知也应打开原动态，并让目标窗口可见。
const dynamicUrl = 'https://t.bilibili.com/2002';
const tabCount = opened.length;
const beforeNotificationClick = structuredClone(store);
currentWindow = null;
await chrome.notifications.onClicked.listener('dynamic:2002');
equal(newWindows, [{ url: dynamicUrl, type: 'normal', focused: true }]);
equal(opened.length, tabCount);
equal(cleared.at(-1), 'dynamic:2002');

currentWindow = { id: 2, state: 'minimized', focused: false };
await chrome.notifications.onClicked.listener(previewDynamic);
equal(opened.at(-1), { url: dynamicUrl, windowId: 2 });
equal(focusedWindows.at(-1), { id: 2, state: 'normal', focused: true });
equal(newWindows.length, 1);

currentWindow = { id: 3, state: 'maximized', focused: false };
await chrome.notifications.onClicked.listener('dynamic:2002');
equal(opened.at(-1), { url: dynamicUrl, windowId: 3 });
equal(focusedWindows.at(-1), { id: 3, focused: true });

closeWindowOnOpen = true;
await chrome.notifications.onClicked.listener('dynamic:2002');
equal(newWindows.at(-1), { url: dynamicUrl, type: 'normal', focused: true });
equal(newWindows.length, 2);
equal(store, beforeNotificationClick);
closeWindowOnOpen = false;
currentWindow = { id: 1, state: 'normal', focused: true };

// 持续直播只提醒一次，关播后再次开播可以产生新横幅。
await message('check');
equal(sent.length, sentBeforeNewKinds + 4);
rooms = [room(1)];
await message('check');
rooms = [room(1), room(2)];
await message('check');
equal(sent.at(-1).id.startsWith('live:3002:'), true);
equal(sent.at(-1).id !== firstLive, true);

// 部分接口与权限失败时，投稿仍然可发，失败不会覆盖直播快照。
liveFailure = true;
const lastLiveSuccess = store.state.sources.live.lastSuccess;
feed = [item(10), ...feed];
await message('check');
equal(sent.at(-1).id, 'video:BV0000000010');
equal(store.state.error.includes('直播开播'), true);
equal(store.state.liveRooms, ['3001', '3002']);
equal(store.state.sources.live.lastSuccess, lastLiveSuccess);
equal(store.state.sources.live.issue.category, 'rejected');
equal(store.state.sources.live.issue.code, '-412');
equal(JSON.stringify(sessionStore).includes('模拟服务端原始响应'), false);
const beforeRetryIssue = structuredClone(issueEntries().findLast(entry => entry.source === 'live'));
liveFailure = false;
const beforeRetry = liveCalls;
await fireAlarm();
equal(liveCalls, beforeRetry);
equal(issueEntries().findLast(entry => entry.source === 'live'), beforeRetryIssue);
equal(sessionStore.recentIssues.entries.some(entry => entry.source === 'live' &&
  entry.level === 'warning' && entry.message === '仍在等待重试，本轮跳过。'), true);
missingLivePermission = true;
await message('check');
equal(liveCalls, beforeRetry);
equal(store.state.error.includes('允许访问 B站直播接口'), true);
equal(issueEntries().at(-1).issue.category, 'permission');
missingLivePermission = false;
await message('check');
equal(store.state.error, '');
equal(issueEntries().at(-1).source, 'live');
equal(issueEntries().at(-1).issue, null);

// 关闭再开启只重新建立对应类别的基线。
await message('save', { settings: { rules: { ...rules, live: { mode: 'off' } } } });
equal(store.state.liveRooms, null);
equal(store.state.dynamicBaseline, true);
rooms = [room(7)];
await message('save', { settings: { rules } });
const beforeReenable = sent.length;
await message('check');
equal(store.state.liveRooms, ['3007']);
equal(sent.length, beforeReenable);

// 开播提醒发送失败后，直播列表暂时不可用也不阻塞新的投稿。
rooms = [room(8)];
notificationFail = true;
await message('check');
equal(store.state.pending.map(entry => entry.kind), ['live']);
notificationFail = false;
liveFailure = true;
feed = [item(11), ...feed];
await message('check');
equal(sent.at(-1).id, 'video:BV0000000011');
equal(store.state.pending.map(entry => entry.kind), ['live']);
liveFailure = false;
rooms = [];
const beforeEnded = sent.length;
await message('check');
equal(store.state.pending.length, 0);
equal(sent.length, beforeEnded);

// 自动检查仍会读取健康来源，异常记录跨来源按最后一次发生时间排列。
await message('save', { settings: { interval: 3, rules } });
liveHttpStatus = 429;
await message('check');
equal(store.state.sources.live.issue.category, 'rate-limit');
equal(store.state.sources.live.issue.code, 'HTTP 429');
equal(store.state.sources.live.retryAt - store.state.sources.live.lastAttempt, 6 * 60000);
equal(store.state.nextCheck < store.state.sources.live.retryAt, true);
dynamicError = new DOMException('模拟超时详情', 'TimeoutError');
await message('check');
let entries = issueEntries((await message('status')).diagnostics.entries);
equal(entries[0].source, 'live');
equal(entries[0].count, 2);
equal(entries[1].issue.category, 'timeout');
equal(entries[1].issue.message, '请求超时。');
dynamicError = new TypeError('模拟网络详情');
await message('check');
entries = issueEntries((await message('status')).diagnostics.entries);
equal(entries[0].count, 3);
equal(entries[1].issue.category, 'network');
equal(entries[1].count, 1);
equal(JSON.stringify(sessionStore).includes('模拟'), false);
equal(Object.hasOwn(store, 'recentIssues'), false);
equal(entries[0].level, 'warning');
equal(entries[0].retryAt, store.state.sources.live.retryAt);
equal(Object.keys(entries[0]), ['source', 'level', 'issue', 'retryAt', 'trigger', 'firstAt', 'lastAt', 'count']);
dynamicError = undefined;
liveHttpStatus = 0;
await message('check');
equal(issueEntries((await message('status')).diagnostics.entries).slice(0, 2).map(entry => [entry.source, entry.issue]),
  [['live', null], ['dynamic', null]]);
liveHttpStatus = 429;
await message('check');
equal((await message('status')).diagnostics.entries[0].count, 1);

// 调整上限会立即丢弃最旧的记录，且不会重新安排下一次检查。
for (let index = 0; index < 28; index++) {
  liveHttpStatus = index % 2 ? 429 : 503;
  await message('check');
}
equal(sessionStore.recentIssues.entries.length > 20, true);
const alarmBeforeLimit = store.state.nextCheck;
const latest20 = sessionStore.recentIssues.entries.slice(-20).reverse();
const smaller = await message('issue-limit', { limit: 20 });
equal(smaller.settings.issueLimit, 20);
equal(smaller.diagnostics.entries, latest20);
equal(store.state.nextCheck, alarmBeforeLimit);
equal(sessionStore.recentIssues.entries.length, 20);
await message('issue-limit', { limit: 100 });
equal(sessionStore.recentIssues.entries.length, 20);
await assert.rejects(message('issue-limit', { limit: 500 }), /有效的日志保留上限/);
checks++;
await message('save', { settings: { interval: 3, rules } });
equal(store.settings.issueLimit, 100);
await message('issue-limit', { limit: 20 });
await message('check');
equal(sessionStore.recentIssues.entries.length, 20);

// 退出后历史不会由本地状态重建。会话异常不影响真实提醒或运行状态。
delete sessionStore.recentIssues;
equal((await message('status')).diagnostics, { entries: [], available: true });
equal(store.state.sources.live.error.length > 0, true);
unavailableSession = true;
feed = [item(12), ...feed];
const unavailable = await message('check');
equal(unavailable.diagnostics.available, false);
equal(sent.at(-1).id, 'video:BV0000000012');
equal(unavailable.state.nextCheck < unavailable.state.sources.live.retryAt, true);
unavailableSession = false;
await message('check');
equal(issueEntries((await message('status')).diagnostics.entries).length, 1);
mid = '300';
liveHttpStatus = 0;
const previousScope = sessionStore.recentIssues.scope;
unavailableSession = true;
const newAccount = await message('check');
equal(newAccount.state.account, '300');
equal(newAccount.diagnostics.entries, []);
equal(newAccount.state.diagnosticScope === previousScope, false);
equal(sessionStore.recentIssues.scope, previousScope);
unavailableSession = false;
liveHttpStatus = 429;
await message('check');
equal(sessionStore.recentIssues.scope, newAccount.state.diagnosticScope);
equal(issueEntries().length, 1);
liveHttpStatus = 0;

// 关停期间错过的计划可在启动后补查，排队中的旧闹钟不会重复查询。
const missedCheck = Date.now() - 60000;
store.state.nextCheck = missedCheck;
store.state.plan = { content: missedCheck, live: missedCheck };
alarms.delete('check-videos');
const beforeCatchUp = accountCalls;
chrome.runtime.onStartup.listener();
chrome.alarms.onAlarm.listener({ name: 'check-videos', scheduledTime: missedCheck });
equal((await message('status')).state.lastTrigger, 'startup');
equal(accountCalls, beforeCatchUp + 1);
equal(store.state.nextCheck > Date.now(), true);
const nextAlarm = alarms.get('check-videos');
alarms.delete('check-videos');
chrome.alarms.onAlarm.listener({ name: 'check-videos', ...nextAlarm });
equal((await message('status')).state.lastTrigger, 'alarm');
equal(accountCalls, beforeCatchUp + 2);
chrome.runtime.onInstalled.listener();
equal((await message('status')).state.lastTrigger, 'installed');

// 从旧设置升级，保留已有基线。使用可控时间验证两种闹钟的排期。
const quickAlarm = 'check-feed-updates';
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
async function tick(name, at = alarms.get(name).scheduledTime) {
  clock = Math.max(clock, at);
  return fireAlarm(name);
}
const quickRules = Object.fromEntries(['video', 'dynamic', 'live'].map(kind => [kind, { mode: 'all', uids: [] }]));
await message('check');
store.settings = { ...store.settings, interval: 3, rules: quickRules };
delete store.settings.quickCheck;
delete store.settings.fullInterval;
updateBaseline = '900000000000000123';
chrome.runtime.onInstalled.listener();
let quickState = (await message('status')).state;
equal(store.settings.quickCheck, true);
equal(quickState.quick.type, 'all');
equal(quickState.quick.next - clock, 30000);
equal(quickState.plan.content - clock, 15 * 60000);
equal(quickState.plan.live - clock, 3 * 60000);
const initialContentPlan = quickState.plan.content;
const initialLivePlan = quickState.plan.live;
const initialQuickAttempt = quickState.lastAttempt;
const quietFeedCalls = feedCalls.length;
const quietAccountCalls = accountCalls;
const quietLiveCalls = liveCalls;
const firstQuiet = await tick(quickAlarm);
const secondQuiet = await tick(quickAlarm);
quickState = secondQuiet.state;
const quietLog = secondQuiet.diagnostics.entries[0];
equal(quietLog.level, 'info');
equal(quietLog.message, 'B 站返回 0 条更新，本轮未读取内容列表。');
equal(quietLog.count, 2);
equal(quietLog.firstAt, firstQuiet.diagnostics.entries[0].lastAt);
equal(quietLog.lastAt, clock);
equal(probeCalls.at(-1), { type: 'all', update_baseline: '900000000000000123' });
equal(feedCalls.length, quietFeedCalls);
equal(accountCalls, quietAccountCalls);
equal(liveCalls, quietLiveCalls);
equal(quickState.lastAttempt, initialQuickAttempt);
equal(quickState.plan, { content: initialContentPlan, live: initialLivePlan });

// 重新唤醒时找回计数闹钟，但不提前跑常规检查。
const quickDeadline = quickState.quick.next;
alarms.delete(quickAlarm);
chrome.runtime.onStartup.listener();
equal((await message('status')).state.quick.next, quickDeadline);
equal(alarms.get(quickAlarm).scheduledTime, quickDeadline);
equal(accountCalls, quietAccountCalls);

const beforeQuickNotify = sent.length;
updateNum = 2;
updateBaseline = '900000000000000456';
feed = [item(70), ...feed];
dynamics = [dynamic(5001), ...dynamics];
const afterUpdate = await tick(quickAlarm);
quickState = afterUpdate.state;
equal(afterUpdate.diagnostics.entries.some(entry => entry.source === 'quick' &&
  entry.message === 'B 站报告 2 条更新，开始读取内容列表。'), true);
equal(afterUpdate.diagnostics.entries.some(entry => entry.source === 'dynamic' &&
  entry.message.includes('1 条加入待发队列')), true);
equal(quickState.lastTrigger, 'quick');
equal(quickState.quick.cursor, updateBaseline);
equal(feedCalls.slice(quietFeedCalls), ['all', 'video']);
equal(sent.slice(beforeQuickNotify).map(entry => entry.id).sort(), ['dynamic:7001', 'video:BV0000000070']);
equal(liveCalls, quietLiveCalls);
equal(quickState.plan.live, initialLivePlan);
equal(quickState.plan.content - clock, 15 * 60000);

// 数量偶尔仍大于零也不会重复发送。同一轮一类失败时不推进共同基线。
updateBaseline = '900000000000000457';
dynamicError = new Error('模拟动态请求失败');
quickState = (await tick(quickAlarm)).state;
equal(quickState.quick.cursor, '900000000000000456');
equal(quickState.quick.next, quickState.sources.dynamic.retryAt);
equal(sent.length, beforeQuickNotify + 2);
dynamicError = undefined;

// 直播仍按设置独立检查，计数限流时完整扫描仍能找回新内容。
const beforeLiveOnly = feedCalls.length;
quickState = (await tick('check-videos')).state;
equal(feedCalls.length, beforeLiveOnly);
equal(liveCalls, quietLiveCalls + 1);
updateStatus = 429;
let result = await tick(quickAlarm);
quickState = result.state;
equal(quickState.quick.next - clock, 60000);
equal(quickState.globalIssues.quick.code, 'HTTP 429');
equal(result.diagnostics.entries[0].source, 'quick');
equal(result.diagnostics.entries[0].level, 'warning');
equal(result.diagnostics.entries[0].retryAt, quickState.quick.next);
equal(feedCalls.length, beforeLiveOnly);

const fallbackAt = quickState.plan.content;
const beforeFallback = probeCalls.length;
feed = [item(71), ...feed];
updateBaseline = '900000000000000458';
result = await tick('check-videos', fallbackAt);
equal(result.state.lastTrigger, 'alarm');
equal(result.state.quick.cursor, updateBaseline);
equal(sent.at(-1).id, 'video:BV0000000071');
equal(probeCalls.length, beforeFallback);
equal(result.state.quick.next, quickState.quick.next);
updateStatus = 0;
updateNum = 0;
result = await tick(quickAlarm);
equal(result.state.globalIssues.quick, undefined);
equal(result.diagnostics.entries[0].source, 'quick');
equal(result.diagnostics.entries[0].level, 'info');
equal(issueEntries(result.diagnostics.entries)[0].issue, null);

// 快查事件在补查时间之后才投递时，仅运行一次补查，随后忽略旧定时事件。
const staleFull = alarms.get('check-videos');
const beforeBothDue = accountCalls;
const beforeBothDueProbes = probeCalls.length;
const beforeBothDueFeeds = feedCalls.length;
result = await tick(quickAlarm, result.state.plan.content);
chrome.alarms.onAlarm.listener({ name: 'check-videos', ...staleFull });
await message('status');
equal(result.state.lastTrigger, 'alarm');
equal(accountCalls, beforeBothDue + 1);
equal(probeCalls.length, beforeBothDueProbes);
equal(feedCalls.slice(beforeBothDueFeeds), ['all', 'video']);

// 旧账号的计数只用作提示。发现当前账号变更后重建其基线，不发送现有内容。
const beforeQuickAccount = sent.length;
mid = '999';
updateNum = 1;
updateBaseline = '900000000000000459';
result = await tick(quickAlarm);
equal(result.state.account, '999');
equal(result.diagnostics.entries.some(entry => entry.message?.includes('确认切换了 B 站账号')), true);
equal(result.diagnostics.entries.some(entry => entry.source === 'quick' && entry.message?.includes('B 站报告')), false);
equal(result.diagnostics.entries.some(entry => entry.details), false);
equal(result.state.quick.cursor, updateBaseline);
equal(result.state.history.every(entry => entry.detected === clock), true);
equal(sent.length, beforeQuickAccount);
updateNum = 0;

// 仅开投稿时使用投稿流游标。暂停后两个闹钟均取消。
await message('save', { settings: { quickCheck: true, mode: 'all' } });
await message('check');
result = await tick(quickAlarm);
equal(probeCalls.at(-1), { type: 'video', update_baseline: updateBaseline });
const staleQuick = alarms.get(quickAlarm);
const beforePause = probeCalls.length;
await message('save', { settings: { quickCheck: true, enabled: false, mode: 'all' } });
equal(alarms.size, 0);
chrome.alarms.onAlarm.listener({ name: quickAlarm, ...staleQuick });
await message('status');
equal(probeCalls.length, beforePause);
await message('save', { settings: { quickCheck: false, enabled: true, interval: 3, mode: 'all' } });
equal(alarms.has(quickAlarm), false);
equal(store.state.plan.content - clock, 3 * 60000);
// 连续无新开播的定时检查只保留直播结果，手动检查仍单独记录。
rooms = [];
await message('save', { settings: { rules: {
  video: { mode: 'off' }, dynamic: { mode: 'off' }, live: { mode: 'all' }
} } });
await message('check');
delete sessionStore.recentIssues;
const firstLivePoll = await tick('check-videos');
const secondLivePoll = await tick('check-videos');
equal(secondLivePoll.diagnostics.entries, [{
  source: 'live', level: 'info', message: '没有新开播。', trigger: 'alarm',
  firstAt: firstLivePoll.diagnostics.entries[0].firstAt, lastAt: clock, count: 2
}]);
const manualLivePoll = await message('check');
equal(manualLivePoll.diagnostics.entries.map(entry => [entry.trigger, entry.count]), [['manual', 1], ['alarm', 2]]);
Date.now = realNow;

// 兼容旧格式的会话异常历史，日志正文不包含旧账号内容。
const legacyIssue = { category: 'rate-limit', message: 'B 站限制了请求。', code: 'HTTP 429' };
sessionStore.recentIssues = { scope: store.state.diagnosticScope, entries: [
  { source: 'quick', issue: legacyIssue, firstAt: clock, lastAt: clock, count: 2 }
] };
const migratedLog = (await message('status')).diagnostics.entries[0];
equal(migratedLog.level, 'warning');
equal(migratedLog.issue, legacyIssue);
equal(migratedLog.count, 2);
equal(migratedLog.details, undefined);

// 日志只保留限长标题与作者，条目数量受上限约束，报告仍显示总数。
const { recordLog, updateLogHistory } = await import(new URL('src/diagnostics.js', root));
const batch = [];
const longRecord = { kind: 'video', id: 'BV0000000007', uid: '123', author: '甲'.repeat(200),
  title: '乙'.repeat(500), url: 'https://example.test' };
recordLog(batch, 'video', '大量新投稿', { items: { queued: Array(25).fill(longRecord) } });
await updateLogHistory(store.settings.issueLimit, store.state.diagnosticScope, batch);
const capped = (await message('status')).diagnostics.entries[0].details.groups[0];
equal(capped.total, 25);
equal(capped.items.length, 20);
equal(capped.items[0], { kind: 'video', id: longRecord.id, author: '甲'.repeat(80), title: '乙'.repeat(180) });
equal(Object.hasOwn(store, 'recentIssues'), false);

// 设置页无 tab、携带查询/锚点时同样合法；相似地址与其他来源不能操作后台。
equal((await request({ type: 'status' }, {
  id: chrome.runtime.id, url: chrome.runtime.getURL(optionsPage)
})).settings.enabled, true);
equal((await request({ type: 'status' }, {
  id: chrome.runtime.id, url: chrome.runtime.getURL(optionsPage) + '?view=options#status', tab: { id: 123 }
})).settings.enabled, true);
for (const url of [
  chrome.runtime.getURL(optionsPage + '.evil'),
  'https://www.bilibili.com/settings.html',
  'chrome-extension://other-extension/settings.html',
  undefined,
  'invalid-url'
]) {
  let response;
  equal(chrome.runtime.onMessage.listener({ type: 'status' }, {
    id: chrome.runtime.id, url, tab: { id: 123 }
  }, result => { response = result; }), undefined);
  equal(Boolean(response?.error), true);
}
let externalResponse = false;
equal(chrome.runtime.onMessage.listener({ type: 'status' }, {
  id: 'another-extension', url: chrome.runtime.getURL(optionsPage)
}, () => { externalResponse = true; }), undefined);
equal(externalResponse, false);

const manifest = JSON.parse(await fs.readFile(new URL('manifest.json', root), 'utf8'));
const optionsHtml = await fs.readFile(new URL(optionsPage, root), 'utf8');
equal(manifest.name, '哔哩哔哩推送');
equal(manifest.description, '当关注的UP开播或更新视频/动态时发出Windows通知提醒');
equal(optionsHtml.includes(`<h1>${manifest.name}</h1><p>${manifest.description}</p>`), true);
for (const file of [
  'src/background.js', 'src/core.js', 'src/diagnostics.js', 'src/options/settings.html',
  'src/options/settings.js', 'src/options/follow-picker.js', 'src/options/settings.css', 'assets/icon.png'
]) await fs.access(new URL(file, root));
equal(manifest.manifest_version, 3);
equal(manifest.permissions.includes('cookies'), false);
console.log(`PASS: ${checks} 项断言，覆盖快查与定时补查、关注分页、三类通知、独立范围、基线、退避、诊断记录、图标和消息校验。`);

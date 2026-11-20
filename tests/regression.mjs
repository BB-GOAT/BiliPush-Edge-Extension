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
const store = { settings: { mode: 'all', uids: ['77'] } };
const sessionStore = {};
const alarms = new Map();
const sent = [];
const activeNotifications = new Map();
const cleared = [];
const opened = [];
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
  tabs: { async create(options) { opened.push(options); } },
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
        : { items: parsed.searchParams.get('type') === 'all' ? [...dynamics, ...feed] : feed, has_more: false } };
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
const message = (type, extra = {}) => request({ type, ...extra });

// 首次基线、定时新投稿与重复查询。
await message('check');
equal(store.settings.rules.video, { mode: 'all', uids: ['77'] });
equal(store.state.baseline, true);
equal(sent.length, 0);
equal(store.state.account, '100');
feed = [item(2), item(1)];
chrome.alarms.onAlarm.listener({ name: 'check-videos' });
await message('status');
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
equal(sessionStore.recentIssues.entries.at(-1).issue.code, '-101');
equal(Math.round((store.state.nextCheck - Date.now()) / 60000), 14);
await message('check');
equal(store.state.failures, 2);
equal(sessionStore.recentIssues.entries.at(-1).count, 2);
equal(Math.round((store.state.nextCheck - Date.now()) / 60000), 28);
apiFailure = false;
await message('check');
equal(store.state.failures, 0);
equal(store.state.error, '');
equal(sessionStore.recentIssues.entries.at(-1).source, 'account');
equal(sessionStore.recentIssues.entries.at(-1).issue, null);

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
equal(sessionStore.recentIssues.entries.at(-1).issue.category, 'notification');
notificationFail = false;
await message('check');
equal(store.state.pending.length, 0);
equal(sessionStore.recentIssues.entries.at(-1).source, 'notification');
equal(sessionStore.recentIssues.entries.at(-1).issue, null);
equal(sent.at(-1).id, 'video:BV0000000006');
await message('check');
equal(sent.filter(notification => notification.id === 'video:BV0000000006').length, 1);

// 连续点击均创建新通知，清理旧测试提醒但保留真实视频通知。
activeNotifications.set('test', { message: '旧版测试通知' });
const beforeTest = structuredClone(store);
const beforeTestIssues = structuredClone(sessionStore);
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
chrome.notifications.onClicked.listener(secondTest);
equal(opened.at(-1).url, 'https://www.bilibili.com/video/BV0000000007/');
chrome.notifications.onClicked.listener('video:BV0000000006');
equal(opened.at(-1).url, 'https://www.bilibili.com/video/BV0000000006/');
equal(store, beforeTest);
equal(sessionStore, beforeTestIssues);
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
chrome.notifications.onClicked.listener(previewDynamic);
equal(opened.at(-1).url, 'https://t.bilibili.com/2002');
chrome.notifications.onClicked.listener('test:BV0000000007:legacy');
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
chrome.notifications.onClicked.listener(previewLive);
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
chrome.notifications.onClicked.listener(previewDemo);
equal(opened.at(-1), 'options');
equal(store, beforeTest);
equal(sessionStore, beforeTestIssues);

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

// 各类别只按自己的 UID 过滤，视频和直播推荐不会再触发动态提醒。
feed = [item(8, '20'), item(9), ...feed];
dynamics = [dynamic(2, '20', 'DYNAMIC_TYPE_DRAW'), dynamic(3, '30'),
  dynamic(4, '20', 'DYNAMIC_TYPE_LIVE_RCMD'), dynamic(5, '20', 'DYNAMIC_TYPE_FORWARD'), ...dynamics];
rooms = [room(1), room(2), room(3, '20'), room(4, '30', 2)];
await message('check');
equal(sent.slice(sentBeforeNewKinds).map(entry => entry.id.replace(/^(live:\d+):.+$/, '$1')),
  ['video:BV0000000009', 'dynamic:2002', 'dynamic:2005', 'live:3002']);
const firstLive = sent.at(-1).id;
chrome.notifications.onClicked.listener('dynamic:2002');
equal(opened.at(-1).url, 'https://t.bilibili.com/2002');
chrome.notifications.onClicked.listener(firstLive);
equal(opened.at(-1).url, 'https://live.bilibili.com/3002');

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
const beforeRetryIssues = structuredClone(sessionStore);
liveFailure = false;
const beforeRetry = liveCalls;
chrome.alarms.onAlarm.listener({ name: 'check-videos' });
await message('status');
equal(liveCalls, beforeRetry);
equal(sessionStore, beforeRetryIssues);
missingLivePermission = true;
await message('check');
equal(liveCalls, beforeRetry);
equal(store.state.error.includes('允许访问 B站直播接口'), true);
equal(sessionStore.recentIssues.entries.at(-1).issue.category, 'permission');
missingLivePermission = false;
await message('check');
equal(store.state.error, '');
equal(sessionStore.recentIssues.entries.at(-1).source, 'live');
equal(sessionStore.recentIssues.entries.at(-1).issue, null);

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
let entries = (await message('status')).diagnostics.entries;
equal(entries[0].source, 'live');
equal(entries[0].count, 2);
equal(entries[1].issue.category, 'timeout');
equal(entries[1].issue.message, '请求超时。');
dynamicError = new TypeError('模拟网络详情');
await message('check');
entries = (await message('status')).diagnostics.entries;
equal(entries[0].count, 3);
equal(entries[1].issue.category, 'network');
equal(entries[1].count, 1);
equal(JSON.stringify(sessionStore).includes('模拟'), false);
equal(Object.hasOwn(store, 'recentIssues'), false);
equal(Object.keys(entries[0]), ['source', 'issue', 'firstAt', 'lastAt', 'count']);
dynamicError = undefined;
liveHttpStatus = 0;
await message('check');
equal((await message('status')).diagnostics.entries.slice(0, 2).map(entry => [entry.source, entry.issue]),
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
await assert.rejects(message('issue-limit', { limit: 500 }), /有效的异常记录保留上限/);
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
equal((await message('status')).diagnostics.entries.length, 1);
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
equal(sessionStore.recentIssues.entries.length, 1);
liveHttpStatus = 0;

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
console.log(`PASS: ${checks} 项断言，覆盖关注分页、三类测试通知、定时提醒、独立范围、基线、退避、诊断记录、图标和消息校验。`);

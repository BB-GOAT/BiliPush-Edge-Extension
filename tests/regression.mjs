import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const optionsPage = 'src/options/settings.html';
const { normalizeSettings, videoFromItem, scanFeed } = await import(new URL('src/core.js', root));
let checks = 0;
function equal(actual, expected) {
  assert.deepEqual(actual, expected);
  checks++;
}

// 所有账号与视频编号均为虚构数据。
function item(number, uid = '10') {
  return {
    type: 'DYNAMIC_TYPE_AV',
    modules: {
      module_author: { mid: uid, name: '测试UP', pub_ts: 100 + number },
      module_dynamic: {
        major: { archive: { bvid: `BV${String(number).padStart(10, '0')}`, title: `视频 ${number}` } }
      }
    }
  };
}

// 设置边界、原创投稿与分页。
equal(normalizeSettings({ interval: 0 }).interval, 1);
equal(normalizeSettings({ maxPages: 99 }).maxPages, 10);
equal(normalizeSettings({ uids: ['10', 'abc', '10'] }).uids, ['10']);
equal(videoFromItem({ ...item(1), type: 'DYNAMIC_TYPE_FORWARD' }), null);
equal(videoFromItem({ type: 'DYNAMIC_TYPE_AV' }), null);

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
const store = {};
const alarms = new Map();
const sent = [];
const activeNotifications = new Map();
const cleared = [];
const opened = [];
let notificationFail = false;
let mid = '100';
let feed = [item(1)];
let apiFailure = false;
const event = () => ({ addListener(listener) { this.listener = listener; } });

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        return structuredClone(Object.fromEntries(keys.map(key => [key, store[key]])));
      },
      async set(value) { Object.assign(store, structuredClone(value)); },
      async setAccessLevel() {}
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
  runtime: {
    id: 'test-extension',
    getURL: relative => `chrome-extension://test-extension/${relative}`,
    onInstalled: event(),
    onStartup: event(),
    onMessage: event(),
    async openOptionsPage() { opened.push('options'); }
  }
};
globalThis.fetch = async url => ({
  ok: true,
  async json() {
    if (apiFailure) return { code: -101 };
    return {
      code: 0,
      data: url.includes('/nav')
        ? { isLogin: true, mid, uname: '测试账号' }
        : { items: feed, has_more: false }
    };
  }
});
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

// 首次基线、真实新投稿与重复查询。
await message('check');
equal(store.state.baseline, true);
equal(sent.length, 0);
equal(store.state.account, '100');
feed = [item(2), item(1)];
await message('check');
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

// 连续失败退避，成功后恢复正常间隔。
apiFailure = true;
await message('check');
equal(store.state.failures, 1);
equal(Math.round((store.state.nextCheck - Date.now()) / 60000), 14);
await message('check');
equal(store.state.failures, 2);
equal(Math.round((store.state.nextCheck - Date.now()) / 60000), 28);
apiFailure = false;
await message('check');
equal(store.state.failures, 0);
equal(store.state.error, '');

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
notificationFail = false;
await message('check');
equal(store.state.pending.length, 0);
equal(sent.at(-1).id, 'video:BV0000000006');
await message('check');
equal(sent.filter(notification => notification.id === 'video:BV0000000006').length, 1);

// 连续点击均创建新通知，清理旧测试提醒但保留真实视频通知。
activeNotifications.set('test', { message: '旧版测试通知' });
await message('test');
const firstTest = sent.at(-1).id;
equal(firstTest.startsWith('test:'), true);
equal(cleared.includes('test'), true);
await message('test');
const secondTest = sent.at(-1).id;
equal(secondTest !== firstTest, true);
equal(activeNotifications.has(firstTest), false);
equal(activeNotifications.has(secondTest), true);
equal(activeNotifications.has('video:BV0000000006'), true);
chrome.notifications.onClicked.listener(secondTest);
equal(opened.includes('options'), true);
chrome.notifications.onClicked.listener('video:BV0000000006');
equal(opened.at(-1).url, 'https://www.bilibili.com/video/BV0000000006/');

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
for (const file of [
  'src/background.js', 'src/core.js', 'src/options/settings.html',
  'src/options/settings.js', 'src/options/settings.css', 'assets/icon.png'
]) await fs.access(new URL(file, root));
equal(manifest.manifest_version, 3);
equal(manifest.permissions.includes('cookies'), false);
console.log(`PASS: ${checks} assertions; baseline, pagination, deduplication, account switch, settings, pause, backoff, outbox recovery, repeat notifications and message trust.`);

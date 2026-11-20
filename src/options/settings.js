import { KINDS, KIND_LABELS, LIVE_PERMISSION, itemUrl } from '../core.js';
import { createFollowPicker } from './follow-picker.js';

const $ = id => document.getElementById(id);
let busy = false;
let loaded = false;
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const ruleFields = {};
const picker = createFollowPicker({
  loadPage: (page, account) => send('followings', { page, account }),
  loadWhisperList: account => send('whispers', { account }),
  confirm(draft) {
    for (const kind of KINDS) {
      ruleFields[kind].uids = [...draft[kind]];
      ruleFields[kind].sync();
    }
    $('feedback').textContent = '名单已更新，点击「保存设置」后生效。';
  }
});
for (const kind of KINDS) {
  const group = $('rule-template').content.cloneNode(true);
  group.querySelector('legend').textContent = KIND_LABELS[kind];
  const mode = group.querySelector('select');
  const selection = group.querySelector('.rule-selection');
  const choose = selection.querySelector('button');
  const field = { mode, uids: [], sync() {
    const selected = mode.value === 'selected';
    selection.hidden = !selected;
    selection.closest('fieldset').classList.toggle('rule-selected', selected);
    selection.querySelector('strong').textContent = `已选 ${field.uids.length} 位`;
  } };
  choose.setAttribute('aria-label', `选择${KIND_LABELS[kind]}提醒的 UP 主`);
  choose.addEventListener('click', () => {
    if (!loaded || busy) return;
    const rules = Object.fromEntries(KINDS.map(key => [key, {
      mode: ruleFields[key].mode.value, uids: ruleFields[key].uids
    }]));
    picker.open(kind, rules);
  });
  mode.addEventListener('change', field.sync);
  ruleFields[kind] = field;
  $('rules').append(group);
}
async function send(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...data });
  if (response?.error) throw new Error(response.error);
  if (!response || !('result' in response)) throw new Error('扩展后台没有响应，请在扩展管理页重新加载。');
  return response.result;
}
function render({ settings, state }, fill = false) {
  if (fill) {
    for (const key of ['interval', 'maxPages']) $(key).value = settings[key];
    for (const key of ['enabled', 'silent']) $(key).checked = settings[key];
    for (const kind of KINDS) {
      const field = ruleFields[kind];
      field.mode.value = settings.rules[kind].mode;
      field.uids = settings.rules[kind].uids;
      field.sync();
    }
    loaded = true;
  }
  const hasRules = KINDS.some(kind => settings.rules[kind].mode !== 'off');
  $('badge').textContent = !settings.enabled ? '已暂停' : !hasRules ? '全部关闭' : state.error ? '需要检查'
    : state.lastSuccess ? '自动检查中' : '等待首次检查';
  $('account').textContent = state.account ? `${state.accountName}（${state.account}）` : '尚未确认登录';
  $('attempt').textContent = time(state.lastAttempt);
  $('success').textContent = time(state.lastSuccess);
  $('next').textContent = settings.enabled && hasRules ? time(state.nextCheck) : '—';
  $('note').textContent = hasRules ? (state.note || '点击“立即检查”确认登录并读取已开启的提醒。') : '请先选择要接收的提醒。';
  $('error').hidden = !state.error || !hasRules;
  $('error').textContent = state.error ?? '';
  $('history').replaceChildren();
  if (!state.history.length) $('history').textContent = '暂无记录。';
  for (const record of state.history) {
    const kind = record.kind ?? 'video';
    const url = itemUrl(kind, record.id);
    if (!url) continue;
    const link = document.createElement('a');
    link.className = 'video';
    link.href = url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    const title = document.createElement('strong');
    title.textContent = record.title;
    const info = document.createElement('span');
    info.textContent = `${KIND_LABELS[kind]} · ${record.author} · UID ${record.uid} · ${record.published
      ? '发布于 ' + time(record.published * 1000) : '检测于 ' + time(record.detected)}`;
    link.append(title, info);
    $('history').append(link);
  }
}
async function action(button, feedback, task) {
  if (busy) return;
  busy = true;
  const old = button.textContent;
  document.querySelectorAll('main button').forEach(node => node.disabled = true);
  button.textContent = '处理中…';
  $(feedback).textContent = '';
  try { await task(); }
  catch (error) { $(feedback).textContent = error.message; }
  finally {
    busy = false;
    document.querySelectorAll('main button').forEach(node => node.disabled = false);
    button.textContent = old;
  }
}
$('settings').addEventListener('submit', event => {
  event.preventDefault();
  if (!loaded) return;
  void action(event.submitter, 'feedback', async () => {
    const rules = {};
    for (const kind of KINDS) {
      const { mode, uids } = ruleFields[kind];
      if (mode.value === 'selected' && !uids.length) {
        throw new Error(`${KIND_LABELS[kind]}：请在选择面板中至少勾选一位 UP 主。`);
      }
      rules[kind] = { mode: mode.value, uids };
    }
    const settings = {
      enabled: $('enabled').checked, silent: $('silent').checked,
      interval: Number($('interval').value), maxPages: Number($('maxPages').value), rules
    };
    // 权限申请必须从「保存设置」的用户操作直接发起。
    if (rules.live.mode !== 'off' && !await chrome.permissions.request(LIVE_PERMISSION)) {
      throw new Error('直播提醒需要访问 B站直播接口。可允许访问，或关闭直播提醒后保存。');
    }
    const result = await send('save', { settings });
    render(result, true);
    $('feedback').textContent = '设置已保存。';
  });
});
$('check').addEventListener('click', () => { void action($('check'), 'check-feedback', async () => {
  $('test-live-demo').hidden = true;
  render(await send('check'));
}); });
function test(kind, demo = false) {
  const button = $(demo ? 'test-live-demo' : `test-${kind}`);
  void action(button, 'check-feedback', async () => {
    $('test-live-demo').hidden = true;
    if (kind === 'live' && !demo && !await chrome.permissions.request(LIVE_PERMISSION)) {
      throw new Error('测试真实直播需要允许访问 B站直播接口。');
    }
    const result = await send('test', { kind, demo });
    if (result.noLive) {
      $('check-feedback').textContent = '当前没有已关注的 UP 主正在直播。可以发送一条演示通知查看样式。';
      $('test-live-demo').hidden = false;
      return;
    }
    const target = { video: '视频', dynamic: '原动态', live: '直播间' }[kind];
    $('check-feedback').textContent = demo ? '已发送直播演示通知。点击横幅可返回设置。'
      : `已发送测试通知「${result.title}」。点击横幅可打开${target}。`;
  });
}
for (const kind of KINDS) $(`test-${kind}`).addEventListener('click', () => test(kind));
$('test-live-demo').addEventListener('click', () => test('live', true));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.state && loaded) void send('status').then(result => render(result)).catch(() => {});
});
send('status').then(result => render(result, true)).catch(error => {
  $('badge').textContent = '连接失败';
  $('error').hidden = false;
  $('error').textContent = error.message;
});

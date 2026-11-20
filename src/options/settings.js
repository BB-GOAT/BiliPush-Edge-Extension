import { KINDS, KIND_LABELS, LIVE_PERMISSION, itemUrl } from '../core.js';

const $ = id => document.getElementById(id);
let busy = false;
let loaded = false;
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const ruleFields = {};
for (const kind of KINDS) {
  const group = $('rule-template').content.cloneNode(true);
  group.querySelector('legend').textContent = KIND_LABELS[kind];
  const mode = group.querySelector('select');
  const uids = group.querySelector('textarea');
  const sync = () => { uids.parentElement.hidden = mode.value !== 'selected'; };
  mode.addEventListener('change', sync);
  ruleFields[kind] = { mode, uids, sync };
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
      const { mode, uids, sync } = ruleFields[kind];
      mode.value = settings.rules[kind].mode;
      uids.value = settings.rules[kind].uids.join('\n');
      sync();
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
  document.querySelectorAll('button').forEach(node => node.disabled = true);
  button.textContent = '处理中…';
  $(feedback).textContent = '';
  try { await task(); }
  catch (error) { $(feedback).textContent = error.message; }
  finally {
    busy = false;
    document.querySelectorAll('button').forEach(node => node.disabled = false);
    button.textContent = old;
  }
}
$('settings').addEventListener('submit', event => {
  event.preventDefault();
  if (!loaded) return;
  void action(event.submitter, 'feedback', async () => {
    const rules = {};
    for (const kind of KINDS) {
      const { mode, uids: input } = ruleFields[kind];
      const uids = input.value.split(/[\s,，;；]+/).filter(Boolean);
      if (mode.value === 'selected' && (!uids.length || uids.some(uid => !/^[1-9]\d{0,19}$/.test(uid)))) {
        throw new Error(`${KIND_LABELS[kind]}：请填写至少一个有效的 UP 主 UID。`);
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
  render(await send('check'));
}); });
$('test').addEventListener('click', () => { void action($('test'), 'check-feedback', async () => {
  const { title } = await send('test');
  $('check-feedback').textContent = `已发送测试通知《${title}》。点击横幅可打开视频。`;
}); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.state && loaded) void send('status').then(result => render(result)).catch(() => {});
});
send('status').then(result => render(result, true)).catch(error => {
  $('badge').textContent = '连接失败';
  $('error').hidden = false;
  $('error').textContent = error.message;
});

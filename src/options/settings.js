import { KINDS, KIND_LABELS, LIVE_PERMISSION, itemUrl } from '../core.js';
import { createFollowPicker } from './follow-picker.js';

const $ = id => document.getElementById(id);
let busy = false;
let loaded = false;
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const compactTime = value => {
  if (!value) return '—';
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
    : time(value);
};
const CHECK_LABELS = { ...KIND_LABELS, account: '登录检查', notification: '通知发送', check: '扩展运行', quick: '快速检查' };
const TRIGGER_LABELS = { alarm: '定时检查', manual: '手动检查', startup: 'Edge 启动',
  installed: '安装或更新后检查', quick: '快速检查发现更新' };
const issueText = ({ message, code }) => code && !message.includes(code)
  ? `${message.replace(/。$/, '')}（${code}）。`
  : message;
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

function renderStatus(settings, state) {
  const kinds = KINDS.filter(kind => settings.rules[kind].mode !== 'off');
  const waiting = kinds.filter(kind => state.sources[kind]?.error).length;
  const globalIssues = Object.entries(state.globalIssues ?? {});
  const legacyError = state.failures && !globalIssues.length ? state.error : '';
  const warning = waiting > 0 || globalIssues.length > 0 || Boolean(legacyError);
  const badge = $('badge');
  badge.textContent = !settings.enabled ? '已暂停' : !kinds.length ? '全部关闭'
    : globalIssues.length || legacyError ? '需要检查' : waiting ? `${waiting} 项等待重试`
      : state.lastSuccess ? '自动检查中' : '等待首次检查';
  badge.classList.toggle('warning', Boolean(kinds.length && warning));
  $('account').textContent = state.account ? `${state.accountName}（${state.account}）` : '尚未确认登录';
  const next = settings.enabled && kinds.length ? state.nextCheck : null;
  for (const [id, value] of [['attempt', state.lastAttempt], ['next', next]]) {
    $(id).textContent = compactTime(value);
    $(id).title = value ? time(value) : '';
  }
  const quick = $('next-quick');
  const quickAt = state.quick?.next;
  quick.textContent = !settings.enabled || !settings.quickCheck || !kinds.some(kind => kind !== 'live')
    ? '已关闭' : quickAt ? new Date(quickAt).toLocaleTimeString('zh-CN', { hour12: false }) : '等待完整检查';
  quick.title = quickAt ? time(quickAt) : '';
  const trigger = $('attempt-trigger');
  trigger.textContent = TRIGGER_LABELS[state.lastTrigger] ?? '';
  trigger.hidden = !trigger.textContent;

  const alert = $('error');
  alert.replaceChildren();
  alert.hidden = !kinds.length || !(globalIssues.length || legacyError);
  for (const [source, issue] of globalIssues) {
    const detail = document.createElement('p');
    detail.textContent = `${CHECK_LABELS[source]} · ${issueText(issue)} · ${compactTime(issue.at)}失败 · 连续 ${issue.failures} 次`;
    alert.append(detail);
  }
  if (legacyError) alert.textContent = legacyError;

  $('sources').replaceChildren();
  for (const kind of KINDS) {
    const entry = state.sources[kind];
    const enabled = kinds.includes(kind);
    const failed = enabled && Boolean(entry?.error);
    const row = $('source-template').content.cloneNode(true);
    const card = row.firstElementChild;
    card.classList.toggle('source-warning', failed);
    card.classList.toggle('source-ok', enabled && Boolean(entry) && !failed);
    row.querySelector('.source-title').textContent = KIND_LABELS[kind];
    row.querySelector('.source-state').textContent = !enabled ? '已关闭' : failed
      ? settings.enabled ? '等待重试' : '上次失败' : entry ? '正常' : '等待首次检查';
    const meta = row.querySelector('.source-meta');
    const success = entry?.lastSuccess ? `上次成功 ${compactTime(entry.lastSuccess)}` : '';
    const note = row.querySelector('.source-note');
    if (failed) {
      const detail = row.querySelector('.source-error');
      detail.textContent = entry.issue ? issueText(entry.issue) : entry.error;
      detail.hidden = false;
      meta.textContent = [entry.lastAttempt ? `${compactTime(entry.lastAttempt)} 失败` : '',
        `连续 ${entry.failures} 次`, success || '暂无成功时间'].filter(Boolean).join(' · ');
      const retry = row.querySelector('.source-retry');
      retry.hidden = !settings.enabled || !entry.retryAt;
      retry.querySelector('strong').textContent = entry.retryAt > Date.now()
        ? `${compactTime(entry.retryAt)} 后可重试` : '已到可重试时间';
      const next = state.plan?.[kind === 'live' ? 'live' : 'content'];
      retry.querySelector('span').textContent = !next ? '' : Math.max(next, Date.now()) < entry.retryAt
        ? `下轮自动检查会跳过${KIND_LABELS[kind]}` : '等待下轮自动检查';
    } else if (enabled) {
      meta.textContent = success || (entry ? '暂无成功时间' : '尚未完成检查');
      meta.title = entry?.lastSuccess ? time(entry.lastSuccess) : '';
      note.textContent = entry?.note ?? '';
      note.hidden = !entry?.note;
    }
    $('sources').append(row);
  }
}

function renderDiagnostics(settings, { entries, available }) {
  $('issue-limit').value = settings.issueLimit;
  $('issue-count').textContent = available ? `${entries.length} 条记录` : '记录暂不可用';
  $('issue-empty').hidden = entries.length > 0 || !available;
  $('issues').hidden = entries.length === 0;
  const feedback = $('issue-feedback');
  feedback.textContent = available ? '' : '当前无法保存或读取会话内记录，仍可在运行状态中查看最新错误。';
  feedback.hidden = available;
  const list = $('issue-list');
  list.replaceChildren();
  for (const { source, issue, firstAt, lastAt, count } of entries) {
    const row = list.insertRow();
    const when = row.insertCell();
    when.textContent = count > 1 ? `${compactTime(firstAt)}～${compactTime(lastAt)}` : compactTime(lastAt);
    when.title = count > 1 ? `${time(firstAt)}～${time(lastAt)}` : time(lastAt);
    row.insertCell().textContent = CHECK_LABELS[source];
    const result = row.insertCell();
    result.className = issue ? 'issue-failed' : 'issue-recovered';
    result.textContent = issue ? issueText(issue) : '已恢复';
    row.insertCell().textContent = issue ? `${count} 次` : '—';
  }
}

function render({ settings, state, diagnostics }, fill = false) {
  if (fill) {
    for (const key of ['interval', 'fullInterval', 'maxPages']) $(key).value = settings[key];
    for (const key of ['enabled', 'quickCheck', 'silent']) $(key).checked = settings[key];
    for (const kind of KINDS) {
      const field = ruleFields[kind];
      field.mode.value = settings.rules[kind].mode;
      field.uids = settings.rules[kind].uids;
      field.sync();
    }
    loaded = true;
    $('issue-limit').disabled = false;
  }
  renderStatus(settings, state);
  renderDiagnostics(settings, diagnostics);
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
      enabled: $('enabled').checked, quickCheck: $('quickCheck').checked, silent: $('silent').checked,
      fullInterval: Number($('fullInterval').value),
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
$('issue-limit').addEventListener('change', async event => {
  const select = event.currentTarget;
  const limit = Number(select.value);
  select.disabled = true;
  try { render(await send('issue-limit', { limit })); }
  catch (error) {
    try { render(await send('status')); }
    catch {}
    $('issue-feedback').textContent = error.message;
    $('issue-feedback').hidden = false;
  } finally {
    select.disabled = false;
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.state || changes.settings) && loaded) {
    void send('status').then(result => render(result)).catch(() => {});
  }
});
send('status').then(result => render(result, true)).catch(error => {
  $('badge').textContent = '连接失败';
  $('error').hidden = false;
  $('error').textContent = error.message;
  $('issue-count').textContent = '记录暂不可用';
  $('issue-empty').hidden = true;
  $('issue-feedback').hidden = false;
  $('issue-feedback').textContent = '后台未连接，无法读取会话内记录。';
});

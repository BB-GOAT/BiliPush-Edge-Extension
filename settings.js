const $ = id => document.getElementById(id);
let busy = false;
let loaded = false;
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
async function send(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...data });
  if (response?.error) throw new Error(response.error);
  if (!response || !('result' in response)) throw new Error('扩展后台没有响应，请在扩展管理页重新加载。');
  return response.result;
}
function render({ settings, state }, fill = false) {
  if (fill) {
    for (const key of ['interval', 'maxPages', 'mode']) $(key).value = settings[key];
    for (const key of ['enabled', 'silent']) $(key).checked = settings[key];
    $('uids').value = settings.uids.join('\n');
    $('uids-field').hidden = settings.mode !== 'selected';
    loaded = true;
  }
  $('badge').textContent = !settings.enabled ? '已暂停' : state.error ? '需要检查' : state.baseline ? '自动检查中' : '等待首次检查';
  $('account').textContent = state.account ? `${state.accountName}（${state.account}）` : '尚未确认登录';
  $('attempt').textContent = time(state.lastAttempt);
  $('success').textContent = time(state.lastSuccess);
  $('next').textContent = settings.enabled ? time(state.nextCheck) : '已暂停';
  $('note').textContent = state.note ?? '点击“立即检查”确认登录，并建立视频基线。';
  $('error').hidden = !state.error;
  $('error').textContent = state.error ?? '';
  $('history').replaceChildren();
  if (!state.history.length) $('history').textContent = '暂无记录。';
  for (const video of state.history) {
    const link = document.createElement('a');
    link.className = 'video';
    // 链接仅由已验证的 BV 号构造，不使用接口中的任意 URL。
    if (!/^BV[A-Za-z0-9]{10}$/.test(video.id)) continue;
    link.href = `https://www.bilibili.com/video/${video.id}/`;
    link.target = '_blank';
    link.rel = 'noreferrer';
    const title = document.createElement('strong');
    title.textContent = video.title;
    const info = document.createElement('span');
    info.textContent = `${video.author} · UID ${video.uid} · ${video.published ? '发布于 ' + time(video.published * 1000) : '检测于 ' + time(video.detected)}`;
    link.append(title, info);
    $('history').append(link);
  }
}
async function action(button, task) {
  if (busy) return;
  busy = true;
  const old = button.textContent;
  document.querySelectorAll('button').forEach(node => node.disabled = true);
  button.textContent = '处理中…';
  $('feedback').textContent = '';
  try { await task(); }
  catch (error) { $('feedback').textContent = error.message; }
  finally {
    busy = false;
    document.querySelectorAll('button').forEach(node => node.disabled = false);
    button.textContent = old;
  }
}
$('mode').addEventListener('change', () => { $('uids-field').hidden = $('mode').value !== 'selected'; });
$('settings').addEventListener('submit', event => {
  event.preventDefault();
  if (!loaded) return;
  void action(event.submitter, async () => {
    const uids = $('uids').value.split(/[\s,，;；]+/).filter(Boolean);
    if (uids.some(uid => !/^\d{1,20}$/.test(uid))) throw new Error('UID 只能包含数字，请检查输入。');
    if ($('mode').value === 'selected' && !uids.length) throw new Error('请至少填写一个 UP 主 UID。');
    const result = await send('save', { settings: {
      enabled: $('enabled').checked, silent: $('silent').checked,
      interval: Number($('interval').value), maxPages: Number($('maxPages').value),
      mode: $('mode').value, uids
    } });
    render(result, true);
    $('feedback').textContent = '设置已保存。';
  });
});
$('check').addEventListener('click', () => { void action($('check'), async () => {
  render(await send('check'));
  $('feedback').textContent = '检查已结束，请查看运行状态。';
}); });
$('test').addEventListener('click', () => { void action($('test'), async () => {
  await send('test');
  $('feedback').textContent = '已请求发送测试通知；如未显示，请检查 Windows 和 Edge 通知权限。';
}); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.state && loaded) void send('status').then(result => render(result)).catch(() => {});
});
send('status').then(result => render(result, true)).catch(error => {
  $('badge').textContent = '连接失败';
  $('error').hidden = false;
  $('error').textContent = error.message;
});

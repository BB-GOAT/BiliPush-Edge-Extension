import { KINDS, KIND_LABELS } from '../core.js';

export function createFollowPicker({ loadPage, confirm }) {
  const dialog = document.getElementById('follow-picker');
  const field = id => dialog.querySelector(`#picker-${id}`);
  const list = field('list');
  const search = field('search');
  const onlySelected = field('only-selected');
  const bulkButtons = dialog.querySelectorAll('[data-selection]');
  const retry = field('retry');
  const tabs = {};
  let session;

  function renderSummary() {
    for (const kind of KINDS) {
      tabs[kind].setAttribute('aria-pressed', String(kind === session.kind));
      tabs[kind].lastElementChild.textContent = session.draft[kind].size;
    }
    field('count').textContent = `已选 ${session.draft[session.kind].size} 位`;
    const scope = field('scope');
    scope.hidden = session.modes[session.kind] === 'selected';
    scope.textContent = '将此类提醒范围切换为「仅指定的已关注 UP 主」后，才会使用这份名单。';
  }

  function renderProgress() {
    const { loading, error, people, total, accountChanged } = session;
    const count = `已加载 ${people.size}${total === null ? '' : ` / ${total}`} 位关注的 UP 主`;
    field('status').textContent = error ? `${error}${people.size ? ` ${count}。` : ''}`
      : loading ? `${count}，正在读取…` : `${count}。`;
    retry.hidden = loading || !error || accountChanged;
    field('confirm').disabled = accountChanged;
  }

  function renderList(resetScroll = false) {
    const { people, draft, kind, loading, error, accountChanged } = session;
    const selected = draft[kind];
    const filter = search.value.trim().toLowerCase();
    const candidates = accountChanged ? [] : [...people.values()];
    if (!accountChanged) {
      // 分页尚未结束或旧 UID 已不在返回结果中时，保留用户原先的选择。
      for (const uid of selected) {
        if (!people.has(uid)) candidates.push({ uid, name: `暂未匹配 · UID ${uid}`, avatar: '' });
      }
    }
    const focusedUid = list.contains(document.activeElement) ? document.activeElement.dataset.uid : '';
    const scroll = resetScroll ? 0 : list.scrollTop;
    const fragment = document.createDocumentFragment();
    let focusTarget;
    for (const person of candidates) {
      const checked = selected.has(person.uid);
      if ((onlySelected.checked && !checked) || !person.name.toLowerCase().includes(filter)) continue;
      const row = document.createElement('label');
      row.className = 'picker-person';
      const avatar = document.createElement('span');
      avatar.className = 'picker-avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = [...person.name][0];
      if (person.avatar) {
        const image = document.createElement('img');
        image.alt = '';
        image.loading = 'lazy';
        image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => image.remove(), { once: true });
        image.src = person.avatar;
        avatar.append(image);
      }
      const name = document.createElement('span');
      name.textContent = person.name;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.uid = person.uid;
      input.checked = checked;
      if (person.uid === focusedUid) focusTarget = input;
      row.append(avatar, name, input);
      fragment.append(row);
    }
    const hasRows = fragment.childElementCount > 0;
    for (const button of bulkButtons) button.disabled = loading || !hasRows;
    if (!hasRows) {
      const empty = document.createElement('p');
      empty.className = 'hint picker-empty';
      empty.textContent = loading ? '关注列表正在加载…' : error ? '当前没有可显示的匹配项。'
        : filter ? '没有匹配的 UP 主。' : onlySelected.checked ? '这类提醒还未勾选 UP 主。' : '关注列表为空。';
      fragment.append(empty);
    }
    list.replaceChildren(fragment);
    list.scrollTop = scroll;
    focusTarget?.focus({ preventScroll: true });
  }

  async function load() {
    const current = session;
    current.loading = true;
    current.error = '';
    renderProgress();
    renderList();
    try {
      while (session === current) {
        const page = await loadPage(current.page, current.account);
        if (session !== current) return;
        if (page.accountChanged) {
          current.accountChanged = true;
          current.people.clear();
          current.total = null;
          throw new Error('B 站登录账号已切换，请关闭后重新打开选择面板。');
        }
        current.account = page.account;
        current.total = page.total;
        const previous = current.people.size;
        for (const person of page.people) current.people.set(person.uid, person);
        if (current.people.size < current.total && (!page.hasMore || previous === current.people.size)) {
          throw new Error('B 站只返回了部分关注名单。可以重试，已选名单会保留。');
        }
        if (!page.hasMore) break;
        current.page++;
        renderProgress();
        renderList();
        // 大关注列表逐页加载，避免连续请求挤占后台正常检查。
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } catch (error) {
      current.error = error.message;
    } finally {
      if (session === current) {
        current.loading = false;
        renderProgress();
        renderList();
      }
    }
  }

  for (const kind of KINDS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'picker-tab';
    const count = document.createElement('span');
    button.append(KIND_LABELS[kind], count);
    button.addEventListener('click', () => {
      session.kind = kind;
      renderSummary();
      renderList(true);
    });
    field('kinds').append(button);
    tabs[kind] = button;
  }
  search.addEventListener('input', () => renderList(true));
  onlySelected.addEventListener('change', () => renderList(true));
  for (const button of bulkButtons) {
    button.addEventListener('click', () => {
      const selected = session.draft[session.kind];
      const action = button.dataset.selection;
      // 使用已经显示的筛选结果，包括列表中需要滚动才能看到的条目。
      for (const input of list.querySelectorAll('input[data-uid]')) {
        if (action === 'all' || (action === 'invert' && !input.checked)) selected.add(input.dataset.uid);
        else selected.delete(input.dataset.uid);
      }
      renderSummary();
      renderList();
      if (button.disabled) onlySelected.focus();
    });
  }
  list.addEventListener('change', event => {
    const input = event.target;
    const uid = input.dataset.uid;
    if (!uid || session.accountChanged) return;
    const selected = session.draft[session.kind];
    if (input.checked) selected.add(uid);
    else selected.delete(uid);
    renderSummary();
    if (!input.checked && (onlySelected.checked || !session.people.has(uid))) {
      const row = input.closest('label');
      const next = row.nextElementSibling ?? row.previousElementSibling;
      const nextUid = next?.querySelector('input')?.dataset.uid;
      renderList();
      const nextInput = [...list.querySelectorAll('input')].find(element => element.dataset.uid === nextUid);
      (nextInput ?? onlySelected).focus();
    }
  });
  retry.addEventListener('click', () => {
    if (!session.loading && !session.accountChanged) void load();
  });
  function close() {
    session.people.clear();
    session = undefined;
    dialog.close();
    list.replaceChildren();
  }
  field('close').addEventListener('click', close);
  field('cancel').addEventListener('click', close);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    close();
  });
  field('confirm').addEventListener('click', () => {
    if (session.accountChanged) return;
    confirm(session.draft);
    close();
  });

  return { open(kind, rules) {
    if (dialog.open) return;
    session = {
      kind, people: new Map(), page: 1, total: null,
      draft: Object.fromEntries(KINDS.map(key => [key, new Set(rules[key].uids)])),
      modes: Object.fromEntries(KINDS.map(key => [key, rules[key].mode]))
    };
    search.value = '';
    onlySelected.checked = false;
    renderSummary();
    dialog.showModal();
    void load();
  } };
}

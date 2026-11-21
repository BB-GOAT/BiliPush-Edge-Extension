import { CheckError } from './core.js';

// 沿用会话存储键与账号隔离标记，日志不会写入本地存储。
export const LOG_KEY = 'recentIssues';
let writeFailed = false;

export function describeIssue(error, fallback) {
  const { category, message, code } = error instanceof CheckError ? error : fallback;
  return { category, message, code: code ?? null };
}

const warningCategories = new Set(['login', 'permission', 'rate-limit', 'rejected', 'timeout', 'network', 'no-sample']);
const issueLevel = issue => warningCategories.has(issue.category) ? 'warning' : 'error';
const sameIssue = (first, second) => first?.category === second.category && first?.code === second.code;

export function recordIssue(events, source, issue, previous, at, retryAt = null) {
  if (issue) {
    events.push({ source, level: issueLevel(issue), issue, at, retryAt,
      repeat: sameIssue(previous, issue) ? 'issue' : null });
  } else if (previous) {
    events.push({ source, level: 'info', issue: null, message: '已恢复', at });
  }
}

export function recordLog(events, source, message, { level = 'info', repeat = null, retryAt = null } = {}) {
  events.push({ source, level, message, at: Date.now(), repeat, retryAt });
}

async function readEntries(scope) {
  const stored = await chrome.storage.session.get(LOG_KEY);
  const history = stored[LOG_KEY];
  if (history?.scope !== scope || !Array.isArray(history?.entries)) return [];
  return history.entries.map(entry => entry.level ? entry : {
    ...entry, level: entry.issue ? issueLevel(entry.issue) : 'info',
    ...(!entry.issue && { message: '已恢复' })
  });
}

export async function readLogHistory(limit, scope = null) {
  try {
    const entries = (await readEntries(scope)).slice(-limit).reverse();
    return { entries, available: !writeFailed };
  } catch {
    return { entries: [], available: false };
  }
}

export async function updateLogHistory(limit, scope = null, events = []) {
  try {
    const entries = await readEntries(scope);
    for (const { source, level, issue, message, at, repeat, retryAt } of events) {
      const index = repeat ? entries.findLastIndex(entry =>
        entry.source === source && (repeat !== 'issue' || Object.hasOwn(entry, 'issue'))) : -1;
      const previous = entries[index];
      const merged = previous && (repeat === 'issue' ? sameIssue(previous.issue, issue)
        : previous.message === message && previous.level === level);
      if (merged) entries.splice(index, 1);
      entries.push({ source, level, ...(issue !== undefined && { issue }), ...(message && { message }),
        ...(retryAt && { retryAt }), firstAt: merged ? previous.firstAt : at,
        lastAt: at, count: merged ? previous.count + 1 : 1 });
    }
    await chrome.storage.session.set({ [LOG_KEY]: { scope, entries: entries.slice(-limit) } });
    writeFailed = false;
  } catch {
    // 日志不可用时，检查、待发通知和定时任务仍照常运行。
    writeFailed = true;
  }
}

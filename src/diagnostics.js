import { CheckError } from './core.js';

const SESSION_KEY = 'recentIssues';
let writeFailed = false;

export function describeIssue(error, fallback) {
  const { category, message, code } = error instanceof CheckError ? error : fallback;
  return { category, message, code };
}

const sameIssue = (first, second) => first?.category === second.category && first?.code === second.code;

export function recordIssue(events, source, issue, previous, at) {
  if (issue || previous) {
    events.push({ source, issue, at, repeat: Boolean(issue && sameIssue(previous, issue)) });
  }
}

async function readEntries(scope) {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  const history = stored[SESSION_KEY];
  return history?.scope === scope ? history.entries : [];
}

export async function readIssueHistory(limit, scope = null) {
  try {
    const entries = (await readEntries(scope)).slice(-limit).reverse();
    return { entries, available: !writeFailed };
  } catch {
    return { entries: [], available: false };
  }
}

export async function updateIssueHistory(limit, scope = null, events = []) {
  try {
    const entries = await readEntries(scope);
    for (const { source, issue, at, repeat } of events) {
      const index = repeat ? entries.findLastIndex(entry => entry.source === source) : -1;
      const previous = entries[index];
      if (previous?.issue && sameIssue(previous.issue, issue)) {
        entries.splice(index, 1);
        entries.push({ ...previous, lastAt: at, count: previous.count + 1 });
      } else {
        entries.push({ source, issue, firstAt: at, lastAt: at, count: 1 });
      }
    }
    await chrome.storage.session.set({ [SESSION_KEY]: { scope, entries: entries.slice(-limit) } });
    writeFailed = false;
  } catch {
    // 诊断记录不可用时，检查、待发通知和定时任务仍照常运行。
    writeFailed = true;
  }
}

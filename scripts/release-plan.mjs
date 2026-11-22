import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const [mode, before, head] = process.argv.slice(2);

function versionAt(commit) {
  const manifest = JSON.parse(git('show', `${commit}:manifest.json`));
  const pkg = JSON.parse(git('show', `${commit}:package.json`));
  const version = manifest.version;
  if (typeof version !== 'string' || version !== pkg.version
      || !/^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){2}$/.test(version)
      || version === '0.0.0' || version.split('.').some(part => Number(part) > 65535)) {
    throw new Error(`${commit} 的版本号无效；两个文件应使用相同的三段数字版本。`);
  }
  return version;
}

function notesAt(commit, version) {
  const sections = git('show', `${commit}:CHANGELOG.md`).split(/^##[ \t]+/m);
  for (const section of sections.slice(1)) {
    const newline = section.indexOf('\n');
    const title = section.slice(0, newline).trim();
    const body = section.slice(newline + 1).trim();
    if (title === version && newline >= 0 && body) return body;
  }
  throw new Error(`${commit} 的 CHANGELOG.md 缺少「## ${version}」或该节的更新说明。`);
}

function plan() {
  const version = versionAt(head);
  const include = [];
  // 首次推送和手动运行只构建当前版本，不发布历史版本。
  if (mode === 'push' && before && !/^0+$/.test(before)) {
    git('merge-base', '--is-ancestor', before, head);
    let previous = versionAt(before);
    const commits = git('rev-list', '--first-parent', '--reverse', `${before}..${head}`).trim().split(/\s+/).filter(Boolean);
    for (const sha of commits) {
      const current = versionAt(sha);
      if (current === previous) continue;
      if (current.localeCompare(previous, 'en', { numeric: true }) <= 0) {
        throw new Error(`${sha} 将版本从 ${previous} 降到 ${current}。Release 版本必须递增。`);
      }
      notesAt(sha, current);
      include.push({ sha, version: current });
      previous = current;
    }
  }
  return { version, include };
}

if (mode === 'notes') {
  const version = versionAt('HEAD');
  if (version !== before) throw new Error(`检出的版本为 ${version}，预期为 ${before}。`);
  writeFileSync(head, notesAt('HEAD', version) + '\n');
} else {
  const { version, include } = plan();
  console.log(JSON.stringify({ version, include }));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT,
      `version=${version}\nreleases=${include.length > 0}\nmatrix=${JSON.stringify({ include })}\n`);
  }
}

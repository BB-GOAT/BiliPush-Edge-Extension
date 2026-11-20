import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
assert.equal(manifest.version, metadata.version, '两个版本字段必须一致；修改版本须用户明确指示');
assert.equal(manifest.manifest_version, 3);
assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'background', 'notifications', 'storage']);
assert.deepEqual(manifest.host_permissions, ['https://api.bilibili.com/*']);
assert.deepEqual(manifest.optional_host_permissions, ['https://api.live.bilibili.com/*']);
assert.equal(manifest.background.type, 'module');
assert.equal(manifest.options_page, 'src/options/settings.html');

// 校验 manifest 与设置页的本地引用，防止移动文件后遗漏路径。
const localFile = async relative => {
  const resolved = path.resolve(root, relative);
  assert.ok(resolved.startsWith(root + path.sep), `引用超出扩展目录：${relative}`);
  assert.ok((await fs.stat(resolved)).isFile(), `文件不存在：${relative}`);
};
await localFile(manifest.background.service_worker);
await localFile(manifest.options_page);
await localFile(manifest.action.default_icon);
for (const icon of Object.values(manifest.icons)) await localFile(icon);
const html = await fs.readFile(path.join(root, manifest.options_page), 'utf8');
for (const [, reference] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  if (/^https?:/.test(reference)) continue;
  await localFile(path.join(path.dirname(manifest.options_page), reference));
}
const run = args => {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
};
for (const folder of ['src', 'tests', 'scripts']) {
  for (const entry of await fs.readdir(path.join(root, folder), { recursive: true })) {
    if (/\.m?js$/.test(entry)) run(['--check', path.join(folder, entry)]);
  }
}
run(['tests/regression.mjs']);
console.log('PASS: manifest、资源路径、脚本语法和回归测试。');

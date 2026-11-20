# 架构与维护边界

## 运行路径

`manifest.json` 加载 `src/background.js` 模块后台。后台导入 `src/core.js`；工具栏按钮通过 `openOptionsPage` 打开 `src/options/settings.html`，该页面只通过消息请求后台，不直接访问 B站接口。

后台访问 `/x/web-interface/nav` 确认登录账号，然后访问 `/x/polymer/web-dynamic/v1/feed/all?type=video&timezone_offset=-480`，用 `offset` 翻页。请求自动携带浏览器凭据，20 秒超时。接口不是稳定开放契约；改变请求字段或处理方式前须保留脱敏样例并实测。

`core.js` 提取原创视频动态，以 BV 号去重；遇到已有 BV 号、没有下一页或页数上限时停止。首次只用首页建立基线。账号 mid 改变时重建账号状态。筛选使用 UID，不用昵称。

## 存储

使用 `chrome.storage.local`，访问级别为 `TRUSTED_CONTEXTS`。顶层只有 `settings` 和 `state`。

| 字段 | 含义及约束 |
| --- | --- |
| settings.enabled / interval | 自动检查开关；间隔 1～60 分钟 |
| settings.mode / uids | 全部关注或 UID 白名单；UID 为字符串 |
| settings.silent / maxPages | 静音；最大页数 1～10 |
| state.account / accountName | 当前账号 UID 与昵称，用于账号隔离和面板显示 |
| state.seen / baseline | 最近最多 3000 个 BV 号；是否已建立基线 |
| state.pending | 尚未确认发送完成的视频通知队列 |
| state.history | 最近最多 100 条检测记录，包含基线视频 |
| state.failures / error / note | 连续失败次数、错误与说明 |
| state.lastAttempt / lastSuccess / nextCheck | 毫秒时间戳；下次检查可为空 |

视频记录使用 `id`、`uid`、`author`、`title`、`published`、`url`；历史另有 `detected`。`published` 是秒级时间戳，其他记录时间是毫秒，不要混用。

新增可选字段应提供读取默认值。改变字段语义或结构时需要显式迁移方案与旧存储回归测试；不要借版本号修改自动清空数据。现有实现没有通用存储 schema 迁移框架，尚不需要为此额外引入基础设施。

## 调度与通知

- Promise 队列串行执行初始化、检查与设置操作，避免并行修改状态。
- 使用一次性 `chrome.alarms`；每次检查后重新安排，后台唤醒时确认任务存在。浏览器可能回收空闲 service worker，不能依赖常驻内存计时器。
- 失败按 `interval × 2^failures` 退避，上限 60 分钟。暂停取消定时任务；手动检查仍可执行。
- 新视频先写入待发送队列，再发送通知，发送后移除并落盘。发送失败保留队列；意外退出的极小时间窗可能重复发送。
- 投稿通知 ID 为 `video:BV...`；测试通知为 `test:<随机 UUID>`。连续测试前清理仍存在的测试提醒，不能清理真实视频提醒。兼容旧 `test` ID 的点击行为。
- 通知点击仅通过已验证 BV 构造 B站链接；测试通知打开设置页。

## 消息与输入边界

设置页支持 `status`、`check`、`save`、`test`。后台校验 `sender.id` 和准确的设置页 URL（忽略查询与锚点），不能因为 `sender.tab` 存在就拒绝合法设置页。监听器返回 `true` 保持异步响应通道，并用 `{result}` 或 `{error}` 响应。

不接受页面提供的任意链接，展示文字使用 `textContent`。新增消息类型、权限或接口目标时同步修改测试与文档。`scripts/check.mjs` 固定检查当前最小权限清单；必要权限变化应经过明确说明后更新清单与测试。

## 修改影响

| 修改位置 | 应同步检查 |
| --- | --- |
| manifest 路径 | 后台注册、options_page、图标、设置页 HTML 引用、来源 URL 校验、测试 |
| feed 解析/分页 | 脱敏接口样例、AV 类型、BV 去重、基线、翻页异常、页数缺口 |
| 账号/状态 | 切换账号、存储默认值、通知队列、升级兼容 |
| 通知 | 连续测试、失败恢复、点击链接、UID 筛选、Windows 实机横幅 |
| 设置页 | 表单保存、无响应错误、未保存表单不被状态刷新覆盖 |

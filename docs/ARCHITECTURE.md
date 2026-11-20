# 架构与维护边界

## 运行路径

`manifest.json` 加载 `src/background.js` 模块后台。后台导入 `src/core.js`；工具栏按钮通过 `openOptionsPage` 打开 `src/options/settings.html`，该页面只通过消息请求后台，不直接访问 B站接口。

后台访问 `/x/web-interface/nav` 确认登录账号。视频与普通动态分别读取 `/x/polymer/web-dynamic/v1/feed/all` 的 `type=video` 和 `type=all`，用 `offset` 翻页。启用直播并取得可选权限后，后台访问 `api.live.bilibili.com/xlive/web-ucenter/v1/xfetter/GetWebList?hit_ab=true` 获取已关注的开播房间。请求自动携带浏览器凭据，20 秒超时。这些接口可能变化，修改时需要脱敏样例和实测。

勾选面板打开时，后台通过 `/x/relation/followings` 每页查询当前账号的 50 条关注记录。每次翻页重新确认登录账号，账号变更时停止读取并关闭本次确认入口。面板的搜索和勾选在本地完成，整份关注名单只存在于本次弹窗会话中。头像仅使用 B站的 `i0`、`i1` 或 `i2.hdslb.com` HTTPS 图片地址。

第一页确认账号后，面板单独读取旧 `/x/relation/whispers` 名单。返回前复核登录账号，面板按 UID 合并去重并标注「悄悄关注」。旧接口失败时，普通关注仍可搜索和勾选。投稿、动态和直播继续使用各自的关注流，面板来源只影响可选择的 UID。

`core.js` 分别解析原创视频、普通动态和直播。以 BV 号和动态 ID 识别已检查内容，遇到上次记录、没有下一页或页数上限时停止。普通动态使用整条关注流的动态 ID 衔接分页，即使页面只有视频也能记录进度。直播按房间 ID 对比两次成功快照，只处理直播中的条目。账号 mid 改变时全部重建基线，各类提醒分别按 UID 筛选。

## 存储

使用 `chrome.storage.local`，访问级别为 `TRUSTED_CONTEXTS`。顶层只有 `settings` 和 `state`。异常历史单独存储在 `chrome.storage.session`。

| 字段 | 含义及约束 |
| --- | --- |
| settings.enabled / interval | 自动检查开关；间隔 1～60 分钟 |
| settings.rules | `video`、`dynamic`、`live` 各自有 `mode`（`all`、`selected`、`off`）和字符串 UID 列表。升级时读取旧 `mode` / `uids` 作为 `video` |
| settings.silent / maxPages | 静音；最大页数 1～10 |
| settings.issueLimit | 会话异常记录上限，20、50 或 100 条，旧设置默认为 50 |
| state.account / accountName | 当前账号 UID 与昵称，用于账号隔离和面板显示 |
| state.seen / baseline | 最近最多 3000 个 BV 号；是否已建立基线 |
| state.dynamicSeen / dynamicBaseline | 普通动态已扫过的关注流 ID，最多 3000 个；是否已建立动态基线 |
| state.liveRooms | 最近一次成功查询的开播房间 ID；`null` 表示尚未建立基线 |
| state.sources | 各类别的上次检查、上次成功、当前结果、连续失败次数及最早重试时间 |
| state.globalIssues | 登录检查、通知发送和扩展运行的当前异常，恢复时移除 |
| state.diagnosticScope | 随机隔离标记，确认切换账号时更换，防止显示上一账号的会话异常 |
| state.pending / history | 待通知队列和最近最多 100 条检测记录。旧记录没有 `kind`，按视频兼容 |
| state.failures / error / note | 连续失败次数、错误与说明 |
| state.lastAttempt / lastSuccess / nextCheck | 毫秒时间戳；下次检查可为空 |

记录共有 `kind`、`id`、`uid`、`author`、`title`。投稿或动态的 `published` 为秒，历史的 `detected` 为毫秒。直播通知队列项另含 `session`，用于区分同一房间先后开播产生的通知。链接根据类别和 ID 构造。

新增可选字段应提供读取默认值。改变字段语义或结构时需要显式迁移方案与旧存储回归测试；不要借版本号修改自动清空数据。现有实现没有通用存储 schema 迁移框架，尚不需要为此额外引入基础设施。

会话历史每条只保存来源、固定错误类别及可选状态码、首次和最后一次发生时间与次数。相同来源的连续同类错误合并，保留限额变化时立即剪裁。后台回收之后仍可读取，切换账号、重新加载扩展或结束浏览器会话时清空。存储不可用时仍可使用当前状态、定时检查和通知。

## 调度与通知

- Promise 队列串行执行初始化、检查与设置操作，避免并行修改状态。
- 使用一次性 `chrome.alarms`；每次检查后重新安排，后台唤醒时确认任务存在。浏览器可能回收空闲 service worker，不能依赖常驻内存计时器。
- 失败按 `interval × 2^failures` 退避，上限 60 分钟。各来源分别退避，失败不会阻塞其他来源。登录或通知发送失败仍走全局退避。暂停取消定时任务，手动检查仍可运行。
- 新内容先写入待发送队列，通知成功后移除并落盘。发送失败保留队列，下一次成功读取直播列表时移除已关播的待发送项。
- 正式通知 ID 分别使用 `video:<BV>`、`dynamic:<动态 ID>`、`live:<房间 ID>:<会话 UUID>`。测试使用 `test:<类别>:<内容 ID>:<UUID>`，只替换同类测试横幅，兼容旧投稿测试的点击。
- 投稿测试读取视频流首页，动态测试在设置页数内寻找最新普通动态，直播测试使用当前开播列表。直播列表为空时提供单独的演示入口，横幅点击返回设置页。真实内容链接根据类别与 ID 构造。测试不会更改基线、队列或检测记录。

## 消息与输入边界

设置页支持 `status`、`check`、`save`、`issue-limit`、`test`、`followings` 和 `whispers`。设置异常记录上限无需重新安排检查。两种关注查询都只读取数据，无需等待状态写入队列；普通关注页码必须有效，目标账号由后台向 B站确认。后台校验 `sender.id` 和准确的设置页 URL（忽略查询与锚点），不能因为 `sender.tab` 存在就拒绝合法设置页。监听器返回 `true` 保持异步响应通道，并用 `{result}` 或 `{error}` 响应。

不接受页面提供的任意链接，展示文字使用 `textContent`。新增消息类型、权限或接口目标时同步修改测试与文档。`scripts/check.mjs` 固定检查当前最小权限清单；必要权限变化应经过明确说明后更新清单与测试。

## 修改影响

| 修改位置 | 应同步检查 |
| --- | --- |
| manifest 路径 | 后台注册、options_page、图标、设置页 HTML 引用、来源 URL 校验、测试 |
| feed 解析/分页 | 脱敏接口样例、AV 类型、BV 去重、基线、翻页异常、页数缺口 |
| 账号/状态 | 切换账号、存储默认值、通知队列、升级兼容 |
| 通知 | 连续测试、失败恢复、点击链接、UID 筛选、Windows 实机横幅 |
| 设置页 | 表单保存、无响应错误、未保存表单不被状态刷新覆盖 |

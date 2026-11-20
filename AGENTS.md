# 项目维护规则

- 使用中文沟通与新增代码注释。先阅读 README 的维护流程，以及本次修改涉及的架构和测试说明。
- **manifest.json 和 package.json 版本固定为 1.0.0。只有用户明确指示才能改变版本，不为日常修复、提交或打包自动递增。** 用提交哈希和 CHANGELOG.md 记录维护。
- 仓库根目录是用户正在加载的 Edge 扩展目录，保留根 manifest.json；变更运行路径必须同时更新 manifest、HTML、后台消息来源校验、图标引用和测试。
- 保持最小权限。不要读取/保存 Cookie 值、复制用户浏览器数据或收集真实关注列表；测试使用虚构数据，接口样例先脱敏。
- 保持首次基线、账号隔离、BV 去重、失败退避和待发送队列行为。修改存储结构前设计兼容读取/迁移，不清空用户数据。
- 修复已知缺陷时补有意义的回归场景。执行 node scripts/check.mjs 与 git diff --check；如需 Edge 实测，明确区分已完成与待用户验证。
- 临时文件统一放 E:\Codex\BiliPush-Edge-Extension，不写源码目录或 .codex。确认不再需要且无其他任务占用后清理；需要用户实测的证据说明保留原因。
- 不自动发布商店、创建远端或推送代码。正式 ZIP 用 scripts/package.ps1，输出目录显式指定，只打包 manifest.json、src/、assets/。

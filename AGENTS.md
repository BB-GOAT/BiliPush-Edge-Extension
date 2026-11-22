# 项目维护规则

- 使用中文沟通与新增代码注释。先阅读 docs/MAINTAINING.md 的维护流程，以及本次修改涉及的架构和测试说明。
- **manifest.json 和 package.json 的版本号必须一致。只有用户明确指示才能同步改变版本，不为日常修复、提交或打包自动递增。** 日常变更记入 Git 提交。只有用户明确要求修改版本号时才更新 CHANGELOG.md，用简短、通俗的文字说明用户能感知的变化。
- 仓库根目录是用户正在加载的 Edge 扩展目录，保留根 manifest.json；变更运行路径必须同时更新 manifest、HTML、后台消息来源校验、图标引用和测试。
- 保持最小权限。不要读取/保存 Cookie 值、复制用户浏览器数据或收集真实关注列表；测试使用虚构数据，接口样例先脱敏。
- 保持首次基线、账号隔离、BV 去重、失败退避和待发送队列行为。修改存储结构前设计兼容读取/迁移，不清空用户数据。
- 修复已知缺陷时补有意义的回归场景。执行 node scripts/check.mjs 与 git diff --check；如需 Edge 实测，明确区分已完成与待用户验证。
- 临时文件统一放 E:\Codex\BiliPush-Edge-Extension，不写源码目录或 .codex。确认不再需要且无其他任务占用后清理；需要用户实测的证据说明保留原因。
- GitHub 发布按 docs/MAINTAINING.md 执行。只有用户授权后才创建远端、推送代码或修改仓库可见性。GitHub Actions 对主分支的版本更新提交自动打 Tag 并发布 ZIP。商店发布需单独授权。正式 ZIP 使用 scripts/package.ps1，显式指定输出目录，只打包 manifest.json、src/、assets/。

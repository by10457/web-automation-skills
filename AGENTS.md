# 网站自动化项目入口

本项目保存网站知识、可复用动作与业务编排入口，浏览器管理由独立的 bitbrowser-agent-kit 提供。

- 先读 README.md，再按目标网站读取 huyou/SKILL.md 或 qq-channel/SKILL.md 和对应 references；只使用实际存在的公开 CLI/JS 接口。
- 网站任务优先复用 scripts/index.mjs 的导出和现有 CLI。未知接口、页面改版或明确缺失能力才进入开发，不让日常任务重复实现 DOM 解析与连接。
- 区分 windowId（绑定字段 browserId）、targetId、postId/commentId；核对账号及圈子/频道，不能靠名称猜 ID。
- 写动作以用户任务授权为依据，复用已有准备、执行和核对流程；已有明确授权不重复询问，不确定提交不自动重放。
- 真实账号配置、评论内容、运行证据保存在仓库外；开发设计、调试记录和验收分析放在 Git 忽略的 .local-development/。
- 改名不意味着迁移账本或创建新工作区；沿用原 workspace 和操作记录。开发验证使用离线测试，实机互动需要具体任务授权。
- 后续新增代码采用有必要注释的普通 .js。现有 .mjs 接口在完成兼容迁移前继续有效，不在业务任务中临时改名。

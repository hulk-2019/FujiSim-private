# FujiSim 更新系统 · 后续工作 TODO

来源：`docs/superpowers/specs/2026-05-22-auto-update-codesigning-settings-design.md` 第 10 节
状态：本期不做，记录在案

---

## 1. Windows / Linux 平台支持

**当前状态**：仅支持 macOS 签名 + 公证 + 更新

**待做**：

- [ ] Windows EV Code Signing 证书申请（DigiCert / Sectigo，~$300+/年）
- [ ] `signtool.exe` 集成到 Tauri Windows 打包流程
- [ ] NSIS 安装包签名 + 自动更新走 Tauri Windows installer 模式
- [ ] Linux AppImage / Flatpak / DEB 三种分发格式选择
- [ ] Linux 签名（GPG 或 minisign）

**触发时机**：用户群体扩展到 Windows 用户、有商业版需求时

---

## 2. 增量更新（Delta Patch）

**当前状态**：每次更新下载完整 `.app.tar.gz`（约 50-100MB）

**待做**：

- [ ] 调研 Tauri updater 的 `installer` 模式
- [ ] 评估自实现 bsdiff/courgette 二进制差分的成本
- [ ] 服务端动态生成 patch（需要每个版本对存档）

**触发时机**：用户反馈"更新太慢"、移动网络场景占比变大

---

## 3. 多语言更新通知

**当前状态**：`latest.json` 的 `notes` 字段为单语字符串

**待做**：

- [ ] 协议扩展：`notes: { zh: "...", en: "..." }`
- [ ] 前端按用户当前语言挑选展示
- [ ] 兼容老协议（`notes` 是 string 时直接展示）

**触发时机**：海外用户占比明显时

---

## 4. 签名密钥轮换

**当前状态**：minisign 公钥硬编码在二进制中，无轮换机制

**待做**：

- [ ] 生成新密钥对
- [ ] 发布过渡版本（同时接受新旧两个公钥）
- [ ] 等所有用户升级到过渡版本后，再发只支持新公钥的版本
- [ ] 老密钥归档销毁

**触发时机**：私钥泄露事故、定期安全审计要求

**临时缓解**：`~/.tauri/fujisim.key` 必须严格保管（已加入 `.env.production.local`，离线介质备份）

---

## 5. 应用内回滚机制

**当前状态**：发布有问题的版本时用户只能手动从官网重新下载老版本

**待做**：

- [ ] 设置页"关于"标签增加"安装历史"展示
- [ ] OSS 保留过去 N 个版本的 release 文件不删
- [ ] 一键回滚按钮 → 下载指定旧版 → 安装 → 重启

**触发时机**：经历过一次"发版翻车"事故之后

**临时缓解**：发版前严格走 8.2 端到端测试；遇到事故时引导用户去 `static.ai520.wiki/fujisim/releases/` 手动下载

---

## 6. CI/CD 自动化发版

**当前状态**：发版手动跑 `pnpm version → pnpm build:mac → pnpm publish:update`

**待做**：

- [ ] GitHub Actions workflow（即使仓库私有也能用）
- [ ] 证书 / 私钥安全存储到 GitHub Secrets
- [ ] git tag 触发 → 自动构建 + 公证 + 上传 OSS
- [ ] 失败回滚和告警

**触发时机**：发版频率变高（>每月 1 次）、团队协作时

**临时缓解**：维护好 `.env.production.local` 模板，本地一条命令搞定全流程

---

## 优先级评估（仅供参考）

| 项 | 重要性 | 紧迫性 | 备注 |
|---|---|---|---|
| 1. Windows / Linux | 中 | 低 | 取决于产品方向 |
| 2. 增量更新 | 中 | 中 | 用户感知最强 |
| 3. 多语言通知 | 低 | 低 | 文案少时影响小 |
| 4. 密钥轮换 | 高 | 低 | 不出事就不出事，出事就完蛋 |
| 5. 回滚机制 | 中 | 中 | 第一次翻车会立刻提上日程 |
| 6. CI/CD | 中 | 中 | 节省人力 |

# AEO Fork 说明

> Status: ✅ **主线扩展** · Since 2026
> Upstream: [leaperone/MultiPost-Extension](https://github.com/leaperone/MultiPost-Extension)

## 我们 fork 了什么

`apps/extension-v2/` 是 [MultiPost](https://github.com/leaperone/MultiPost-Extension) 的 fork，保留全部上游能力（30+ 平台 / Plasmo / Article+Dynamic+Video+Podcast 4 类内容）的同时叠加 AEO 集成层：

- `src/background/services/aeo-client.ts` — AEO 后端客户端（rest API）
- `src/background/services/aeo-auth.ts` — AEO 账号绑定
- `src/tabs/link-extension.tsx` — 把扩展绑定到 AEO 租户
- 所有平台账号信息 + 发布结果 → 上报到 AEO 的 publish_tasks 表

## 与老版扩展的关系

`apps/extension/`（自研 + distro 启发的轻量插件系统）已**停用**。
- 见 [`../extension/DEPRECATED.md`](../extension/DEPRECATED.md)
- 老版保留是为了回滚兜底 + 部分基础设施（DSL 远端下发、Ed25519 签名）思路未来可能复用
- **新平台 / 新功能一律加在本目录**

## 加新平台的步骤（以企鹅号为例 2026-06-19）

1. 写 article handler：`src/sync/article/<id>.ts`
   - 模板参考 `src/sync/article/juejin.ts`（最简洁）或 `baijiahao.ts`（最完整）
2. 注册到 `src/sync/article.ts` 的 `ArticleInfoMap`
3. 写 account info：`src/sync/account/<id>.ts`
4. 注册到 `src/sync/account.ts` 的 `refreshAccountInfoMap`
5. 加 i18n key：`locales/{zh_CN,en}/messages.json` 的 `platform<Name>`
6. 不需要改 manifest（host_permissions 通配 `https://*/*`）

## 上游同步策略

- 定期从 `leaperone/MultiPost-Extension` rebase 上游变更
- AEO 集成层文件保持只读 + 显眼前缀（`aeo-*.ts`），减少冲突
- AEO 自加的平台（如 penguin）放在标准目录里，跟上游平台同模式，rebase 时手动 conflict resolve

## 不能做的事

- ❌ 删 i18n 文件或核心 sync 类型 → 会破坏上游兼容性
- ❌ 改 popup/sidepanel UI 的根布局 → 上游主要发版在 UI 层
- ❌ 把 Plasmo 升级到 alpha 版 → 等上游先升

## 构建

```bash
cd apps/extension-v2
pnpm install
pnpm dev      # HMR
pnpm build    # 生产打包，产物在 build/chrome-mv3-prod/
```

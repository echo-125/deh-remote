# PROMPT — 新窗口继续工作用

把下面整段复制到新对话窗口的第一条消息里。

---

## 提示词（从这里开始复制）

我在 `D:\workspace\agent\deh-remote` 有一个独立的 DSH（DeepSeek Harness）插件仓，
npm 包名 `@echo-125/deh-remote`，是「局域网远程控制」插件：手机连同一 Wi-Fi
扫码配对后，打开桌面版同一个 Web GUI，带移动端适配。引擎要求 `dsh >= 0.2.1-rc.2`。

它刚从 monorepo（`D:\workspace\agent\dsh-web`）拆出来成为独立仓，git 已初始化，
根提交 `dd3f3f3`。typecheck / test / build 三门禁已全绿
（452 passed | 1 skipped）。已装进桌面版 profile
`D:\Document\.dsh\profiles\desktop` 并验证过：设置侧栏有「远程访问」一级入口、
`192.168.1.100:<port>` 监听正常、配对与 /remote 通道可用、`lanBind` 关掉后
局域网立即不可达而回环不受影响。

**先读这两个文件再动手**：
1. `D:\workspace\agent\deh-remote\HANDOVER.md` — 完整交接：架构决策、目录地图、
   门禁状态、安装方式、已知问题
2. `D:\workspace\agent\deh-remote\AGENTS.md` — 本仓规则

## 不可动的设计约束

- **只做远程控制，可达性仅限局域网**。没有公网能力：不要加隧道、中继、
  公网基址、公网地址探测。宿主 webserver 保持回环，局域网入口靠
  `src/lan-forward.ts` 运行时转发器。
- **转发器必须丢弃客户端自带的 Host 与全部转发头**（含 RFC 7239 `Forwarded`、
  `true-client-ip`、`cf-connecting-ip`）。这是安全边界。
- **宿主控制台零输出**（已从 17 处 console 清到 0）。失败经状态帧 / 返回值 /
  HTTP 状态码上报。转发器失败看 `lanBindFrameOf().forward.error`。
- **`Config.enabled` 默认 false**，且它门住侧边栏入口、配对路由、转发器三者。
  设置一级入口 `src/client/settings-section.ts` 与插件详情页卡片**不能**被
  `enabled` 门住，否则关掉后无处开启。
- 两层回环判定（`isLoopbackClient` / `isLoopbackUpstream`）是安全边界，
  改它要同步 README 双语 + 测试。
- 卡片注册走 `ctx.slots.inject` 而非裸 `register`（官方座位声明得晚，
  裸 register 会抛 `slot not declared` 导致卡片静默消失）。
- 包身份三处要一致：npm 包名 `@echo-125/deh-remote`、cordis 行 id `deh-remote`、
  设置命名空间 `deh-remote`。改身份要同步 `cordis.patch.yml`、`mountOnce()` 键、
  卡片 `bundle` key（官方 `plugins.bundle.config` 按包名派发）、
  `data-dsh-plugin` 语义属性。

## 环境要点

- Windows，node v24.18.0，pnpm 11.28.5（仓里 `packageManager` 写 11.7.0，
  实际用 `pnpm` 命令会走 PATH 里的版本，都能跑）。
- `pnpm-workspace.yaml` 的 `packageExtensions` 是必需的：上游 SDK 包发布时
  漏声明运行时依赖（zustand/immer/shiki/katex 等），删掉它测试会红。
- 本机局域网地址 `192.168.1.100`；另有 Clash TUN 网卡 `198.18.x`，
  `src/lan.ts` 已排除，不要重新纳入候选。
- 安装进桌面版要加 `--config.minimumReleaseAge=0`（profile 里 dshmarket 版本
  在 pnpm 冷却期内，否则供应链策略拦下）。
- host 侧代码改动必须完全重启桌面版；只改 patch 配置热生效；
  `lib/client.js` 改完刷新页面即可。
- **不要重启或 kill 用户正在运行的 DSH 桌面版进程**（`DeepSeek Harness.exe`）。
  要另起验证实例就用自己的 `DSH_HOME`（如 `D:\tmp\dsh-<topic>`），
  用完停掉、删掉。

## 待办（按优先级）

1. `locales.ts` 里 `posture.exposed` / `posture.exposedHint` 两个 key 已是死文案
   （探针删了但没有产生者）。要么删掉（zh/en 同步，本仓不再跑 i18n:check 但
   字典键集要自洽），要么实现 LAN-only 的 `/api` 围栏自检。
2. monorepo 尾巴：`D:\workspace\agent\dsh-web\packages\echo-125-deh-remote`
   目录未删，还有未提交改动。确认本独立仓全绿后可以删。
3. `@echo-125/deh-remote` 未发布到 npm，目前只 link 安装。

## 我的第一个请求

（在这里写你要做的事）

---

## 提示词结束

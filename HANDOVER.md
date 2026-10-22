# HANDOVER — @echo-125/deh-remote

交接文档 · 最后更新 2026-10-22

本文件是这条工作线的唯一事实源。新窗口接手前先读完本文，再读
[AGENTS.md](AGENTS.md)（本仓规则）与
[PROMPT.md](PROMPT.md)（给新窗口的提示词）。

---

## 1. 这个插件是什么

DeepSeek Harness（DSH）桌面版的**局域网远程控制**插件：手机连同一 Wi-Fi，
扫码配对后打开桌面版同一个 Web GUI，带移动端适配。

- npm 包名 `@echo-125/deh-remote`（原 `@linxin666/dsh-remote-web-ui`，已改名以区分原版）
- cordis 行 id `deh-remote`，设置命名空间 `deh-remote`
- 引擎要求 `dsh >= 0.2.1-rc.2`
- 主开关 `enabled` **默认 false**（不要默认开启，这是明确的产品定位）

**核心设计约束：只做远程控制，可达性仅限局域网。** 不自带隧道、中继、公网基址，
不做公网地址探测。宿主 webserver 保持回环监听，局域网可达性由运行时转发器
`src/lan-forward.ts` 提供。

## 2. 仓库怎么从 monorepo 里拆出来的

原来在 `D:\workspace\agent\dsh-web`（pnpm monorepo，18 个包）里，现在独立成仓：

| 项 | 处理 |
|---|---|
| 源码/tests/配置 | 从 `packages/echo-125-deh-remote/` 整体复制 |
| `shared/tsdown.client.ts` + `shared/web-platform.ts` | 内联为 `build/` 下两文件，`tsdown*.config.ts` 改引用本地副本 |
| `shared/` 运行时模块 | **本包无 import**（已核查：所有相对 import 都在包内） |
| `pnpm-workspace.yaml` | 新建，`packageExtensions` 修补上游 SDK 未声明依赖的缺陷 |
| git | 新 `git init`，根提交 `dd3f3f3`（原仓该目录无历史提交，全是工作区改动） |

monorepo 侧还剩一个尾巴：`D:\workspace\agent\dsh-web\packages\echo-125-deh-remote`
目录仍在（含未提交改动）。要彻底拆干净就删掉它，但那之前先确认本独立仓全绿——
**本仓已经全绿**（见 §5）。

## 3. 目录地图

```
src/
  index.ts                  host 半区入口：Config schema、applyImpl、LAN 转发器编排
  pairing.ts                配对状态机（令牌、设备会话、撤销、快照去重）
  routes.ts                 /api/pair 路由族 + /pair-accept、/pair-app、/pair-ping
  gate.ts                   两层回环判定：isLoopbackClient / isLoopbackUpstream
  lan-forward.ts            局域网转发器（本插件唯一新增的可达性机制）
  lan-bind-plan.ts          转发计划（off / host-bind / no-address）
  lan-bind.ts               旧版受管块的一次性清理（不写回）
  lan-source.ts             多网卡时落地页的 LAN 源切换
  lan.ts                    LAN 候选地址过滤（排除 198.18.x 等不可达段）
  firewall.ts               主机防火墙规则维护
  remote-api.ts             配对设备门控的 /remote 数据通道
  remote-methods.ts         通道常量 + LOCAL_ONLY_PREFIXES（拒绝面）
  remote-channel-*.ts       浏览器半区 /remote 重写规则 + 内联 boot 脚本
  browser-polyfills.ts      Safari 17.4 才有的浏览器 API（AbortSignal.any / Promise.withResolvers）
  ws-control.ts             WebSocket 控制帧：隧道代答 Pong
  channel-log.ts            宿主侧通道追踪（写到 $DSH_HOME）
  diag-page.ts              服务端渲染诊断页（/pair-diag）+ 落地页诊断横幅
  client/                   浏览器半区：面板、设置卡、设置一级入口、移动适配
  client/diag-boot.ts       解析期诊断探针（早于任何客户端代码）
  client/diag-probe.ts      apply 期诊断探针 + 快照
  client/DiagPanel.tsx      页面内诊断浮层
  client/page-resume.ts     页面恢复即重连
  client/DirectoryPickNotice.tsx  「在电脑上选择文件夹」的等待提示
  client/DiagPanel.tsx      页面内诊断浮层
tests/                      51 个 spec
build/                      内联的构建预设（来自原 shared/）
```

## 4. 关键架构决策（不要重新调研）

### 4.1 局域网可达性
宿主 webserver 固定回环监听，profile patch 改不了它的绑定（`--host` 优先）。
所以局域网入口 = 运行时转发器：监听 `192.168.1.100:<webserver 端口>`，把 HTTP 和
WebSocket upgrade 转发到 `127.0.0.1:<同端口>`。

**转发器必须丢弃客户端自带的 Host 与全部转发头**（含 RFC 7239 `Forwarded`，
`true-client-ip`，`cf-connecting-ip`），再盖上局域网权威 + `X-Forwarded-For`。
这是安全边界：经转发器的请求永不被判为桌面，配对门禁继续生效。

`lan.ts` 会排除不可达网卡段（Clash TUN 的 `198.18.x`、链路本地、CGNAT 等）。
本机局域网地址当前是 `192.168.1.100`。

### 4.2 两层回环判定
- `isLoopbackUpstream`（socket + Host 回环，**忽略**转发头）→ 只判断「这个 Host
  能否被应答」（`isTrustedHost`）
- `isLoopbackClient`（无转发头）→ 发放凭据、交出桌面载荷、控制面的判定

改这个规则要同步 README 双语 + 本仓测试。

### 4.3 设置入口（两个座位）
1. **一级设置入口** `settings.section`（`src/client/settings-section.ts`），
   设置侧栏直接显示「远程访问」。这是主开关可达的关键——`enabled` 关掉时侧边栏
   入口消失，只有这里能开。
2. **插件详情页卡片** `plugins.bundle.config`（keyed by **包名**），由
   `installPluginCard` 注册。

两个座位共用同一个 `RemoteSettingsCardController`，编辑同一份表单。

**踩过的坑**：官方 `plugins.bundle.config` 座位由插件管理器自己的 `main` 行声明，
外部插件 `apply()` 跑得早时 `slots.register` 会抛 `slot not declared`，卡片静默
消失。必须走 `ctx.slots.inject`（等声明生命周期）。共享模块
`src/client/plugin-card-seat.ts` 已内联这份逻辑。

**另一个坑**：桌面版 profile 必须把包名列进 `dsh.profile.bundles`，只放
`dependencies` 不生效（插件根本不加载，`/pair-accept` 返回 404）。

### 4.4 静默是硬约束
宿主控制台零输出（已从 17 处 `console.*` 清到 0）。失败一律经状态帧 / 返回值 /
HTTP 状态码上报：
- 转发器失败 → `lanBindFrameOf().forward.error`
- 防火墙失败 → `firewall` 摘要
- 配对持久化失败 → `sweep()` 返回值

排查问题先看设置卡片里的局域网状态区，不要去找日志。

### 4.5 2026-10 这一轮：为真实手机可用性所做的改造

起因是用户报告「手机扫码连上后侧边栏一直显示『重新连接中』」。完整来历与改造史见
[PROJECT_HISTORY.md](PROJECT_HISTORY.md)，这里只留交接必需的结论：

**四个真实缺陷（都已修）**：

| 缺陷 | 机理 | 修在哪 |
|---|---|---|
| 隧道不代答 WebSocket Pong | 内环网关用 Ping/Pong 心跳；浏览器无法发 Pong，流被 `terminate()`，客户端无限重连 | `src/ws-control.ts` + `src/loopback-proxy.ts` |
| 缺 `AbortSignal.any` / `Promise.withResolvers` | 两者都是 Safari 17.4 才有的 API；iOS 16.6 缺失时官方 SDK 抛 TypeError，generation 永不 ready（永远「重新连接中」），control 流失败（工作区列表空） | `src/browser-polyfills.ts`（boot 脚本解析期安装） |
| 页面挂起后不重连 | 官方客户端不监听 `visibilitychange`，只能等退避（最长 10s） | `src/client/page-resume.ts` |
| 通道日志互相覆盖 | 「读-改-写整个文件」并发丢记录，会掩盖真实症状 | `src/channel-log.ts`（改为追加写） |

**诊断设施（长期保留，opt-in）**：宿主侧通道追踪（`src/channel-log.ts`）、服务端渲染诊断页
`/pair-diag` 与落地页横幅（`src/diag-page.ts`）、解析期探针（`src/client/diag-boot.ts`）、
客户端面板（`src/client/DiagPanel.tsx`）。手机无 DevTools、宿主又必须静默，所以诊断只能自建通道。

**约束提醒**：诊断探针**绝不能改变被观测通道的行为**。`tests/loopback-forwarding.spec.ts`
守住这一点（分片帧必须逐字节穿过隧道）；新增的回归测试要用**变异测试**确认有牙齿
（禁用修复 → 测试必须失败）。
## 5. 门禁与当前状态

本仓 `D:\workspace\agent\deh-remote`：

```
pnpm run typecheck   → exit 0
pnpm run test        → 44 files, 452 passed | 1 skipped (453), exit 0
pnpm run build       → lib/index.js 176 kB + lib/client.js 241 kB, exit 0
```

1 个 skipped 是 `tests/lan-bind.spec.ts` 里 `it.skipIf(win32)` 的 POSIX
文件权限用例，与 Windows 无关，不要动。

**原 monorepo 的 `pnpm test:scripts` 有 2 个预存失败**（telemetry worker 的
D1/SQLite 内存问题，环境性，与本次改动无关）。本独立仓不跑那个门禁。

## 6. 安装进桌面版

profile：`D:\Document\.dsh\profiles\desktop`。

```powershell
# 已装好；重装或换版本时：
cd D:\Document\.dsh\profiles\desktop
& "E:\Program Files\deepseekharness\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs" install --config.minimumReleaseAge=0
```

`--config.minimumReleaseAge=0` 必须加：profile 里 `dshmarket@1.66.45` 发布时间
在 pnpm 的 minimum-release-age 冷却期内，不加会被供应链策略拦下
（这是既有问题，与改名无关）。

profile 三处配置：
- `package.json` → `dependencies["@echo-125/deh-remote"]` +
  `dsh.profile.bundles` 里要有 `"@echo-125/deh-remote"`
- `cordis.patch.yml` → `- id: deh-remote` / `name: '@echo-125/deh-remote'` /
  `config: { enabled: false, requirePairingForLan: true, lanBind: false }`

**host 侧代码改动必须完全重启桌面版**；只改 patch 配置是热生效。
客户端 bundle（`lib/client.js`）改完刷新页面即可，不用重启。

## 7. 手动遗留物已清理

| 项 | 状态 |
|---|---|
| `netsh portproxy` `192.168.1.100:56951` | 已删 |
| 防火墙规则 `dsh-remote-lan-56951` | 已删（现由插件自管 `remote-web-ui (auto)`） |
| profile patch 里的 `trustedHosts` / `autoTunnel` / `relay` / `publicBaseUrl` | 已删 |
| patch 里的旧版受管 webserver 块 | 已删（插件激活时会一次性清理，之后不再写回） |
| `D:\Document\.dsh\logs`、`.plugin-manager\logs` | 已删（用户要求） |
| 测试用 DSH_HOME `D:\tmp\dsh-verify-lan`、`dsh-v2`、`dsh-rn`、`dsh-diag` | 已删 |

## 8. 配置字段（卡片可控项）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | **false** | 主开关。关 = 无侧边栏入口、无配对路由、无转发器 |
| `lanBind` | false | 局域网入口（转发器 + 防火墙） |
| `requirePairingForLan` | true | 裸 `/api` 面要求配对 |
| `maxDevices` | 4 | 已配对设备上限 |
| `tokenTtlMs` | 600000 | 配对令牌有效期 |
| `idleExpireMs` | 30 天 | 空闲设备过期 |
| `offlineAfterMs` | 25000 | 离线判定阈值 |
| `cookieName` | `dsh_pair` | 设备 Cookie 名 |

patch-only（卡片不暴露）：`devicesFile`、`profile`。

已删除的字段（**不要加回来**）：`autoTunnel`、`tunnelToken`、`relay`、
`publicBaseUrl`、`trustedHosts`、`pairingSource`。

## 9. 已知问题 / 待办
### 「添加工作区」的手机端反馈（已修）

手机点「添加工作区」→ 电脑弹原生对话框 → **需在电脑上完成选择**，手机端此前没有
任何视觉反馈。

机理：宿主在启动时采样一次目录选择后端（`dsh-host-directory-picker-auto`），只依据
**宿主自己的**绑定与信任事实 —— 它不知道有远程客户端连着；`native` 交互的客户端表面
是 renderless 的，等待期间不渲染任何东西。

修法：`src/client/DiagPanel` 同级的 `src/client/DirectoryPickNotice.tsx` 包裹
`ctx.remote.directoryPicker.pick`，在调用飞行期间提示「请在电脑上选择文件夹」。
官方调用本身不动。详见 [PROJECT_HISTORY.md](PROJECT_HISTORY.md) §4.1。
## 10. 联调时怎么验证

```powershell
# 路由是否挂载（401 = 挂载了但需鉴权；404 = 没挂载）
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:<port>/api/pair/status

# 局域网监听是否起来（应该同时看到 127.0.0.1 和 192.168.1.100）
netstat -ano | findstr :<port> | findstr LISTENING

# 局域网入口的安全面
curl.exe -s -o NUL -w "%{http_code}`n" http://192.168.1.100:<port>/api/pair/issue      # POST，期望 403
curl.exe -s -o NUL -w "%{http_code}`n" http://192.168.1.100:<port>/remote/api/session.list  # 期望 403（未配对）
```

`lanBind` 关掉时 `192.168.1.100:<port>` 应立即不可达，`127.0.0.1:<port>` 不受影响。

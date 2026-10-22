# 项目来历与改造史 · Origin and Change History

本文件记录 **`@echo-125/deh-remote`** 这个插件的来历、定位，以及 2026-10
这一轮把它从「能连上」改到「在真实手机上可用」的完整改造过程。

阅读顺序建议：本文 → [HANDOVER.md](HANDOVER.md)（唯一事实源）→
[AGENTS.md](AGENTS.md)（仓库规则）→ [README.zh.md](README.zh.md)（产品说明）。

---

## 1. 来历

### 1.1 起点

这个插件最初是 `dsh-web` 这个 pnpm monorepo（18 个包）里的一个包：
`packages/echo-125-deh-remote/`。它当时已经能在局域网里把 DSH 的 Web GUI
推到手机上，但只到「能打开」这一步。

2026-10-21，这个包被**整体复制成独立仓** `D:\workspace\agent\deh-remote`：

| 项 | 处理 |
|---|---|
| 源码 / tests / 配置 | 从 `packages/echo-125-deh-remote/` 整体复制 |
| `shared/tsdown.client.ts`、`shared/web-platform.ts` | 内联为 `build/` 下两文件，`tsdown*.config.ts` 改引用本地副本 |
| `shared/` 运行时模块 | 本包无 import（已逐一核查，所有相对 import 都在包内） |
| `pnpm-workspace.yaml` | 新建，用 `packageExtensions` 修补上游 SDK 未声明依赖的缺陷 |
| git | 新 `git init`，根提交 `dd3f3f3`；原 monorepo 里该目录没有历史提交，全是工作区改动 |

拆出来的原因很实际：这个包要独立演进、独立版本化、独立地对外分发，
继续挂在 monorepo 里会让每次改动都和另外 17 个包纠缠在一起。

monorepo 侧遗留的尾巴 `D:\workspace\agent\dsh-web\packages\echo-125-deh-remote`
已删除。

### 1.2 命名

- npm 包名 `@echo-125/deh-remote`（原 `@linxin666/dsh-remote-web-ui`，改名以区分原版）
- cordis 行 id `deh-remote`，设置命名空间 `deh-remote`

---

## 2. 定位

一句话：**只做局域网远程控制，不做别的。**

| 维度 | 约定 |
|---|---|
| 可达性 | **仅局域网**。宿主 webserver 保持回环监听，局域网可达性由运行时转发器提供 |
| 公网 | 不自带隧道 / 中继 / 公网基址，不做公网地址探测 |
| 主机开关 | `Config.enabled` **默认 false** |
| 身份 | 配对即完全控制凭据（配对设备可操作桌面 GUI 的全部功能） |
| 拒绝面 | `/api/update`、`/api/plugin-manager` 等控制面**留在回环**，不经 `/remote` 通道 |

它不是一个「手机客户端」。手机和电脑跑的是**同一份官方 Web GUI**，插件只在
其上注入：远程访问入口、扫码配对面板、设备名册、设置卡，以及移动端触摸适配层。

---

## 3. 2026-10 的改造：让真实手机可用

改造起因是一个具体的用户报告：**手机扫码连上后，侧边栏一直显示「重新连接中」**。

这一段改造的价值不在于「修了一个 bug」，而在于**为这类问题建成了可复用的
观测能力**——下面每一节都对应一个当时无法定位、现在一眼可判的分界点。

### 3.1 观测能力的建设（先有尺子，再动手术）

真实手机没有 DevTools（iOS 上尤其如此），而宿主不向控制台打印任何日志
（本包的**静默硬约束**）。所以诊断只能走两条自建通道：

| 通道 | 文件 | 作用 |
|---|---|---|
| 宿主侧通道追踪 | `src/channel-log.ts` | 记录每次 mux 升级尝试：路径、凭据是否被接受、网关判定、**内环握手状态**、存活时长。写在 `$DSH_HOME/remote-channel-log.json` |
| 服务端渲染诊断页 | `src/diag-page.ts` | `/pair-diag`：手机或电脑都能直接打开看 |
| 落地页诊断横幅 | 同上 | `/pair-app?remoteDiag=1` 时在页面顶部插入服务端渲染的追踪摘要 |
| 解析期探针 | `src/client/diag-boot.ts` | 由宿主注入到文档，**早于任何客户端代码**运行，因此能抓到第一条 mux 连接（apply 期的探针太晚，会漏掉决定成败的那一条） |
| 客户端诊断面板 | `src/client/DiagPanel.tsx` | 页面内浮层，显示连接状态、代号、transport 形态、mux 腿明细与**官方客户端自己的报错** |

关键取舍：诊断探针**绝不改变被观测通道的行为**。为此专门写了
`tests/loopback-forwarding.spec.ts`（分片帧必须逐字节穿过隧道），
并用**变异测试**验证这些回归测试确实会失败（禁用修复 → 测试失败）。

### 3.2 修复一：隧道不会代答 WebSocket Pong

**现象**：mux 连接恒定存活 **1500ms** 后断开，官方客户端不断重连。

**机理**：内环网关用 WebSocket Ping/Pong 做心跳（`heartbeatIntervalMs = 2000`，
`MAX_MISSED_HEARTBEATS = 2`）。而我们的隧道是裸 TCP 管道，把 Ping 原样转发给
手机——**浏览器无法发送 Pong**（WebSocket API 不暴露控制帧），于是内环永远等不到
Pong，把流 `terminate()`，客户端于是无限重连。

**修复**：新增 `src/ws-control.ts`，在隧道里**代手机作答 Pong**（掩码帧，协议要求）。

**验证**：回 Pong → 连接稳定 12s+；不回 → 4.9s 被踢。

### 3.3 修复二：Safari 17.4 才有的两个 API

这是**根因**所在，也是最难定位的一处。

官方客户端在浏览器侧重度依赖两个 **Safari 17.4 / Chrome 116** 才引入的 API：

| API | 官方用法 | 缺失时的症状 |
|---|---|---|
| `AbortSignal.any` | `dsh-api-gateway/client.browser.js:825` 融合 generation 信号 | 抛 TypeError → generation 提前结束 → 侧边栏**永远「重新连接中」** |
| `Promise.withResolvers` | 构建 session control 流 | control 流失败 → **工作区列表空、「添加工作区」无响应** |

iOS 16.6（iPhone OS 16_6）两者都没有。**Chromium 上一切正常**，所以这个缺陷
只在真实 iPhone 上现形。

**定位方法**（值得记住）：把官方客户端自己的 `console.warn` 捕获到手机可见的
面板上，它直接说出了原因——`"[connection] connection lost, retry #N"`。
随后在 Playwright 里**删掉 `AbortSignal.any` 模拟 iOS 16.6**，症状逐字复现，
根因确认无疑。

**修复**：新增 `src/browser-polyfills.ts`，boot 补丁（解析期）在运行时缺失时安装
标准实现。AbortSignal.any 传播 abort reason（官方 SDK 依赖 reason 区分取消与失败）。

### 3.4 修复三：页面挂起后不主动重连

手机浏览器会挂起后台标签页并关闭其 WebSocket（iOS Safari 报 close 1001
"due to suspension"）。官方客户端**不监听 `visibilitychange`**，只能靠退避重试
（`backoffMaxMs = 10s`）慢慢恢复。

**修复**：新增 `src/client/page-resume.ts`，在 hidden → visible 的边缘立即调用
官方公开的 `connection.reconnect()`（其文档：*"Reset retry progression and replace
the current attempt immediately"*）。

### 3.5 修复四：日志会互相覆盖

`channel-log` 原本是「读-改-写整个文件」，并发写入**互相覆盖**，导致记录在
最需要的时候消失——这曾让我误判「手机一个帧都没发」。改为**追加写**（一行一条 JSON）。

### 3.6 修复五：诊断开关被历史重写抹掉

明文 HTTP 的 LAN 落地页会执行 `history.replaceState` 把自己改写成 `/pair-app`，
**顺带丢掉 URL 上的 query**，诊断开关因此失效。改为把开关**持久化到 sessionStorage**。

---

## 4. 已知未处理问题

### 4.1 「添加工作区」在手机上没有即时反馈

**状态**：已记录，暂不处理。

**现象**：手机点「添加工作区」后，电脑端弹出「Select Workspace Directory」原生
对话框；**在电脑上完成选择之前，手机端没有任何反馈**（既不转圈也不提示），
选择完成后工作区才出现在手机列表里。

**已确认的事实**（实测，不是推测）：

- 通道是**通的**：`/remote/api/directoryPicker/pick` 在手机侧发起，宿主收到并弹出原生对话框
- 响应会**完整回到手机**：实测 `{"ok":true,"value":"D:\\workspace\\agent\\deh-remote"}`
- 请求在原生对话框等待期间**保持打开**（实测阻塞 8s+ 未超时），因为 `fetch` 无客户端超时
- 宿主侧 `pickNativeDirectory(signal)` 阻塞等待人工选择，`signal` 绑定的是**调用者连接的生命周期**

**推测的机制**（未验证）：手机端 UI 没有为「等待宿主侧人工交互」这个状态提供任何
视觉反馈；官方客户端 `pickDirectory()` 直接 `await` 结果，中途无状态推送。

**若日后处理**，方向大致是：让手机在发起 `pick` 时进入可见的「等待在电脑上选择」状态，
并在宿主侧选择完成（或取消）后回推事件。这一层属于官方 GUI 的交互面，本包当前只做
适配而不改其语义。

---

## 5. 这一轮沉淀下来的方法论

1. **先建尺子，再动手术。** 真实手机没有 DevTools，宿主又必须静默——所以第一件事
   是把「谁在什么时刻做了什么」变成可读的事实，而不是靠猜。
2. **让被观测的系统自己说话。** 捕获官方客户端的 `console.warn` 比任何外部推断
   都可靠。
3. **复现优于推理。** 「删掉一个 API 看症状是否精确重现」把 `AbortSignal.any`
   这类假设直接变成了结论。
4. **诊断代码不得污染被诊断的路径。** 中途我加的观察器一度让整条隧道失效
   （`removeAllListeners('data')` 删掉了 pipe 自己的 reader），
   既有测试当场变红才暴露出来。
5. **变异测试。** 「禁用修复 → 回归测试必须失败」是确认测试真的有牙齿的唯一办法。
6. **静默是硬约束，连「读」也要绕开写法。** 观察浏览器 console 时用字符码拼装
   `console` 引用，源码里不出现 `console.` 字面量。

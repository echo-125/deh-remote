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

### 4.1 手机上的「添加工作区」与「新建对话」落在默认工作区（已改机制）

**原现象**：手机点「添加工作区」→ 电脑弹出「Select Workspace Directory」原生对话框；
**在电脑上完成选择之前，手机端没有任何反馈**。而「新建对话」在没有工作区选中时，
会话落进「未分组」——它没有自己的目录。

**机理**（读官方 SDK 得到，不是推测）：

- 宿主在**启动时采样一次**（`dsh-host-directory-picker-auto` 的 `resolveDirectoryPickerBackend`），
  只看**宿主自己的**绑定与信任事实，回环绑定 + Windows → 判为 `native`。
  它**不知道有远程客户端连着**。
- `native` 交互的客户端表面是 **renderless** 的（`dsh-client-ui-directory-picker-native`）：
  它调用 `pick()` 然后等结果，**期间不渲染任何东西**。
- 于是手机点了按钮 → 电脑弹框 → 手机屏幕空白，直到你在电脑上选完。

官方其实**预留了**这一层反馈：`ui-workspace` 有 `directoryBusy` 状态与
「正在选择或添加工作区 / Selecting or adding a workspace」文案，但它**只用在快捷键
菜单里**，且只在 `browse`（手机内浏览）交互下才有意义。

**改后的机制**（`src/client/DefaultWorkspace.ts`）：

手机不再触发桌面原生对话框，而是走**默认工作区**——宿主自己就能解析它（账户 Documents
目录加一个固定叶子 `default-workspace`），而且 `workspace/initializeDefault` 是一个
**手机可直接调用的 Remote 方法**：

| 入口 | 现在的行为 |
|---|---|
| 手机点「添加工作区」 | 解析并采用**默认工作区**，不弹电脑对话框 |
| 手机点「新建对话」 | 落到**默认工作区**（而非「未分组」） |
| 电脑端同样操作 | **完全不变**：保留自己的原生选择器 |

实现要点：

- 只在**远程来源**重定向（`isLocalPage` 判定），桌面端不受影响。
- 官方调用**不被替换**：插件包装 `ctx.remote.directoryPicker.pick` 与
  `ctx.get("uiWorkspace").startSession`，包装的是同一个对象上的属性，官方 surface 持有的
  正是这些引用，且 `pickDirectory()` / `startSession()` 在**调用时**才读它们。
- `startSession` **显式指定工作区时不动**（那是调用方的决定），只有「未指定」才落到默认。
- 宿主拒绝创建默认工作区时（首次使用之外），插件**回退**到原行为，不让操作失败。
- 插件为此把 `uiWorkspace` 与 `workspaces` 加进 `inject`：包装必须等这两个官方服务就绪。

**诊断面板的等待提示**（`src/client/DirectoryPickNotice.tsx`）保留：一旦真的需要等待宿主
（例如宿主拒绝创建默认工作区、回到原生选择器），手机上会说明「请在电脑上选择文件夹」。
### 4.2 诊断开关从 URL 参数收敛为设置项（已做）

诊断最初只有 `?remoteDiag=1` 一个入口 —— 能用，但**不成体系**：它要靠人记住并
手工拼接 URL，而且明文 HTTP 的落地页会把地址栏重写成 `/pair-app`（顺带丢掉 query），
所以它还额外依赖 sessionStorage 持久化。

现在诊断是一个**正式的配置项** `diagnostics`（布尔，默认关）：

| 位置 | 行为 |
|---|---|
| 设置卡片「通道诊断」开关 | 打开后：宿主侧追踪写入、落地页带诊断横幅、`/pair-diag` 可读、客户端面板出现 |
| `?remoteDiag=1`（应急入口） | 仍然有效，且会为**整个进程**打开追踪 —— 不必先改设置就能拿到完整画面 |
| 两者都关 | **一个字节都不写**，手机不承担任何诊断开销 |

实现要点：追踪的开关是 `src/channel-log.ts` 里的模块级 arm 标志（隧道深处要写，
不能给每个调用点加参数），`appendChannelLog` 在未 arm 时直接返回；设置变化时
`sync()` 重新 arm。设置项**不影响访问控制** —— 诊断页仍然只回答已配对设备或回环调用者。
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

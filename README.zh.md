# @echo-125/deh-remote · DeepSeek Harness (DSH) 局域网远程控制插件

[English](README.md) | 中文

<p align="center">
  <img src="https://img.shields.io/badge/DSH-%3E%3D0.2.1--rc.2-4c6ef5?style=flat-square&amp;labelColor=454a54" alt="DSH">
  &nbsp;
  <img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square" alt="License">
</p>

<p align="center">
  <strong>DeepSeek Harness（DSH）官方 Web GUI 的局域网远程控制</strong><br>
  <em>扫码即连 · 手机与电脑共用同一份官方界面 · 竖屏触控手势优化 · 可撤销设备会话</em>
</p>

> 在局域网内远程控制 DeepSeek Harness (DSH) Web GUI，两端运行的都与本机一样是**同一份官方界面**：在设置按钮旁的二维码配对 iPhone、Android 手机、平板或另一台电脑。手机获得注入的竖屏触控适配层，电脑获得完整桌面；准入基于限时配对令牌与可撤销设备会话。可达性仅限局域网：宿主保持回环绑定，由运行时转发器提供本机局域网地址，不存在任何公网访问路径。

## 来历与定位

本插件源自 `dsh-web` monorepo 中的一个包，2026-10 拆分为**独立仓**（`build/` 内联了
原 monorepo 的共享构建预设），并从「手机能打开」改造到「真实 iPhone 上可用」。

- **来历**：从 monorepo 整体复制为独立仓，重命名以区分原版（`@echo-125/deh-remote`）。
- **定位**：只做**局域网**远程控制——不带隧道 / 中继 / 公网基址，主开关 `enabled` 默认关闭。
  配对即完全控制凭据，但 `/api/update`、`/api/plugin-manager` 等控制面**留在回环**，不经 `/remote` 通道。
- **手机端跑的是同一份官方 Web GUI**，不存在会漂移的第二套界面。
- **本轮改造**（详见 [PROJECT_HISTORY.md](PROJECT_HISTORY.md)）：隧道代答 WebSocket Pong、
  补齐 Safari 17.4 才有的 `AbortSignal.any` / `Promise.withResolvers`、页面恢复即重连、
  宿主侧通道追踪与手机可见的诊断页。

> 已知未处理问题：手机点「添加工作区」后，**需在电脑上完成文件夹选择**，手机端在此
> 之前没有视觉反馈（通道与返回都正常，见 PROJECT_HISTORY.md §4.1）。

---
本仓库是 DeepSeek Harness（DSH）的外部插件包，为单一双面包：host 半区持有配对令牌、设备会话、`/api/pair` 路由族、门控 `/remote` 通道、局域网转发器与对应的主机防火墙规则；浏览器半区渲染侧栏底部的远程访问入口、带二维码的配对面板、实时设备名单、设置卡片，以及官方界面之上的竖屏触控适配层。

## 功能

- **入口**：展开侧栏与窄栏中设置按钮旁的手机图标；tooltip 与可访问标签为「远程访问」。
- **面板**：「远程访问」标题、「设备配对」卡片（状态区「等待设备连接」+ 状态徽标）、大二维码、带复制按钮的配对链接与配对令牌、停止 / 刷新二维码操作，以及已授权设备列表（按 User-Agent 推断的设备名、在线/离线、最近活动时间、逐设备取消配对）。承载凭据的设备 id 与原始 User-Agent 值绝不渲染。手机与电脑共用同一条限时链接：在令牌过期或刷新二维码之前，该链接可为多台设备完成配对，每台各自生成独立设备会话。
- **手机侧**：扫码后以限时令牌绑定并重载进入**官方 Web GUI**——不存在会漂移的第二套界面。手机竖屏时插件在运行中的界面上注入触控适配层（见下文）。接受链路不依赖 cookie（`/pair-accept` → `/pair-app`）：官方应用壳由插件直接交付，手机全程不需要 harness 浏览器认证 cookie。随后由重开 service worker（https 源）接管此后对 `/` 的导航——来自历史、书签或标签恢复的重开直接回到应用，而不是 401 死路；纯 HTTP 局域网源不是安全上下文，其应用壳把 `/pair-app` 留在地址栏、每次重载重新校验设备 cookie（见安全模型）。
- **电脑侧**：同一链接在另一台电脑的浏览器里打开完整桌面 Web GUI，流量走门控 `/remote` 通道；未配对的电脑看到引导式拦截页（含手动粘贴配对令牌输入框），其后没有任何工作区数据。
- **安全**：同时只有一枚有效令牌（刷新二维码使旧链接失效；链接在其有效期窗口内可重复配对——扫码在浏览器间转手也能完成配对；令牌会过期）。停止会撤销所有配对设备与当前令牌——`/remote` 通道在下一次请求即切断它们。配对是本插件对 `/remote` 通道的访问控制；web server 自身保持回环绑定，因此局域网浏览器经本插件门控的 `/remote` 网关进入应用（客户端把传输改写到那里），而不是走原生 `/api`——对局域网权威，harness 的 Host 围栏会返回 403（见安全模型）。回环（127.0.0.1）继续直接使用 `/api`；本机应用交付的页面（桌面外壳的 `dsh-app://app/`、`file:` 页面）同样如此——配对链接只能经网络到达。配对设备是**完全控制凭据**（见安全模型）。
- **局域网访问开关（运行时转发器）**：设置卡片启动一个转发器，不改写任何文件。web server 保持回环绑定，转发器在本机第一个局域网 IPv4 地址、同一端口上监听，把每个请求——HTTP 与 WebSocket upgrade 一视同仁——转发到 `127.0.0.1:<端口>`。`--host`/`--port` 恢复常规语义：显式 `dsh web --host <局域网地址>` 照旧可用，此时转发器让出该端口。开关在进程运行期间即时生效：无需重启，也不写 profile。本机没有局域网 IPv4 地址时转发器保持关闭，卡片会如实说明；`198.18.x` 这类 fake-IP/TUN 地址以及其他不可达网段与网卡不会进入候选列表。同时维护对应的主机防火墙规则（Windows Defender 经 netsh；Linux firewalld/ufw/iptables；其他平台报告防火墙不受管），并展示运行中的绑定、可达局域网地址、与宿主自身 `localBindHost` 并列的转发器状态（`forward { listening, host, port, reason, error }`）以及防火墙状态。端口跟随 web server 自身的端口，因此桌面端重启可能改变它；网络变化后把开关关一次再打开即可。
- **设置卡片**：卡片注册进官方 keyed 槽 `plugins.bundle.config`，key 为确切的 bundle 包名 `@echo-125/deh-remote`，落在 设置 → 插件 → 该插件页；当家族分组 `dsh-web-settings` 已加载（全家桶安装）时，它同时注册进家族 list 席位 `web-ui.plugin.item`，若该分组后加载则会在两个席位之间迁移。注册等待槽位声明（`slots.inject`），不再发出会在未声明席位上抛错的裸 register。表单编辑 `enabled`、`lanBind`、`requirePairingForLan`、`maxDevices`、`tokenTtlMs`、`idleExpireMs`、`offlineAfterMs` 与 `cookieName`；`profile` 与 `devicesFile` 保持仅补丁可见，卡片不会提供实时写入无法兑现的控件。
- **实时状态**：桌面徽标实时切换为已连接；设备名单、停止与刷新二维码经回环状态流镜像配对服务。
- **只做远程控制**：一键家族更新是独立插件（`dsh-update`，同一个侧栏脚部席位），因此关闭远程访问、甚至禁用本插件，都不会把更新入口一起带走。配对设备通道拒绝自更新安装器（`/api/update`）与插件安装/管理（`/api/plugin-manager`）：两者属于其他包，留在普通回环路径上，不属于远程控制。
- **桌面端底栏一行**：宽栏下脚部动作占用者不再各自成行，而是与官方「设置」触发器共用一行，设置按钮不再独占整行；其他脚部块（用量速览卡、其它插件的块）仍各占一整行，56px 栏轨保持官方原有的堆叠脚部。

## 移动端适配层

官方桌面布局在 1024px 以下已自动折叠侧栏。在此基础上，视口为竖屏 + 粗指针 + 宽度不足 1100px 时插件注入：

- 以 CSS Modules **语义后缀**为键的样式表（`[class$="_composerSeat"]`），官方重构只改 hash 时选择器依然存活：折叠栏 44px 触控目标、16px 输入（防 iOS 聚焦缩放）、composer 的 safe-area 内边距、消息列表与侧栏的紧凑字号、设置弹窗纵向布局、PlanReview 卡片全宽；
- **可拖拽小鲸鱼按钮**作为折叠侧栏的展开入口（位置记忆；接到官方 `ctx.layout.toggleSidebar()`），侧栏展开时隐藏；
- **手势**：左滑收起侧栏、会话区右滑展开；长按会话行打开与桌面省略号相同的操作菜单；点会话行或侧栏外任意位置再次收起；
- **触控输入行为**：Enter 只换行（发送走发送按钮）、抑制程序化 composer 聚焦（不乱弹键盘）、隐藏官方 tooltip 气泡（触屏上会残留）；
- **移动端插件范围**：适配层激活时，右侧详情列与面向桌面的工具界面（SSH 终端、技能中心、任务看板、git graph、宠物、使用统计）一律隐藏——以 L2 语义根（`data-dsh-plugin`）为键，归属由声明方插件负责，官方类名变动也不会复活它们。这些是渲染抑制；客户端 bundle 仍会加载。激活时还会经官方 `ctx.layout.closeDetails()` 真正关闭详情面板。
- **手动退出**：`sessionStorage.dsh-remote-force-desktop = 1` 关闭整个适配层；横屏、桌面与宽视口永不触碰。

配对远程桌面同时运行在 **host 模式**：在本 harness 线上，「配置面仅限本机」的行为是客户端分支（`connection.isLoopback`），通道 boot 脚本在一切 boot entry 之前安装传输钩子（`__DSH_TRANSPORT__.ownsHost = true`）。host 模式由**服务器授予**：只有当设备门控的应用落地页（`/pair-app`）在 boot 补丁之前发布了授权标记时才会安装该钩子，因此交付给未配对浏览器（围栏被打开的部署）的应用壳永远不会自称机器主人。设置、凭据、Agent 预设与产出物在手机上与桌面完全一致——所有调用仍走门控 `/remote` 通道。门控通道让三类路径保持物理本地：`/api/pair/*`、`/api/update/*` 与 `/api/plugin-manager/*`。

## 环境要求

- DSH 安装的 `dsh` CLI 需支持 profile（`dsh --profile`、`dsh plugin`）——本包依托的 profile/bundle 机制。
- 局域网使用：在设置卡片打开**局域网访问**——它立刻在本机当前的局域网 IPv4 地址、web server 的端口上监听，因此网络变化后把开关关一次再打开即可；或以 `dsh web --host <本机的局域网地址>` 启动。通配的 `--host 0.0.0.0` 只在仍接受它的宿主上有效；DSH 0.2.1-rc.2 及以后会直接拒绝。默认 `127.0.0.1` 绑定且开关关闭时，面板会显示明确说明而非失效二维码。面板的铸造/停止端点设计上仅限回环：在局域网地址打开的桌面浏览器会看到「配对面板仅限本机使用」横幅。
- 主机防火墙规则需要管理员权限：Windows 与 Linux 由插件管理（netsh、firewalld、ufw、iptables），macOS 与没有受支持管理器的平台报告防火墙不受管，通常也无需规则。规则写入被拒会如实上报，且不影响回环监听器。

## 安装

本插件是独立 bundle，单独安装即可：

```sh
# 推荐：直接从 npm 安装（发布后）
dsh plugin --profile web add @echo-125/deh-remote@latest

# 或从本检出（开发循环）
dsh plugin --profile web add link:$(pwd)
```

重启 profile（`dsh web`），然后点开侧边栏页脚的电话图标。插件的
`cordis.patch.yml` 会插入唯一的插件行，同时挂载 host 与浏览器两个半区。

> `github:<org>/<repo>` 安装可用，因为包就在本仓根目录（`prepare` 脚本在安装
> 期间构建 `lib/`；pnpm ≥10 会拦下，直到你把打印出来的 key 复制进 profile 的
> `pnpm-workspace.yaml` `allowBuilds` 再重跑）。
>
> bundle 还必须列进 profile 的 `dsh.profile.bundles`。只写 `dependencies` 不够：
> 插件管理器只对它声明过的 bundle 合成 bundle patch，没列进去插件根本不加载
> （路由返回 404，设置面也不出现）。

重启 profile（`dsh web`），然后打开侧栏底部的手机图标。插件的 `cordis.patch.yml` 插入单一插件行，同时挂载两个半区。

> `github:<org>/<repo>` 安装适用于包位于仓库根的独立仓库（`prepare` 脚本在安装期构建 `lib/`；pnpm ≥10 会阻止，需把打印的 key 复制进 profile 的 `pnpm-workspace.yaml` `allowBuilds` 后重试）。monorepo 子包使用上面的 `link:` 形式。

## 使用

1. 打开设置卡片（单独安装时在 设置 → 插件 → 本插件行；全家桶安装时在 设置 → Web 插件 → 远程访问）并打开**局域网访问**；卡片展示运行中的绑定、与宿主自身 `localBindHost` 并列的转发器状态、防火墙状态与可达局域网地址，本机没有局域网地址时还会说明局域网入口为何关闭。转发器立即启停、无需重启：本机网络变化后把开关关一次再打开，它才会跟随新的地址。
2. 启动 `dsh web`，点手机图标，面板铸造一枚全新的限时二维码。
3. 手机扫码（或打开复制的链接）：设备完成配对，进入由插件不依赖 cookie 交付的**官方 Web GUI**（`/pair-accept` → `/pair-app?grant=...`），在 https 源上重载到 `/`，在纯 HTTP 局域网上则把 `/pair-app` 留在地址栏。多网卡机器上，落地页可能把手机切到另一个应答 `/pair-ping` 的局域网候选源，并携带一枚新的一次性授权；若一个候选都不应答，手机就留在它被交付的那一页。手机上竖屏适配层已生效——与桌面同布局、同实时状态。此后的重开（历史、书签）直接回到应用（https 源；见安全模型）。
4. **改为配对电脑**：复制同一链接，在另一台电脑的浏览器打开。相同往返后完整 Web GUI 在彼处经门控 `/remote` 通道运行；未配对电脑看到引导式拦截页，其后没有数据。同一时刻一枚令牌配一台设备；同一链接在其窗口内仍可为多台设备配对，刷新二维码会铸造新的一枚。
5. 桌面徽标实时切换为已连接；设备列表列出已配对设备并支持逐设备取消配对，停止则全部撤销。
6. 配对有效期、设备上限、局域网栅栏策略（`requirePairingForLan`）、局域网访问开关与设备 Cookie 名都在同一设置卡片配置。两个部署级键留在 profile 补丁里：`devicesFile`（配对会话存储路径）与 `profile`（本插件所管理的宿主 profile），卡片没有它们的控件。

## 开发

在本仓库内工作（无需 DSH 源码 checkout）：

```sh
cd deh-remote
export NPM_TOKEN='<token>'   # 仅当仍需私有 @deepseek-ai 认证时
pnpm install
pnpm run build
pnpm test
pnpm run typecheck
```

对端 API 来自官方 NPM SDK：用到的每个 `@deepseek-ai/*` 包都声明在 devDependencies（0.2.1-rc.2 cohort）中，TypeScript/Vitest 直接从 node_modules 解析类型——不需要 DSH 源码 checkout。消费侧 `prepare` 构建（`tsdown.prepare.config.ts`）不做类型检查地转译，git 安装同样无需 harness checkout。

## 检查

```sh
pnpm run typecheck
pnpm test
pnpm run build
```

## Harness 契约依赖

锚定 0.2.1-rc.2 线；本构建依赖的接缝：

- **`sidebar.footer.action` 底部席位**（0.1.7 shell 组合）：侧栏声明并渲染远程入口占据的席位。
- **`ctx.layout.toggleSidebar()`**（packages/client/ui-layout）：鲸鱼按钮经官方面板动作面展开折叠侧栏。
- **`ctx.connection.authenticatedUrl()`**（packages/client/connection）：代理为内部凭据一次性兑换启动令牌的官方接缝（`src/inner-auth.ts`），使再发起的 `/api` 调用满足 harness 浏览器认证校验。
- **`__DSH_FILE_UPLOAD__`**（file-upload 客户端钩子）：上传服务在构造时读取一次的可选启动前传输。远程引导补丁会发布它，使后台上传留在被改写的主线程 fetch 上，而不是逃出通道的 Web Worker（issue #1580）。
- **`__DSH_TRANSPORT__.ownsHost`**（client-connection 传输钩子）：配对远程桌面的 host 模式翻转。只有当设备门控的应用落地页在 boot 补丁之前发布了 `__DSH_REMOTE_HOST_GRANT__` 标记时才会安装，因此翻转是服务器授予而非按源自称。本线没有 host 侧按方法特权锁定——配置面在客户端按 `connection.isLoopback` 分支——也没有 `api/gate` 瀑布（gate 监听器保持挂载，待未来部署获得该接缝；配对强制在插件自己的 `/remote` 通道上）。
- **web server 绑定的归属**：profile 里的 `- id: webserver` 行属于官方 bundle，本插件永不写它——同 id 补丁行整行替换该行 config，且用户补丁层无法可靠求值依赖 `webStartup` 的 `!!js` 表达式，因此该行保留 `host: !!js ctx.webStartup.host ?? '127.0.0.1'`，`--host`/`--port` 照旧能到达它。局域网可达性改为运行时状态：`src/lan-forward.ts` 的转发器在 web server 的实际端口上、按局域网接口监听，并转发到同一端口的 `127.0.0.1`。

栅栏辅助函数（`isTrustedApiRequest` / `isLoopbackHostname`）在 `src/gate.ts` / `src/routes.ts` 本地重实现：connection 插件不再导出它们，配对路由自带一份、只作用于二维码链接宣传的字面量。回环问题在那里被拆成两层：`isLoopbackUpstream`（回环套接字与 Host，刻意忽略转发头）只判断一个 Host 能否被应答，`isLoopbackClient`（无转发头）判断谁能拿到凭据或桌面载荷。`shared/host/loopback.ts` 的共享副本继续让 `isLoopbackRequest` 拒绝一切被转发的请求，并新增 `isForwardedLoopbackRequest`，描述某个路由族可在自己的默认关闭开关之后放行的那个更窄形态。

## 手动 E2E：局域网配对往返

单测/组件 spec 覆盖路由族、栅栏、通道、局域网转发器与其状态帧、适配层，但配对闭环涉及非回环源上的真实浏览器。凡改动 wire 契约或连接循环之后请重跑：

1. 启动隔离实例：`DSH_HOME=/tmp/dsh-qa dsh --profile web --no-open --port 3191`；在 `http://127.0.0.1:3191` 打开卡片、打开**局域网访问**，确认卡片报告转发器已在本机局域网 IPv4 与该端口上监听。
2. 浏览器打开**回环** URL（`http://127.0.0.1:3191`）：手机图标位于侧栏底部；面板立即铸造二维码，链接形如 `<lan-url>/pair-accept?pair=<token>`。
3. 在第二个标签（390x844 触控模拟）打开该链接：链路在 https 源上是 `/pair-accept → /pair-app?grant=<一次性> → /`，在纯 HTTP 局域网上则停在 `/pair-app`；它设置设备 cookie、消费一次性授权、交付打过补丁的官方应用壳并启动 UI——`document.body.classList` 带 `dsh-remote-portrait`、适配样式表与小鲸鱼按钮存在、`__DSH_TRANSPORT__.ownsHost` 为 `true`。设置面渲染 host 数据（host 模式），而非 memory 镜像。https 部署下应用壳还会注册重开 service worker（`/pair-app.sw.js`）；在该标签刷新 `/` 会直接进入应用而不是 harness 401。纯 HTTP 局域网下同一个标签刷新 `/pair-app`，同样凭配对 cookie 进入应用。
4. 桌面徽标实时切换为已连接；局域网源的桌面页面则显示配对面板仅限本机使用横幅且不开状态流。
5. 桌面点停止切断设备：下一次请求 403 且 `unpaired`（栅栏页提供手动配对令牌输入）。

多网卡机器上，请再用另一枚局域网字面量的二维码重复第 3 步，确认落地页要么原地不动（该地址对 `http://<lan-ip>:<port>/pair-ping` 应答 204），要么切换到该源一次，并且切换失败时原页面仍然配对可用。

## 安全模型

- **配对是 `/remote` 通道的访问控制，且无条件生效**：每个请求必须携带有效配对设备 cookie，在任何字节转发之前强制。缺失或被撤销的会话收到 HTTP 403，JSON 拒绝携带 `error.code: "unpaired"`；浏览器 `EventSource` API 只暴露流失败，不暴露响应体。该门**不**跟随 `requirePairingForLan`：通道会用进程自身的浏览器认证凭据重新发起每一次调用，放行未配对调用者等于把该权限交出去。局域网策略只作用于普通 `/api` 面，永远不能放宽本通道（issue #1665）。
- **通道携带进程自己的内部凭据。** harness 浏览器认证 cookie 与 authority 绑定（为浏览器访问过的确切 `host:port` 签发）且没有回环豁免，因此转发到 `127.0.0.1` 的再发起请求无法复用设备的 cookie。插件因此自行兑换一次自己的启动令牌——与浏览器首次访问执行的是同一次交换——并把所得 cookie 附到再发起请求上。该凭据只在上面的配对门之后被使用；停止/取消配对会立即停止对它的使用。
- **运行时现实：局域网浏览器走 `/remote` 网关，不走原生 `/api`。** 本插件从不重绑 web server，因此宿主停在本机回环上，harness 的 `/api` Host 围栏对局域网权威返回 403。转发器让宿主在局域网上可达，但那里只有本插件自己的面在应答：配对入口页、状态视图与门控 `/remote` 通道。要在局域网权威上恢复原生 `/api`，需要 harness web server 的 `trustedHosts`，这不在本包范围内；运维自己用 `--host` 把宿主绑到网络时，那块面只由 harness 围栏约束，因为官方运行时没有任何组件发出 `api/gate` seam（对照本仓库安装的 0.2.1-rc.2 包核实）。在这种部署下，设备已经兑换过的浏览器凭据在停止/取消配对后仍然有效，直到其自然过期（30 天）——撤销约束的是 `/remote` 通道与配对 cookie，而不是那个凭据。请把宿主暴露到网络当作深思熟虑的决定，并优先让宿主留在回环、只把局域网开关开在你信任的网络上。
- **配对设备是完全控制凭据。** host 模式下它可达完整 host API——聊天、会话、设置、凭据、Agent 预设、产出物——与 SDK 对回环桌面的信任一致。门控通道仍然拒绝三类路径：配对面、自更新安装器与插件安装/管理。它们属于其他包，留在物理本地的回环路径上；只配对你控制的设备，停止或逐设备取消配对立即撤销。
- **控制端点仅限回环，状态视图对局域网访客只答最小载荷**：铸造/停止/撤销、设备列表、事件流与 lan-bind 状态只应答桌面请求（回环套接字与回环 Host、无转发头）。`/api/pair/status` 经局域网可达，但被转发或未配对的调用者只会收到 `{ ok, paired, requirePairingForLan, phase, lanAvailable }`；完整快照——令牌过期时间与计数——与逐设备列表只留在桌面。局域网源浏览器看到「配对面板仅限本机使用」横幅。
- **带转发头的请求一律视为远程（issue #1906），只有运维本人可以收窄它。** 部署在宿主前面的反向代理——frp、用户自己加的 nginx 反代等——拨的是 `127.0.0.1:<port>` 并把 Host 头改写成该上游字面量，于是源站为一个远程请求同时看到回环套接字与回环 Host：回环判定两半都成立，配对门会直接放行。围栏因此把携带 `CF-Connecting-IP` 或 `X-Forwarded-For` 的请求判为被转发、永不视为本机。该规则只存在一份（`shared/host/loopback.ts` 的 `isProxiedRequest`，由 `isLoopbackRequest` 消费），并随同步副本在全部包生效。本包把这个问题拆成两层（issue #1919）：`isLoopbackUpstream`（回环套接字与 Host，刻意忽略转发头）只判断一个 Host 能否被应答，`isLoopbackClient`（无转发头）继续守护配对门、`/api/pair` 控制面与桌面载荷。本包没有任何开关会把被转发的请求放进承载凭据的面；同级 task-board 插件把那个更窄的反例做成自己的默认关闭开关（`trustForwardedProxy`）。真实的桌面请求（回环套接字 + 回环 Host + 无转发头）仍判为本机；浏览器同源标记逻辑未改动，跨站请求照旧被拒。残余风险：会剥掉这两个头的代理会让请求重新回到与桌面相同的形状，任何基于头的规则都无法区分——请让代理转发 `X-Forwarded-For`（nginx 默认转发），并注意本机进程本来就能伪造任何请求头。
- **后台文件上传同样走通道。** 官方上传服务优先使用 Web Worker 载体，其独立全局对象不受主线程补丁影响；因此引导补丁（以及作为兜底的浏览器补丁）会发布官方启动前钩子 `__DSH_FILE_UPLOAD__`，并把打过补丁的 `fetch` 交给它：原始 `/api/session/uploadFileBinary` POST 会被改写到 `/remote`，并像其他受门控调用一样携带设备凭据。没有该钩子时，配对浏览器的上传会绕过通道，被 harness 浏览器认证围栏拒为 401（issue #1580）。该钩子仅在非回环源、且通道安装期间发布，且永不覆盖页面已有的钩子。
- **落地页 URL 只携带一次性授权，绝不携带设备 ID。** `/pair-accept` 签发 256 位、一次性消费、TTL 60 秒的授权并 303 到 `/pair-app?grant=<g>`；落地页消费它——无论成功、过期还是重放都先删除记录，因此重放或过期的授权解析不出任何设备——再由自己的响应把设备 ID 交给应用壳。设备 ID 是活的会话凭据，因此永不进入 URL、地址栏或重定向路径上的任何日志。请求经 TLS 到达时（`x-forwarded-proto: https`）配对 cookie 带 `Secure`，局域网明文 HTTP 下不带——在那里 Secure cookie 会被浏览器直接丢弃。303 指向访客实际到达的那个权威。
- **应用落地页不依赖 cookie。** 配对后二维码把设备带到 `/pair-app`——由本插件直接交付官方应用壳，不经过 harness 索引认证门；设备凭据经 `x-dsh-remote-device` 请求头（fetch）与 `device` 查询参数（WebSocket 升级）由引导补丁从 sessionStorage 挂载。因此手机浏览器完全禁用 cookie 时链路依然成立；有 cookie 时配对 cookie 仍是主凭据，手机路径不再需要 harness 浏览器认证 cookie。
- **重开由 service worker 接管（仅 https 源）。** 配对过的手机从历史、书签或标签恢复回来时导航到裸 `/`——插件不拥有的路径，harness 兜底座会用浏览器认证 401 应答（不依赖 cookie 的流程永远拿不到那份凭据）。应用壳因此注册 `/pair-app.sw.js`（与 `/pair-app` 同一栅栏；脚本是不含任何秘密的惰性逻辑）：只拦截对 `/` 的导航，经 `/pair-app` 网络优先地重发应用壳——同时校验设备 cookie 并刷新其活跃时间，每次重开也在为会话续期——离线时回退缓存的壳，插件不再应答时把导航原样放行（被撤销的设备随后看到 harness 应答或双语重扫页）。纯 HTTP 的局域网源永远不是安全上下文，因此也不会注册该 worker；那里的应用壳把 `/pair-app` 留在地址栏，刷新、书签或标签恢复都会经同一个设备门控落地页重新校验设备 cookie（配对失效后则落到双语重新配对页）。
- **撤销按请求生效**：停止落地时已在途的请求会完成；下一个请求 403。
- **配对设备会话默认持久化**：设备会话（非限时 QR 令牌）写入 `$DSH_HOME/remote-web-ui-devices.json`（0600，临时文件 + 原子改名）。`dsh web` 重启后配对 cookie 依然有效。刷新二维码铸造新令牌；重启不会恢复当前二维码。空闲超过 `idleExpireMs`（默认 30 天；重开 service worker 每次接管导航都会刷新该窗口）的会话被删除并须重新配对。设备 id 即会话凭据。需要时可用 `devicesFile` 指定其他绝对路径。更换 `cookieName` 会使现有设备失效（预期行为）。无法落盘的撤销（DSH_HOME 只读、磁盘写满）会删除过期设备库，而不是把被撤销的会话留在磁盘上，因此下次启动不会恢复它。
- **局域网入口永不让请求看起来像本机**：转发器丢弃客户端自带的 `Host` 与它发来的每一个转发头，再盖上它被到达时的局域网权威与 `X-Forwarded-For`、`x-forwarded-proto`，因此回环上游这一跳仍然以被转发请求的身份到达，每一个判断「这是不是桌面」的围栏都会拒绝它。局域网套接字抢不到时——网络变化后地址消失、端口已被占用——只损失局域网入口：回环监听器永不受影响，失败会记入日志并以 `forward.error` 上报，且不写任何文件，因此网络变化既不需要改 profile，也不需要重启。防火墙规则写不进去（缺少管理员权限）由卡片与日志如实上报，同样不触碰回环监听器。
- **桌面栅栏策略公开，但它不是访问控制**：`/api/pair/status` 只暴露布尔 `requirePairingForLan` 策略，供远程桌面在设置作用域可用前选择正确传输。该开关只作用于裸 `/api` 面：关闭它让未配对调用者在 harness 自己的围栏之下使用那块面，永远不会放宽 `/remote` 通道——该通道无条件要求配对凭据。该字段不是凭据，不暴露令牌、设备或计数；局域网调用者会收到的最小载荷见上面那条控制端点规则。
- **设备凭据仍会出现在 WebSocket 查询串中。** WS 握手无法携带 Web API 的请求头，因此无 cookie 凭据以 `?device=<id>` 传递；插件自己的 `/remote` 处理会消费它、且不再转发给内层回环请求，但源站访问日志以及运维自行放在宿主前面的任何代理仍会看到一条可认证为该设备的 URL。支持 cookie 的浏览器改用 cookie 认证握手。计划以短时一次性 WS 票据替代。
- **按构造就没有公网访问路径。** 本包不附带隧道、不做中继注册、也没有公网基址设置；转发器是它唯一新增的可达性机制，而它宣传的每个权威都是本机的一个局域网 IPv4 字面量。因此只有运维刻意在宿主前面加代理时，请求才可能带转发头到达——那正是上一条拒绝判为本机的情形。

## 已知限制与后续工作

- **局域网入口跟随转发器，而不是跟着 profile 写入走**：开关在进程运行期间启停它，因此这里没有需要重启的东西；网络变化后把开关关一次再打开即可。端口跟随 web server 自身的端口，因此重启桌面端可能让它改变。局域网地址已消失或端口已被占用时只损失局域网入口——回环监听器不受影响，状态帧以 `forward.reason`（`off`、`host-bind`、`no-address`）与 `forward.error` 上报。
- **旧版受管块会被清理一次，其中一种形态仍需手工介入**：本插件截至 0.4.8 写下的受管块会在每个进程首次激活时被剥离——原子替换、只在它确实存在时动手、保留文件权限且不回写任何内容——并由 `legacyBlockRemoved` 上报；清理在插件激活时运行，因此升级后的构建要到下一次 `dsh web` 启动才会执行。例外是固定 `0.0.0.0` 的块：DSH 0.2.1-rc.2 及以后的宿主在本插件加载之前就拒绝该值，那台宿主根本到不了清理这一步。手动编辑 profile 的 `cordis.patch.yml` 一次：删掉该块的两行标记注释（`# --- remote-web-ui lan-bind block ...` 与 `# --- end remote-web-ui lan-bind block ---`），以及两者之间那条 `- id: webserver` 条目——不要删掉整个标记区域，因为其他插件行可能就落在其中。
- **worker 注册被拒绝时会退回 harness 栅栏**：重开 service worker 只在存在 service worker 的源上注册。当一个本已安全的源拒绝注册（部署策略、浏览器加固配置）时，地址栏此时已经改到 `/`，重开需要重新扫码；纯 HTTP 局域网路径没有这个缺口——它的应用壳停在 `/pair-app`。
- **适配选择器跟随官方构建**：语义后缀策略可在 hash 变化中存活，但语义改名不行；每次官方 GUI 升级需要一轮视觉 QA（参考 dsh-LAN，这些后缀在多次官方发布中保持稳定）。
- **开发 HMR**：`dsh web --dev` 按路径轮询每个 roster bundle，重建本包（自身 `tsdown --watch`）即热重载客户端 bundle；host 半区需要重启。
- **profile 里挂了 `@deepseek-ai/dsh-hmr` 行会让所有设置保存失败**：只要 `hmr` 服务存在，官方配置编辑器就会把写入包进 `hmr.runExclusive`，而在本 cohort 上这种写入会被判为嵌套事务——Host 返回 `HMR transactions cannot be nested`，本插件的各设置卡片（以及官方设置页）都显示保存失败。该行由用户自行添加（没有任何 bundle 自带），桌面版 profile 用它为本地插件的 host 半区做热重载。从 profile 补丁里删掉 `- id: hmr` 这一行即可恢复保存；只在需要热重载该插件时再加回。观察于 2026-09-30，桌面版客户端 0.2.1-rc.2。

## 依赖说明

`qrcode.react`（MIT，活跃维护，支持 React 16–19）以无依赖 SVG 组件渲染二维码——无 canvas、无服务端出图。它构建期内联进客户端 bundle（与官方 skin/turtle-ui 插件内联非共享依赖一致），profile 安装因此无需 dsh peer 闭包之外的运行时依赖。`schemastery` 是 DSH 标准配置 schema 校验器。

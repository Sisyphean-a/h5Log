# H5 Log

测试环境的 H5 远程日志工具。手机上传日志，电脑按客户端查看；多个查看者互不影响。

## 启动

需要 Node.js 24.15+（24 LTS）和 npm。

```sh
npm ci
npm run build
npm start
```

打开 `http://127.0.0.1:3000`。点击工具栏“更多 → 接入 SDK”，可打开演示页并发送 console、异常及接口日志，在工作台查看真实 SDK 上传的数据。

开发：

```sh
npm run dev
```

工作台在 `http://127.0.0.1:5173`，日志服务在 `http://127.0.0.1:3000`。服务端和页面支持热更新；修改 SDK 后重新运行开发命令以构建 SDK。

## 两个包

| 包                             | 职责                                                       |
| ------------------------------ | ---------------------------------------------------------- |
| `packages/sdk` · `@h5-log/sdk` | console、JS 异常采集、独立上传、Axios 与可选 fetch 接入     |
| `packages/app` · `@h5-log/app` | 日志服务（接收、内存保留、查询、SSE）与工作台页面，构建为同一个产物 |

`packages/app` 内部 `src/server` 是 Node.js 日志服务，`src/web` 是 Vue 3 + Naive UI 的工作台（Vite 构建，组件库按需引入）。构建输出 `dist/server/cli.mjs`（自包含单文件，只依赖 Node 内置模块）与 `dist/web`，服务进程直接托管 `dist/web`；部署时只需 `dist` 目录，不需要 `node_modules`。

SDK 是独立分发的浏览器 ESM 包，保持单独打包，不随服务一起部署。

只需要部署一个 Node.js 服务，页面随服务一起提供。运行时不需要数据库、WebSocket 或 `node_modules`。可直接复制构建后的 `packages/app/dist` 到服务器运行，或使用随仓库提供的 Dockerfile：

SDK 接入步骤见 [SDK 说明](packages/sdk/README.md)。接入其他 H5 项目时先打包：

```sh
npm run pack:sdk
```

在目标项目安装生成的 `h5-log-sdk-0.1.0.tgz`，无需先发布 npm。该包是 ESM，适合现有 Vite 项目。

```sh
docker build -t h5-log .
docker run --rm -p 3000:3000 -e PORT=3000 h5-log
```

容器默认以非 root 用户监听 `0.0.0.0:3000`；日志只在容器进程内存，不挂载持久卷。

## 日志规则

- 仅在 H5 显式启用 SDK 时采集，生产构建应保持关闭。
- 测试数据原样采集，不脱敏。普通日志（包括桥接输出）统一由 console 自动采集，无需单独接入或分类；SDK 保留调用时快照，无法恢复业务代码已经摘要或截断的内容。
- 服务端按**接收时间**保留最近 12 小时；服务器重启后日志清空。
- 默认最多保留 8,000 条、16 MiB 的日志序列化数据，先达到哪个限制就先淘汰最旧记录。这不是 Node.js 进程总内存限制，也不保证完整存满 12 小时。需要更大窗口时调高 `MAX_LOGS`/`MAX_MEMORY_MB`。
- “客户端”是应用、环境和浏览器存储中的随机标识组合，不是 Android 硬件身份。页面每次初始化产生新会话。
- 页面显示“最近上报”，不将没有产生新日志误报为设备离线。
- 工作台默认聚焦一个设备：打开时自动选中最近上报的客户端，工具栏保留切换入口；不用先筛应用/环境就能看日志。
- 每页 200 条，可翻阅更早的保留日志；会话列表覆盖当前客户端范围内所有保留会话。暂停自动滚动仍接收日志，清空视图不删除服务器记录。
- 关键词在顶部一个输入框完成，回车即筛选：输入时先在本地立即过滤当前页，再向服务端收窄窗口；新到达的日志只有命中当前关键词才进入列表。
- 工作台把收到的日志旁路写入浏览器 IndexedDB（默认 50,000 条 / 64 MiB，可回看服务端保留窗口之外的记录）；本地历史只属于当前浏览器，不跨设备同步，服务器重启（serverId 变化）后重置。清空视图不清本地历史，存储不可用时自动退回服务端窗口。
- 选中网络日志可在详情中查看同一次请求与响应；仅当两条记录仍在服务器内存中时才能关联，已淘汰的记录会提示无法关联。导出操作保存当前页的 JSON Lines，不导出全部保留或本地历史。
- SDK 队列最多 1,000 条、4 MiB；默认每 250 毫秒最多发送一批 50 条（`flushIntervalMs` 可调，最小 50），失败按 1–30 秒退避，网络恢复后立即尝试。业务流程不等待上传；`getStatus()` 可检查队列、发送、丢弃和重试状态。
- 接入只需初始化 console/全局异常采集，再按实际请求方式挂载 Axios 默认 adapter 或显式开启 fetch 采集；二进制、事件流与请求流不读取正文，`Request` 自带流不会被克隆。接口收发通过 `requestId` 对应。
- 单条日志上限 128 KiB。快照最多展开 12 层、处理 2,000 个值、保留合计 64K 字符的字符串；触发限制会留下可见标记。文件只记录名称、类型、大小，不上传二进制内容。
- 页面退出、WebView 被系统终止、服务器不可达时允许丢失日志，不提供可靠消息队列或持久化补发。

## 部署

完成 `npm ci && npm run build` 后运行 `npm start`。默认监听 `127.0.0.1:3000`，适合由同机 Nginx 提供 HTTPS 入口。

无 Docker 时只需把 `packages/app/dist` 拷到服务器，用 `node dist/server/cli.mjs` 启动（需要 Node.js 24.15+）。`dist` 包含自包含的服务进程和页面资产，不含第三方依赖。

可设置环境变量：

| 变量               | 默认值      | 含义                                   |
| ------------------ | ----------- | -------------------------------------- |
| `HOST`             | `127.0.0.1` | 监听地址，局域网直连可改为 `0.0.0.0`   |
| `PORT`             | `3000`      | 监听端口                               |
| `MAX_LOGS`         | `8000`      | 内存日志条数上限                       |
| `MAX_MEMORY_MB`    | `16`        | 内存日志序列化数据大小上限             |
| `RETENTION_HOURS`  | `12`        | 保留时长（小时，可降到 1–2 省内存）    |
| `ALLOWED_ORIGINS`  | `*`         | 允许上传的页面来源；多个来源用逗号分隔 |

默认配置下进程稳定在约 45–55 MiB，突刺上传峰值约 80–100 MiB 后回落；Docker 镜像默认带 `--max-old-space-size=128 --max-semi-space-size=16`（实测峰值约 83 MiB）。调大 `MAX_MEMORY_MB` 时要同步放宽该上限，否则会 OOM。

在已有 HTTPS 的 Nginx `server` 中代理到服务：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 60s;
    client_max_body_size 1m;
}
```

HTTPS 的 H5 应配置 HTTPS 日志地址。服务部署在域名根路径；查看页、API、SSE 使用同一来源。服务面向受控测试环境，未内置账号和权限系统；需要入口认证时由反向代理承担，`ALLOWED_ORIGINS` 只限制浏览器跨域来源，不是认证机制。

## 检查

```sh
npm run check
```

执行 TypeScript 检查、SDK 与服务端契约测试及两个包构建。

项目重要规则与架构入口在 [.codestable/architecture/INDEX.md](.codestable/architecture/INDEX.md)，领域规则见 [.codestable/requirements/CONTEXT.md](.codestable/requirements/CONTEXT.md)。

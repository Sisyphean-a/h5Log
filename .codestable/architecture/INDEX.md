# H5 Log 架构入口

## Workspace

npm workspaces，只有两个包：可独立分发的 SDK，以及同时包含日志服务与工作台的 app。Node.js 日志服务托管构建后的 Web 页面；手机以 HTTPS 批量上传，工作台以 SSE 接收更新。部署说明由根 README.md 维护。

| 范围                           | 职责与入口                                                                          | 领域                   |
| ------------------------------ | ----------------------------------------------------------------------------------- | ---------------------- |
| [package:sdk](packages/sdk.md) | H5 采集、独立上传与 Axios adapter；packages/sdk/src/index.ts、axios.ts、types.ts    | context:remote-logging |
| [package:app](packages/app.md) | HTTP、SSE、内存记录与工作台页面；packages/app/src/server/index.ts、src/web/main.ts | context:remote-logging |

稳定规则从 [requirements/CONTEXT.md](../requirements/CONTEXT.md) 按范围加载，设计取舍的来源见 [history/2026-11.md](../history/2026-11.md)。

代码锚点：根 package.json、packages/*/package.json、scripts/dev.mjs。

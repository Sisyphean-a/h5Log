# H5 Log 架构入口

## Workspace

npm workspaces，只有三个包。Node.js 日志服务同时托管构建后的 Web 页面；手机以 HTTPS 批量上传，工作台以 SSE 接收更新。部署说明由根 README.md 维护。

| 范围                                 | 职责与入口                                                                       | 领域                   |
| ------------------------------------ | -------------------------------------------------------------------------------- | ---------------------- |
| [package:sdk](packages/sdk.md)       | H5 采集、独立上传与 Axios adapter；packages/sdk/src/index.ts、axios.ts、types.ts | context:remote-logging |
| [package:server](packages/server.md) | HTTP、SSE、内存记录与静态页面；packages/server/src/index.ts、store.ts、cli.ts    | context:remote-logging |
| [package:web](packages/web.md)       | 客户端定位、实时日志与历史分页；packages/web/src/main.ts、style.css              | context:remote-logging |

稳定规则从 [requirements/CONTEXT.md](../requirements/CONTEXT.md) 按范围加载，设计取舍的来源见 [history/2026-11.md](../history/2026-11.md)。

代码锚点：根 package.json、packages/*/package.json、scripts/dev.mjs。

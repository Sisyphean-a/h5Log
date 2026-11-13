# 领域上下文入口

## 作用域

- workspace：H5 Log 是受控测试环境的远程日志工具，当前只有 SDK 与应用（日志服务 + 工作台）两个包。
- [context:remote-logging](contexts/remote-logging.md)：日志来源、客户端/会话身份、12 小时内存保留和查看行为；映射 package:sdk、package:app。

架构入口：[architecture/INDEX.md](../architecture/INDEX.md)。不将金融业务、26 原生桥接协议或业务登录规则归入本项目。

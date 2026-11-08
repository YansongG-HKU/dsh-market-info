# 请求取消与总截止时间强化

Issue: https://github.com/YansongG-HKU/dsh-market-info/issues/1

快速传输层 net-fast 的 signal 贯穿队列、重定向和底层 HTTP 请求。取消会移除排队项和监听器；一个截止时间覆盖排队与所有重定向，不会逐跳重置预算。

已发布的 lib/net.mjs 也使用一个截止时间，覆盖主机节流、重试退避、直接 GET/POST 和代理 CONNECT/TLS；取消后不会降级为直接连接。数据源 runner 将父级取消信号绑定到 getJson/postJson/fetchJson/request，显式的子信号通过 AbortSignal.any 合并，不能抹掉父级截止时间。

验证：16 项本机 HTTP 回归全部通过，包括预取消不触网、进行中取消、饱和队列取消不泄漏槽位、重定向和排队总截止、旧入口退避截止、代理取消，以及四个 adapter helper 在缺失或独立子信号时均结束调用并关闭底层请求。测试在池清理前检查请求已关闭，避免只赢得超时竞争却遗留后台请求。

本地现有数据源兼容性 smoke 为 31 项通过；其中未发布的具体适配器、service 和 UI 功能不属于本 PR，也没有作为远端可重现的验收条件。真实第三方金融源可用性不属于确定性测试结论。

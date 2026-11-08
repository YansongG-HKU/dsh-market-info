# 网络解压响应性复查

Issue: https://github.com/YansongG-HKU/dsh-market-info/issues/3

快速 HTTP 与旧版代理网络路径统一使用 lib/decode.mjs 异步 zlib，将解压移至共享 libuv 线程池。原导出同步 decompressBody 保持兼容，仅网络调用改为异步；旧代理损坏压缩的原始字节回退语义保持原样。快速路径仍明确报告损坏压缩错误。

按 [Node 官方说明](https://nodejs.org/api/zlib.html#threadpool-usage-and-performance-considerations)，异步 zlib 共用线程池且大量对象会带来内存压力；本实现保留已有每 host 4 并发上限，未新增独立线程池。chunkSize 256KiB，减少默认 16KiB 下的大量输出分片回调；每次并发解压相应增加缓冲开销。

16MiB gzip 本机回环，5 轮，基线 3fdfbee 的事件循环最大延迟中位数 32.46ms、请求总耗时中位数 33.92ms。异步默认分片约 15–18ms / 73–83ms；64KiB 试验 15.61ms / 56.36ms；最终 256KiB 19.60ms / 42.31ms。选择 256KiB 作为本机的响应性与吞吐折中，样本较少不作稳定 SLA。单请求总耗时有所增加，不能把这项改动说成请求加速。复现：node scripts/performance.mjs；脚本只访问本机临时 HTTP 服务，并验证解压内容完整。

24 项确定性测试通过：已有取消/排队/重定向/adapter 回归，gzip/br/deflate/plain 字节一致性（含旧 GET/POST 入口）、损坏压缩、异步解压期间 abort/deadline、同步兼容 helper。取消先结束等待并跳过后续转字符串；已经开始的原生解压任务可能继续到完成，不宣称可强制终止其 CPU 工作。旧代理完整 TLS 压缩回包未增加独立端到端夹具；共享解码器和旧 CONNECT 取消路径分别有覆盖。

本次不发布工作区已有的其它 adapter/service/UI 开发，不以第三方源在线可用性作为验收。JSON.parse、Buffer 转字符串仍在主线程；先观察真实 trace，再考虑流式解析或输出上限等后续架构改动。

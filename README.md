# dsh-market-info — 市场资讯（DSH 插件）v0.8.0

侧边栏「市场资讯」：19 个新闻源聚合 + 顶部常驻行情条 + 行情页 + 点开看走势图。
5 秒级刷新（3–300 秒可调，失败自动降频），新闻点开即读全文，纯文本缓存严格限量。

> 前身是 `dsh-market-lens`（0.7.3）。0.8.0 起包名 / 仓库 / 面板路由全部改为 market-info，
> 模型侧四个工具名 `ml_feed` / `ml_search` / `ml_read` / `ml_quotes` 保持不变。

> **兼容性（DSH 0.2.2-rc.1）**：Client 只依赖 `slots`（0.2.2 中由 `dsh-client-ui-renderer` 提供，槽位契约与 0.2.1 字节级一致），Host 侧 tools / systemPrompt / webServer 接口未变。

## 功能
- 行情：16 个默认标的（美股指数 / A股 / 恒指 / 日经 / 美元指数 / 汇率 / 美债 / 黄金 / 原油 / BTC / ETH / 个股），
  TradingView 批量主源一次请求取全，腾讯 / Yahoo / CoinGecko 兜底
- 走势图：点 ticker 或行情卡片打开抽屉，1日/5日/1月/3月/1年切换；1日分时来自 Eastmoney / OKX，日线来自
  Eastmoney / OKX，Yahoo 作为最后兜底；SVG 手绘、悬停十字线、无需任何图表依赖
- 快速刷新：默认 5 秒一轮，主源单请求 + 2 秒地板缓存 + 单飞（并发合并）+ 失败熔断降频（30 秒）+ 页面隐藏暂停，
  刷新间隔在设置里 3–300 秒可调
- 资讯流：19 个源聚合，分类 / 来源 / 关键词三重筛选，可增删源、一键恢复默认
- 源类型：RSS、Bing News 搜索、Google News 搜索、RSSHub 路由、华尔街见闻 7x24 JSON、东方财富快讯 JSONP
- 反爬/反封锁：浏览器头与 UA 轮换、Cookie 罐、重试+退避、主机限速、代理池、挑战识别、源被拦自动 Bing News
  site: 兜底、可选阅读代理、面板内抓取诊断
- 阅读：任意新闻/彭博 URL → 转载副本全文；点击资讯流条目自动带上标题做转载检索，直连被墙/付费墙时也能找到可读副本；
  快讯类源没有独立正文页时先展示资讯流摘要；只抓到开头（付费墙）会标注 partial；找不到时可打开原文或看候选副本；
  换副本、收藏、复制/导出 Markdown
- 搜索：标题精确搜索转载候选（Yahoo/DDG/Bing + 合作站 site: 深搜）
- 界面：顶部 ticker、行情卡片、双栏设置、760px 正文、移动端 375 无横向滚动、44px 触控

## 组成
- Host: index.js（工具 ml_feed / ml_search / ml_read / ml_quotes + 面板路由 /market-info + 系统提示段）
- lib/quotes.mjs 行情与历史：TradingView scanner 批量 + 腾讯 + Yahoo + CoinGecko；
  Eastmoney kline / OKX candles / Yahoo chart 历史序列，含限速与 429 退避
- lib/net.mjs   反爬向抓取：persona 头/重试/退避/Cookie 罐/代理池/压缩解码/封锁识别/主机限速
- lib/feed.mjs  多源聚合 + 自动兜底
- lib/unwall.mjs 转载副本搜索/排序/正文抽取 + Google News 解析 + 阅读代理回退
- lib/store.mjs 纯文本缓存 + 收藏 + 设置（硬上限、LRU/TTL、antiBlock、watchlist、刷新频率）
- lib/routes.mjs /market-info 面板与 API（/api/quotes、/api/history、/api/net/test …）
- client.js     侧边栏「市场资讯」+ main 槽位（内嵌 /market-info/ui）
- ui/           面板前端（原生 HTML/CSS/JS，无依赖，SVG 手绘走势图）

## 测试
    node test/plugin-smoke.mjs   # 8 项：Host/Client 接线 + 四个工具真实调用（需网络）
    node test/smoke.mjs          # 62 项：模块单测 + 真实网络 + HTTP 接口（阅读回归/行情/历史/快速刷新/抗封锁）
    # 合计 70 项
    node test/serve.mjs 7799     # 本地起面板调试服务（不经过 DSH），打开 http://127.0.0.1:7799/market-info/ui

## 安装
1. 把仓库克隆到本机任意目录（下称 `<插件目录>`）：

       git clone https://github.com/YansongG-HKU/dsh-market-info.git <插件目录>

2. profile 的 package.json 里加入依赖与 bundle 条目：

       "dependencies": {
         "dsh-market-info": "link:<插件目录>"
       },
       "dsh": {
         "profile": {
           "bundles": ["dsh-market-info"]
         }
       }

   （`dsh.profile.bundles` 的具体层级以你 profile 现有写法为准。）

3. `pnpm install` 后重启 DSH 一次。

默认缓存/设置目录：Windows `%LOCALAPPDATA%\dsh-market-info`，其他平台 `~/.dsh-market-info`；
可用插件 config 的 `dataDir` 覆盖。

## 从 0.7.x 升级
- 面板路由：`/market-lens` → `/market-info`（UI 与 API 全部随之变化）
- API gate 头：`x-market-lens: 1` → `x-market-info: 1`
- 数据目录：`~/.dsh-market-lens` → `~/.dsh-market-info`（旧缓存不迁移，可手动复制 settings.json / 收藏）
- 工具名不变：`ml_feed` / `ml_search` / `ml_read` / `ml_quotes`

## 许可
MIT，见 [LICENSE](./LICENSE)。

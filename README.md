# dsh-market-info — 市场资讯（DSH 插件）v1.10.1

侧边栏「市场资讯」：**48 源官方 / 终端 / 世界监测数据面，19 个类别归入 7 个域** + **公司档案** + 19 个新闻源聚合 + 顶部常驻行情条 + 行情页 + 点开看走势图。
5 秒级刷新（3–300 秒可调，失败自动降频），新闻点开即读全文，纯文本缓存严格限量。

> 前身是 `dsh-market-lens`（0.7.3）。0.8.0 起包名 / 仓库 / 面板路由全部改为 market-info，
> 模型侧四个工具名 `ml_feed` / `ml_search` / `ml_read` / `ml_quotes` 保持不变。
> 0.9.0 新增第三套数据面与 `ml_filings` / `ml_macro` / `ml_brief`；0.9.1 增加同花顺 / 新浪 / 东方财富的公开终端数据；
> 0.9.2 增加公司档案与 `ml_company`；0.9.3 增加资金与结构数据；0.9.4 增加期货与预测市场；
> 0.9.5 增加航运、地缘与气候；0.9.6 按实测节奏给全部 39 个源分级并据此调度；0.9.7 低频源移出冷启动并记录延迟趋势；1.0.0 引入「域」层，新增利率/外汇/公司行动/债券/期权与总览仪表盘；1.1.0 公司档案接入五类公司行动并修掉缓存键缺陷；1.2.0 派生指标时间序列 + 公司相关新闻 + 工具按域取数；1.3.0 六十天回填 + 总览两栏看板 + brief 域汇总；1.4.0 交易所回购利率补上资金利率缺口；1.5.0 隔夜回购 60 天回填 + KPI 带分组；1.5.1 实时网络断言可跳过 + 序列标注是否有历史；1.6.0 序列改为可重建缓存（不做本地聚合）+ VIX 120 天公开历史；1.7.0 两融余额 90 天回填；1.8.0 北向成交额与南向净买入 134 天回填（北向净买入已停止披露，不接）；1.9.0 行业资金流交叉验证不通过→改接已验证的全市场主力净流入；1.10.0 资金面四联只读看板（交集对齐、不插值）。

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
- 公司：搜索框 + 候选 chips + 档案头 + 指标卡 + 双栏（财务指标表 / 公告 + 研报），桌面双列、移动端单列

## 官方 / 终端数据面（0.9.x 新增）

二手新闻的独家窗口通常 5–30 分钟就被官方稿覆盖。这一层直接吃官方原文与终端公开页，按类别聚合：

| 类别 | 覆盖 |
| --- | --- |
| 披露 `filing` | 巨潮资讯、上交所、深交所、香港披露易、SEC EDGAR 全文检索与 XBRL frames |
| 宏观 `macro` | 国家统计局、海关总署、外管局、FRED、BLS、ECB、美国财政部 FiscalData、CFETS 中间价 |
| 政策 `policy` | 中国人民银行、美联储 RSS |
| 资金流 `flow` | CFTC COT 持仓、同花顺个股资金流排行、沪深港通十大成交、融资融券余额榜、龙虎榜 |
| 波动率 `volatility` | Cboe 延迟报价与 VIX |
| 制裁 `sanction` | OFAC SDN |
| 快讯 `flash` | 同花顺 7×24、新浪财经 7×24 |
| 研报 `research` | 东方财富研报摘要（机构 / 评级 / 当年 EPS 预测） |
| 行业 `industry` | 行业 / 概念板块轮动（涨跌幅、主力净流入、涨跌家数、净占比） |
| 期货 `futures` | 国内（上期所 / 大商所 / 郑商所 / 中金所 / 广期所）与外盘（NYMEX / CBOT / ICE / BMD / TOCOM），按品种去重 |
| 预测 `prediction` | Polymarket / Kalshi / Manifold / Metaculus 事件合约概率（本机网络常被墙，失败原因写在源健康度） |
| 航运 `shipping` | 波罗的海 BDI 干散货指数；马六甲 / 苏伊士 / 巴拿马 / 好望角 / 上海外海 / 鹿特丹外海未来 24h 浪高 |
| 地缘 `geo` | 联合国新闻·和平安全频道；GDELT 全球冲突/制裁事件（慢且限流，退避 15 分钟） |
| 气候 `weather` | NASA EONET 全球自然灾害（野火/强风暴/火山/洪水/地震）；六个中国主产区未来 3 天降水与气温 |

合计 **48 个适配器**，其中 38 个在本机实测能出数据。全部只读匿名公开页，不登录、不回放付费权限；
付费终端（iFinD / Choice）与商业数据（卫星影像、AIS 船位、港口拥堵）不在此层。

### 刷新分级（按实测更新节奏，不是拍脑袋）

每个源实测「最新一条有多新 + 相邻条目间隔 + 抓取耗时」，再定档；**档位决定缓存 TTL**。

| 档位 | 缓存 | 源数 | 谁在这一档 |
| --- | --- | --- | --- |
| T0 实时 | 30 s | 6 | 国内期货、外盘期货、行业板块、VIX、同花顺 7×24、新浪 7×24 |
| T1 快速 | 10 min | 17 | 巨潮/上交所/深交所/港交所公告、SEC 全文、东方财富研报、同花顺资金流、沪深港通、龙虎榜、天气、海峡海况、联合国新闻、GDELT、四个预测市场 |
| T2 常规 | 3 h | 9 | 美联储、欧洲央行、人民银行、国家统计局、FRED、BDI、融资融券余额、NASA 事件 |
| T3 低频 | 12 h | 7 | OFAC 制裁、CFTC 持仓、美国财政部 MTS、SEC XBRL、海关总署、外汇管理局、BLS |

调度按档位排序抓取（热源先跑），失败退避也按档位分级（T0 只停 60 秒，T3 停 15 分钟）。
面板刷新间隔取当前视图里最快的一档：看着期货时 30 秒一轮，只看月报时 10 分钟一轮，标签页隐藏即暂停。

**T3 不参与冷启动**：低频源（OFAC / COT / 月报 / 季报）在主批次跑完后由后台补，首屏显示「N 源延后加载」，
下一轮自动读缓存补齐；显式按 T3 筛选或传 `includeCold` 时立即抓。
健康度表里的**趋势**列画的是最近 16 次延迟，少于 3 次采样标 `≈`，只有稳态 p50 ≥6 秒才标琥珀色的「慢」。

面板「官方」标签页提供分类/地区筛选、全文检索、以及一条**简报条**（多少源就绪、多少条、相对上次刷新新增多少、耗时多少毫秒）。
设置页新增「官方源健康度与延迟」，逐源显示成功率、p50 / p95 延迟与最近错误。

模型侧三个工具：`ml_filings`（披露检索）、`ml_macro`（宏观与政策发布）、`ml_brief`（分类摘要 + 新增计数）。

## 公司档案（0.9.2 新增）

「公司」页：输入公司名、拼音或代码（`贵州茅台` / `600519` / `腾讯` / `AAPL`），聚合一个发行人的全部可得信息。
模型侧用 `ml_company`，参数与返回结构一致。

| 区块 | 来源 | 覆盖 |
| --- | --- | --- |
| 实体解析 | 东方财富 suggest | A 股 / 港股 / 美股；自动排除指数、板块、债券、权证、期权 |
| 行情 | 腾讯 qt | 价格、涨跌、PE、PB、总市值、换手、振幅、日内区间 |
| 财务指标 | 同花顺指标表 | 24 项 × 25 个报告期；面板展示最新两期 |
| 官方公告 | 巨潮 / 上交所 / 深交所 | A 股按 `code,orgId` 精确筛选（orgId 来自巨潮 6263 只全量映射，缓存 12h） |
| 美股公告 | SEC submissions | 按 ticker → CIK 取最近 filing |
| 卖方研报 | 东方财富研报 | 机构 / 评级 / 行业 / 当年 EPS 与 PE 预测 |
| 同行业可比 | 东财行业板块 | 行业标签 → 板块成分 → 按市值取同行，点击可切换查询 |

跨源去重：同一份公告同时出现在巨潮与交易所时按标题归一化去重。

实测：`贵州茅台` 冷查约 1.3–3.8 s（首次含行业板块表 6 页并行），二次查询约 0.1–0.5 s（行情 15 s 缓存、财务 6 h、orgId 表 12 h、板块表 1 h）。
返回里的 `legs` 会列出每条腿的条数与失败原因，例如港股公告会写「按股票代码筛选暂未接入」，而不是静默为空。

### 跨类均衡

「全部」视图先按类别轮转再切片，否则 6 个披露源会把首屏刷成公告墙。实测 400 条时的分布：
快讯 72 / 披露 71 / 宏观 71 / 资金流 71 / 研报 60 / 政策 35 / 制裁 18 / 波动率 2。

### 延迟设计

- **keep-alive 快路径**（`lib/net-fast.mjs`）：官方接口不需要反爬那套 UA 轮换与重试退避，走独立连接池（64 socket / 协议），复用 TLS，省掉每次握手。
- **SWR 缓存**：命中即返回，过期了也先回旧值再后台revalidate，面板不出现空白等待。
- **单飞**：同一个 key 的并发请求合并成一次，刷新按钮连点不会放大流量。
- **收集预算**：一次收集默认 4.5 秒预算，超时的源标记 `pending` 并继续在后台跑，慢源不会拖死整页。
- **启动预热**：插件加载 1.5 秒后预取热门源（巨潮/上交所/深交所/SEC/Fed/CFTC/Cboe），首次打开面板通常直接命中缓存。
- **按源节流**：每个适配器声明 `rateLimit.perMinute`，runner 按此排队，避免被官方接口封。

实测口径（2026-11-07，39 个源，本机）：

| 场景 | 实测 |
| --- | --- |
| 面板二次打开（全缓存命中） | **0–6 ms** |
| `ml_brief` 缓存命中 | **1 ms** |
| 冷启动全量收集（39 源，适配器并发 10，全局预算 6s） | **6.0 s**（长尾源标 pending，落地后自动补刷） |
| 冷启动后实时档就绪 | **6/6**（热源优先调度后） |
| 面板按档自动刷新间隔 | 视图最快档的 TTL：30 s（含实时源）→ 10 min（仅低频源） |
| 单源 p50 / p95 | 见设置页「官方源健康度与延迟」 |
| 披露层单源（巨潮 / 上交所） | 257–1013 ms |
| 期货层（国内 / 外盘） | 296–482 ms |
| 航运层（BDI / 海峡海况） | 403 ms / 1.4 s |
| 气候层（主产区天气 / NASA 事件） | 0.7–0.8 s / 2.6–6.9 s |
| 地缘层（联合国新闻） | 738 ms |
| 就绪率 | **32/39 有数据** |

未打通的 7 类（均为网络侧或凭证问题，非适配器缺陷，健康度页如实显示原因）：
FRED 需要 `FRED_API_KEY`；BLS 在本机被 IP 级 403；海关总署 WAF 间歇拦截；CFTC 官网 HTML 间歇超时；
预测市场四源（Polymarket / Kalshi / Manifold / Metaculus）在本机被网络层阻断（TCP 超时 / DNS 污染），Metaculus 另需 `METACULUS_TOKEN`；
GDELT DOC API 频繁限流（429），已退避 15 分钟。

## 组成
- Host: index.js（工具 ml_feed / ml_search / ml_read / ml_quotes + 面板路由 /market-info + 系统提示段）
- lib/quotes.mjs 行情与历史：TradingView scanner 批量 + 腾讯 + Yahoo + CoinGecko；
  Eastmoney kline / OKX candles / Yahoo chart 历史序列，含限速与 429 退避
- lib/net.mjs   反爬向抓取：persona 头/重试/退避/Cookie 罐/代理池/压缩解码/封锁识别/主机限速
- lib/feed.mjs  多源聚合 + 自动兜底
- lib/unwall.mjs 转载副本搜索/排序/正文抽取 + Google News 解析 + 阅读代理回退
- lib/store.mjs 纯文本缓存 + 收藏 + 设置（硬上限、LRU/TTL、antiBlock、watchlist、刷新频率）
- lib/routes.mjs /market-info 面板与 API（/api/quotes、/api/history、/api/collect、/api/brief、/api/sources、/api/source-stats、/api/net/test …）
- lib/net-fast.mjs keep-alive 快路径：连接池、gzip/br 解码、重定向、硬超时、并发限流
- lib/sources/index.mjs 源适配器 runner：SWR 缓存、单飞、收集预算、节流、健康度与延迟分位
- lib/sources/*.mjs 具体适配器（披露 / 宏观 / 政策 / 资金流 / 制裁 / 快讯 / 研报 / 行业），契约见 docs/SOURCE-CONTRACT.md
- lib/sources/market-flow.mjs 资金与结构：沪深港通 / 两融 / 龙虎榜 / 行业与概念板块
- lib/sources/futures.mjs 期货：国内五家交易所与外盘合约，按品种去重
- lib/sources/prediction.mjs 预测市场：Polymarket / Kalshi / Manifold / Metaculus
- lib/sources/shipping.mjs 航运：BDI 干散货指数 + 海峡浪高
- lib/sources/world.mjs 世界监测：联合国新闻 / GDELT 地缘事件 / NASA 自然事件 / 主产区天气
- lib/company.mjs 公司档案：实体解析 + 行情 + 财务指标 + 公告 + 研报 + 同行业，跨源去重与 leg 级失败说明
- client.js     侧边栏「市场资讯」+ main 槽位（内嵌 /market-info/ui）
- ui/           面板前端（原生 HTML/CSS/JS，无依赖，SVG 手绘走势图）

## 测试
    node test/plugin-smoke.mjs    # 11 项：Host/Client 接线 + 8 个工具真实调用（含 ml_company，需网络）
    node test/smoke.mjs           # 62 项：模块单测 + 真实网络 + HTTP 接口（阅读回归/行情/历史/快速刷新/抗封锁）
    node test/sources-smoke.mjs   # 19 项：源 runner 契约（缓存/单飞/超时/去重/预算/健康度），确定性无网络
    node test/source-probe.mjs    # 适配器真实网络探针：逐源打印条数/耗时/失败原因，或指定 id
    # 合计 92 项 + 探针
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


See [2026-11-08 hardening and validation](docs/HARDENING-20261108.md).

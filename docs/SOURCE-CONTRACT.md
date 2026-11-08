# 源适配器契约（lib/sources/）

这份文档是 `lib/sources/` 下各适配器文件必须遵守的接口。runner 在 `lib/sources/index.mjs`，不要修改它。

## 1. 文件与归属

| 文件 | 适配器 id |
| --- | --- |
| `cn-disclosure.mjs` | cninfo / sse / szse / hkex |
| `us-disclosure.mjs` | sec-fulltext / sec-xbrl |
| `global-macro.mjs` | fred / bls / fed / ecb / treasury / cfets |
| `cn-macro.mjs` | nbs / pbc / customs / safe |
| `flows.mjs` | cftc / cboe / ofac |

每个文件只改自己那一份。不要动 `index.mjs` / `all.mjs` / `net.mjs` / `net-fast.mjs` / `service.mjs` / `routes.mjs` / `tools.mjs` / `index.js` / `ui/*` / `package.json`。

## 2. 导出形状

```js
export const adapters = [ adapater1, adapter2, ... ]
```

## 3. adapter 对象

```js
{
  id: 'cninfo',                  // 唯一，小写短横线
  name: '巨潮资讯',               // 中文名，UI 直接显示
  category: 'filing',            // filing | macro | policy | flow | sanction | volatility
  region: 'CN',                  // CN | US | EU | JP | HK | GLOBAL
  tier: 'A',                     // A | A- | B（就绪度）
  capability: ['search', 'list'],// search 支持查询词；list 只出最新；series 出时间序列
  homepage: 'https://www.cninfo.com.cn',
  note: '一句话说明用途与限制',
  needsKey: false,               // 需要 API key 时 true
  keyEnv: '',                    // needsKey 时的环境变量名
  rateLimit: { perMinute: 30 },  // 必填，runner 会按此节流
  ttlMs: 1200000,                // 可选，缓存 TTL；默认按 category
  timeoutMs: 9000,               // 可选，单源超时
  async fetch(ctx, params) { ... return { items, meta } }
}
```

## 4. fetch 的输入输出

`params` 可能包含：`q`（查询词）、`from` / `to`（`YYYY-MM-DD`）、`limit`（数字）、`symbol`、`region`、`category`、`days`。**全部按可选处理，缺失时给默认值。**

返回：

```js
{
  items: [
    {
      id: '唯一字符串',            // 用官方公告 id / URL / 标题哈希，稳定可去重
      title: '标题',
      url: 'https://...',          // 必须有，UI 要能点开
      publishedAt: 1793980800000,  // 毫秒时间戳；拿不到就 null
      summary: '可选摘要',          // 会被截到 600 字
      tags: ['回购', '公告'],       // 可选
      payload: { ... }             // 可选，结构化字段（金额、代码、评级等）
    }
  ],
  meta: { total: 123, page: 1 }    // 可选
}
```

**必须遵守：**

1. `fetch` **不许抛异常**。内部用 try/catch，失败返回 `{ items: [], meta: { error: '...' } }`。
2. 单次返回 **最多 60 条**，`params.limit` 超过也截到 60。
3. `url` 必须是可直接打开的绝对地址。
4. 时间戳统一毫秒。字符串日期用 `Date.parse()`，拿不到就 `null`。
5. 不要引入新依赖，只用 `ctx.getJson` / `ctx.postJson` / `ctx.fetchJson` 和 Node 内置模块。
6. 不要抓付费墙正文；只取标题、链接、时间、公开的结构化字段。
7. 需要 API key 的源：从 `process.env[keyEnv]` 读，没有 key 时返回 `{ items: [], meta: { error: 'missing key' } }`，**不要**让插件崩。

## 5. ctx 提供的工具

```js
ctx.getJson(url, { headers, timeoutMs, referer, method, body })  // -> { ok, status, json, text, ms, error }
ctx.postJson(url, body, { headers, timeoutMs, referer })          // 同上
ctx.fetchJson(url, options)                                        // getJson 的别名
ctx.log(msg)                                                       // 会打到插件日志
ctx.signal                                                         // AbortSignal
```

`getJson` 永不抛异常，失败时 `ok:false` 且带 `error` 或 `status`。

## 6. 已实测的关键陷阱（照做）

- **上交所**：必须带 `referer: 'http://www.sse.com.cn/'`，否则拒绝。
- **巨潮**：POST `http://www.cninfo.com.cn/new/hisAnnouncement/query`，需要浏览器 UA；分页 `pageNum` / `pageSize`。全文检索 GET `http://www.cninfo.com.cn/new/fulltextSearch/full?searchkey=...` 也可用。
- **深交所**：`http://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=...`，返回 JSONP 风格需要剥壳（runner 的 `getJson` 已处理 JSONP 外壳）。
- **北交所 / 股转**：UA 校验，无 UA 403。
- **SEC 系**：必须自定义 UA 且带邮箱（`ctx.getJson(url, { headers: { 'user-agent': 'dsh-market-info/0.9 (contact@example.com)' } })`），限速 10 次/秒。
- **国家统计局 / 海关**：纯 HTTP 403/412，需要浏览器上下文。适配器先尝试 HTTP，失败时返回 `meta: { needsBrowser: true }`，不要卡死重试。
- **HKEXnews**：`https://www1.hkexnews.hk/search/titleSearchServlet.do` 非官方 JSON，可能变，注意兜底。
- 需要 key 的源（FRED / BLS 不需要 / EDINET）没 key 时按第 4 条第 7 点处理。

## 7. 自测

```bash
node test/source-probe.mjs <adapterId>     # 真实打网络，打印耗时/条数/前 3 条
node test/source-probe.mjs                 # 跑全部
```

适配器写完必须自己跑一遍并确认返回 > 0 条（网络不可达的源除外，要在 `note` 里写清楚）。

## 8. 代码风格

- ESM，2 空格缩进，单引号，无分号行尾不加。
- 每个适配器 40–90 行，超过 120 行说明该拆。
- 注释用英文，用户可见文案用中文。

# Changelog

All notable changes to `dsh-market-info` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.8.0] — 2026-11-07

### Renamed

- 插件从旧名 `dsh-market-lens` 更名为 `dsh-market-info`（市场资讯）：包名、仓库名、
  `export const name`、系统提示段、日志前缀、Client 模块 id、面板 key 与侧边栏标题全部同步。
- 仓库迁移到 <https://github.com/YansongG-HKU/dsh-market-info>。

### Changed

- 面板路由前缀 `/market-lens` → `/market-info`（UI 与 API 一同变化）。
- API gate 头 `x-market-lens` → `x-market-info`。
- 默认数据目录 `~/.dsh-market-lens` / `%LOCALAPPDATA%\dsh-market-lens` → `~/.dsh-market-info` / `%LOCALAPPDATA%\dsh-market-info`。
- 数据源导出格式标识 `market-lens-feeds` → `market-info-feeds`；导出文件名同步。
- README 安装说明去掉本机绝对路径，改为通用示例。

### Added

- `.gitignore`、`LICENSE`（MIT）、本 CHANGELOG 条目与仓库元数据（repository / homepage / bugs）。

### Unchanged

- 模型侧工具名 `ml_feed` / `ml_search` / `ml_read` / `ml_quotes` 及其参数、返回结构完全不变。

## [0.7.3] — 2026-11-06

### Changed

- Declared `engines.dsh: ">=0.2.2-rc.1"`.

### Verified

- Client half only depends on the `slots` service, which 0.2.2 serves from `dsh-client-ui-renderer` with a byte-identical slot contract; host tools / system prompt / web server routes unchanged.

# Easy Conda

一个跨平台的桌面端 Conda 环境管理器，基于 **Tauri 2 + React + Rust** 构建。支持同时管理本机 Windows 与 WSL 内的 Conda 环境：扫描实例、管理环境与依赖、安装/卸载/升级包、渠道管理、导入导出、离线交付、诊断与缓存清理。

## ✨ 功能特性

- **多目标实例**：自动探测本机 Conda / Miniforge / Mamba / micromamba，并支持直接管理 WSL 发行版内的 Conda 环境（Windows 与 WSL 一键切换）
- **环境管理**：列出环境、查看详情（Python 版本、包数量、磁盘占用）、创建 / 删除 / 克隆环境
- **激活与终端**：一键激活环境并打开对应终端（Windows 用 PowerShell，WSL 用 bash），已激活环境带「已激活」标记
- **库依赖管理**：查看已安装包、搜索新包；安装 / 卸载 / 升级前先执行 dry-run 求解预览，展示增删包与下载体积，确认后执行
- **下载源（渠道）**：查看、添加、移除渠道，内置清华镜像等国内源快捷添加，支持连通性测试
- **导入 / 导出**：导出 `environment.yml` 或 `explicit spec`，从 YAML 导入环境
- **离线交付**：离线包仓库、pip wheelhouse、conda-pack 三种导出
- **操作日志**：所有操作生成可追溯记录，实时展示状态、阶段与脱敏日志，运行中的操作可取消
- **诊断与缓存**：生成脱敏诊断报告；清理下载包 / 缓存包并显示释放空间
- **外观**：明亮 / 暗色主题切换、响应式布局、中文本地化

## 安装

前往 [Releases](https://github.com/MWang-TS/easy-conda/releases) 下载对应平台的安装包：

| 平台 | 安装包 |
|------|--------|
| Windows | `.exe`（NSIS 安装程序） |
| macOS | `.dmg`（Apple Silicon / Intel） |
| Linux | `.deb` / `.AppImage` |

> 使用前请确保本机已安装 Conda（或 Miniforge / Mamba / micromamba）；管理 WSL 环境需在 WSL 发行版内安装 Conda。

## 开发环境

- Windows 10/11、macOS 或 Linux
- Node.js 20+ 和 npm
- Rust stable（Windows 使用 MSVC toolchain）
- WebView2 Runtime（Windows，通常已内置）
- Conda、Miniforge、Mamba 或 micromamba（用于真实数据）

## 启动 Web 预览

```powershell
npm install
npm run dev
```

预览数据仅用于界面开发，不会修改本机 Conda 环境。

## 启动 Tauri 桌面端

```powershell
npm install
npm run tauri dev
```

## 构建与测试

```powershell
npm run build        # 前端构建 + 类型检查
npm test             # Vitest 单元测试
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build  # 打包当前平台安装包
```

## 技术说明

- 所有写操作经 Rust 层校验，并以参数数组方式执行（不经 shell 拼接），日志脱敏
- 异步任务系统：流式输出、事件推送、per-prefix 锁、取消与持久化
- 支持本机 Windows 与 WSL 双运行目标（`wsl:` 前缀区分，路径经 `\\wsl$\` UNC 映射）

产品/工程规格见 [PRD](doc/PRD.md)、[开发文档](doc/DEVELOPMENT.md) 和 [设计方案](doc/DESIGN.md)。

## License

[MIT](LICENSE)

# Easy Conda

Windows 桌面端 Conda 环境管理器。当前开发版本支持扫描本机 Conda 实例、列出环境并查看包清单；浏览器预览使用演示数据，桌面端调用本机 CLI。

## 开发环境

- Windows 10/11 x64
- Node.js 20+ 和 npm
- Rust stable（MSVC toolchain）
- Visual Studio Build Tools 的 C++ build tools
- WebView2 Runtime
- Conda、Miniforge、Mamba 或 micromamba（用于桌面端真实数据）

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
npm run build
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

首版当前可用功能：实例探测、环境列表、包列表。新建环境向导目前是界面原型，不会执行创建；删除接口刻意 fail closed，不会删除环境。不得将此开发版本用于生产环境修改 Conda。

产品/工程规格见 [PRD](PRD.md)、[开发文档](DEVELOPMENT.md) 和 [设计方案](DESIGN.md)。

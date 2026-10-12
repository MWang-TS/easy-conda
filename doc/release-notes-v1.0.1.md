# Easy Conda v1.0.1

本次为问题修复版本，重点解决 Windows 端的启动与安装体验问题。

## 🐛 修复

### 启动时反复弹出终端窗口
从 v1.0.0 起，程序启动过程中（尤其是管理 WSL 环境时）会连续弹出多个终端窗口；点击「环境管理」中的某个环境也会弹出终端窗口。

**原因**：应用是 GUI 程序（无自带控制台），但探测 Conda 实例时会调用 `conda.exe` / `wsl.exe`，加载环境包列表时会调用 `conda list`。Windows 会为每个控制台子进程新开一个窗口。

**修复**：为所有后台隐藏子进程添加 `CREATE_NO_WINDOW` 标志。仅「激活环境并打开终端」按钮仍按预期弹出终端窗口。

### 首次启动长时间白屏（约 10 秒）
**原因**：样式表通过 `@import` 加载 Google Fonts，该方式**同步阻塞首屏渲染**；在网络受限环境下访问 `fonts.googleapis.com` 极慢，导致窗口空白。

**修复**：移除远程字体依赖，改用系统字体栈（`Segoe UI` / `Microsoft YaHei` / `system-ui`），首屏即时渲染。

### Windows 安装报错：Error opening file for writing
覆盖安装时若旧版本仍在运行，安装程序无法覆盖 `easy-conda.exe`，弹出：

```
Error opening file for writing:
C:\Users\<user>\AppData\Local\Easy Conda\easy-conda.exe
```

**修复**：新增 NSIS 安装钩子，安装/卸载前强制结束残留实例并等待文件句柄释放，然后再写入文件。

## ✨ 改进

- 安装程序新增**简体中文**界面
- 后台任务统一在无窗口模式下执行，任务中心日志不受影响

## 📦 下载

| 平台 | 安装包 |
|------|--------|
| Windows | `Easy.Conda_1.0.1_x64-setup.exe` |
| macOS (Apple Silicon) | `Easy.Conda_1.0.1_aarch64.dmg` |
| macOS (Intel) | `Easy.Conda_1.0.1_x64.dmg` |
| Linux (Debian/Ubuntu) | `Easy.Conda_1.0.1_amd64.deb` |
| Linux (通用) | `Easy.Conda_1.0.1_amd64.AppImage` |

> ⚠️ **Windows 用户请注意**：若安装时仍提示文件被占用，请先完全退出 Easy Conda（任务管理器确认无 `easy-conda.exe`），并将 `%LOCALAPPDATA%\Easy Conda` 加入杀毒/安全软件的信任区（部分 HIPS 软件会锁定可执行文件）。

## 📝 变更列表

- `fix(windows)`: 安装/卸载前强制结束运行中的实例，避免文件覆盖失败
- `fix`: 移除阻塞首屏渲染的 Google Fonts，改用系统字体
- `fix`: 后台子进程使用 `CREATE_NO_WINDOW`，不再弹出终端窗口
- `chore`: 版本号更新至 1.0.1

---

**完整对比**：[`v1.0.0...v1.0.1`](https://github.com/MWang-TS/easy-conda/compare/v1.0.0...v1.0.1)

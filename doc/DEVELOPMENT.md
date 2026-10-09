# Easy Conda 开发文档

- 文档状态：工程实现基线
- 版本：1.0
- 日期：2026-10-08
- 目标：Windows 10/11 x64
- 关联文档：[PRD](PRD.md)、[设计方案](DESIGN.md)

## 1. 技术基线

| 层 | 建议基线 | 责任 |
|---|---|---|
| Desktop | Tauri 2、Rust stable | 窗口、权限、命令桥接、发布 |
| UI | TypeScript、React、Vite | 页面、表单、表格、任务状态 |
| Persistence | SQLite（Rust 侧） | 设置、实例登记、任务与日志元数据 |
| Conda backend | conda / mamba / micromamba CLI | 环境与包查询、solver、变更执行 |
| Packaging | Windows 签名安装器（MSIX 或 NSIS） | 安装、升级、卸载 |

具体依赖版本由项目初始化时锁定在 Cargo.lock 与前端 lockfile，并在升级 PR 中验证。MVP 不安装/链接自制 solver，不要求用户安装 Node/Rust。

## 2. 系统边界

```text
React UI
  | invoke typed commands / listen events
Tauri command layer (DTO validation, authorization boundary)
  | application services
Discovery / Environment / Package / Channel / Archive / Diagnostics
  | typed operation request
Job manager (queue, per-prefix locks, cancellation, persistence)
  | process adapter
Conda CLI adapters (conda, mamba, micromamba)
  | JSON/stdout/stderr + exit code
Local Conda installation and filesystem
```

原则：
- UI 不直接调用文件系统/进程插件；高风险操作仅由 Rust commands 完成。
- 所有外部进程均直接启动 executable 并传参，不经 `cmd.exe /c` 或 PowerShell 拼接。
- 进程 executable、根前缀、命令能力来自已验证的实例记录；不接受前端传入任意 executable 路径执行。
- 依赖求解交给后端 CLI；UI 中的预览必须来源于真实 dry-run 结果。不可 dry-run 的命令不得生成模拟计划。
- 读取状态是 Conda CLI 的权威结果；SQLite 只记录历史和偏好，不作为环境当前状态的缓存真相。

## 3. 建议仓库结构

```text
src/
  app/                 # 路由、全局布局、全局状态
  features/
    onboarding/        # 安装发现与首次引导
    environments/      # 环境列表、详情、创建/删除
    packages/          # 包清单与后续变更
    jobs/              # 任务中心、日志查看
    settings/          # 渠道、常规设置、诊断
  components/          # 通用 UI 组件
  lib/                 # invoke/event 封装、校验、格式化
  types/               # Rust DTO 对应前端类型
src-tauri/
  src/
    main.rs
    lib.rs
    commands/           # 只做 DTO 校验与服务调用
    domain/             # 环境、包、任务、渠道类型与规则
    services/           # 用例编排
    conda/
      discovery.rs
      adapter.rs
      conda.rs
      mamba.rs
      micromamba.rs
      json.rs
    jobs/               # 生命周期、事件、持久化、锁
    archive/            # YAML、explicit、离线包、wheelhouse（阶段化）
    storage/            # SQLite migrations/repository
    security/           # 路径校验、脱敏
    diagnostics/
    error.rs
  capabilities/
  migrations/
```

目录可随 Tauri 模板微调，但命令入口、业务服务和 CLI 适配层必须保持分离。

## 4. Rust 数据契约（首版）

以下为逻辑字段基线。JSON 字段统一 camelCase；所有 ID 使用 UUID；路径在 DTO 中按字符串序列化、Rust 内部使用 `PathBuf`。

### 4.1 实例与环境

```ts
interface CondaInstance {
  id: string;
  executablePath: string;
  kind: "conda" | "mamba" | "micromamba";
  version: string;
  rootPrefix: string;
  platform: string;
  capabilities: string[];
  isDefault: boolean;
}

interface EnvironmentSummary {
  instanceId: string;
  name: string | null;
  prefix: string;
  isBase: boolean;
  pythonVersion: string | null;
  packageCount: number | null;
  platform: string | null;
  status: "ready" | "unavailable";
}

interface PackageRecord {
  name: string;
  version: string;
  build: string | null;
  channel: string | null;
  packageType: "conda" | "pip" | "unknown";
  source: string | null;
}
```

不要以环境名作为唯一标识；实例 ID + 规范化 prefix 才构成环境键。

### 4.2 创建输入与计划

```ts
interface CreateEnvironmentRequest {
  instanceId: string;
  name?: string;
  prefix?: string;
  pythonVersion?: string;
  packages: string[];
  channels: string[];
  channelPriority?: "strict" | "flexible" | "disabled";
  useCurrentConfig: boolean;
}

interface OperationPlan {
  supported: boolean;
  commandSummary: string[]; // 已脱敏、供用户审阅，不含可执行 shell 字符串
  changes: Array<{
    action: "install" | "remove" | "update" | "downgrade" | "unknown";
    name: string;
    fromVersion?: string;
    toVersion?: string;
    packageType?: "conda" | "pip" | "unknown";
  }>;
  warnings: string[];
  downloadBytes?: number;
}
```

输入校验必须在 Rust 服务层完成。依赖规格应按 CLI 的位置参数或明确参数规则构造，不允许把用户字符串解释为 CLI flags；对包规格中的特殊前缀/格式采用 allowlist 与明确 parser。

### 4.3 任务

```ts
interface JobSnapshot {
  id: string;
  kind: "discover" | "create_environment" | "delete_environment" | "export" | "import";
  status:
    | "queued" | "running" | "cancel_requested" | "succeeded"
    | "failed" | "cancelled" | "interrupted";
  progress?: { stage: string; current?: number; total?: number };
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  environmentPrefix?: string;
  error?: { code: string; summary: string; detail?: string };
  lastSequence: number;
}

interface JobEvent {
  jobId: string;
  sequence: number;
  timestamp: string;
  type: "status" | "progress" | "stdout" | "stderr" | "warning";
  payload: unknown;
}
```

原始日志可能包含私有 URL 或 token；持久化及向 UI 推送前先脱敏。若需导出原始日志，应提供高敏提示，并默认仍脱敏。

## 5. Tauri command API

命名可依项目规范调整，但语义须保持一致。commands 必须短小，只做参数检查、调用 service、返回 DTO。

| Command | 输入 | 返回 | 说明 |
|---|---|---|---|
| `discover_conda_instances` | 无 | `CondaInstance[]` | 扫描并更新发现记录 |
| `list_conda_instances` | 无 | `CondaInstance[]` | 返回已登记实例 |
| `set_default_conda_instance` | `instanceId` | `CondaInstance` | 仅选择已验证实例 |
| `list_environments` | `instanceId` | `EnvironmentSummary[]` | 通过 CLI 刷新 |
| `list_packages` | `instanceId, prefix` | `PackageRecord[]` | 查询包 JSON |
| `plan_create_environment` | `CreateEnvironmentRequest` | `OperationPlan` | 只读 dry-run；不支持则返回 supported=false |
| `start_create_environment` | `CreateEnvironmentRequest, confirmedPlanHash?` | `JobSnapshot` | 校验并提交异步任务 |
| `start_delete_environment` | `instanceId, prefix, typedName?` | `JobSnapshot` | Rust 再校验 base 与目标身份 |
| `export_environment_yaml` | `instanceId, prefix, destination, mode` | `JobSnapshot` | destination 由文件选择器取得并二次验证 |
| `import_environment_yaml` | `instanceId, source, targetName?` | `JobSnapshot` | 先解析/校验，再 dry-run/执行 |
| `get_job` | `jobId` | `JobSnapshot` | 事件丢失后的状态恢复 |
| `list_jobs` | `limit, cursor?` | `JobSnapshot[]` | 分页历史 |
| `cancel_job` | `jobId` | `JobSnapshot` | 发取消请求，不承诺立即终止 |
| `get_diagnostics` | 无 | `DiagnosticsReport` | 敏感字段脱敏 |

命令返回结构统一为序列化的 `Result<T, AppError>`。错误 code 稳定、summary 本地化由 UI 映射；detail 可作为技术信息折叠展示，不能把 stderr 原文直接渲染为 HTML。

## 6. 进程适配规范

### 6.1 Adapter 职责
每类后端实现统一 trait（概念示例）：

```rust
trait CondaAdapter {
    fn probe(&self, executable: &Path) -> Result<InstanceCapabilities, AppError>;
    fn list_envs(&self, instance: &CondaInstance) -> Result<Vec<EnvironmentSummary>, AppError>;
    fn list_packages(&self, instance: &CondaInstance, prefix: &Path) -> Result<Vec<PackageRecord>, AppError>;
    fn plan_create(&self, request: &CreateEnvironmentRequest) -> Result<Option<OperationPlan>, AppError>;
    fn create(&self, request: &CreateEnvironmentRequest, control: JobControl) -> Result<(), AppError>;
}
```

实际阻塞进程须运行在任务 worker，不阻塞 Tauri 主线程或 Tokio async executor。可使用 dedicated blocking worker/thread，由任务管理器采集输出。

### 6.2 参数和环境
- 用 `std::process::Command` /受控异步进程库设置 executable 与逐项 args。
- 固定安全环境变量和工作目录；避免继承会改变行为的未审查变量，兼容性需要的变量需列明。
- `--json` 仅在探测到支持的命令上添加；分别解析 stdout JSON、stderr、exit code。
- 不将 stdout 完整内容当进度；解析已知 JSON/结构化事件，未知输出作为日志文本。
- Windows 路径使用 `Path` API；避免手工拼接反斜杠。允许空格、Unicode 路径。
- 限制输出速率/大小，防止内存无限增长；日志可分块写入应用数据目录。

### 6.3 能力探测
探测并记录命令、JSON、dry-run、取消等能力。以 capability gate 控制功能；不能因版本字符串猜测功能可用。每个 adapter 有真实 CLI 集成测试。

### 6.4 进度与取消
- 取消信号先传给任务控制器，再按该后端的已验证行为终止子进程。
- 强杀子进程可能留下部分环境；取消后重新查询目标 prefix，并将结果标为取消/中断待检查，不报告成功。
- 操作过程分解为 resolving、downloading、linking、finalizing 等阶段仅在可靠来源可判定时显示；否则用“正在执行 Conda 操作”。

## 7. 任务并发、事件与恢复

- 每个 `(instanceId, normalizedPrefix)` 使用写锁；创建任务在 prefix 未存在时对目标 prefix 加锁。
- 同一实例的只读查询可并行；对 Conda 全局配置/缓存的写操作串行化。
- Job manager 持有任务状态机，数据库事务记录状态转换；终态不可回到运行态。
- `job_event` 序号对每个 job 单调递增。启动/恢复时 UI 可先监听事件，再调用 `get_job`，用 sequence 去重。
- 事件是增量展示，数据库 snapshot 是恢复依据。日志历史分页读取，不将全部日志灌入前端状态。
- 应用重启发现 queued/running/cancel_requested 任务时设为 interrupted，并尝试检查关联环境状态；不自动重放变更命令。

## 8. SQLite 数据模型

建议开启 foreign keys、WAL，并为 schema migration 编号。数据库位于 Tauri app data 目录。

```sql
CREATE TABLE conda_instances (
  id TEXT PRIMARY KEY,
  executable_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  version TEXT NOT NULL,
  root_prefix TEXT NOT NULL,
  platform TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  instance_id TEXT,
  environment_prefix TEXT,
  request_json TEXT NOT NULL,
  result_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(instance_id) REFERENCES conda_instances(id)
);

CREATE TABLE job_logs (
  job_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  stream TEXT NOT NULL,
  message TEXT NOT NULL,
  PRIMARY KEY(job_id, sequence),
  FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE channel_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  channels_json TEXT NOT NULL,
  priority TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

禁止将凭据写入 `channel_profiles` 或 `jobs.request_json`。凭据单独走系统凭据库；数据库定期清理策略为可配置，保留最近任务及对应日志。

## 9. 安全细则

### 9.1 前端到 Rust 边界
- 所有字符串长度、枚举、数组数量、文件大小和路径均有限制并在 Rust 复验。
- 前端不可提交任意 shell command、任意 executable、任意环境变量字典。
- Tauri capabilities 只授权本应用必要的 command/event/window 权限；不暴露通用 shell 插件。

### 9.2 路径安全
- 对 prefix 规范化、解析符号链接/Windows reparse points（按可行性）并与实例 root prefix 比较。
- 禁止删除 root prefix/base；禁止目标目录为盘符根目录、用户目录、应用目录或不满足 Conda 环境身份检查的路径。
- 创建前校验父目录和目标冲突；自定义 prefix 不可用简单字符串前缀比较做包含判断。
- 删除操作先展示最终解析路径，执行前在 Rust 服务端再次查询环境归属。

### 9.3 凭据与日志
- 对 URL userinfo、token 参数、代理认证、常见 token 环境变量作统一脱敏。
- 错误、stderr、diagnostics 和命令摘要走相同脱敏层。
- 路径可能含个人用户名；诊断导出前预览并允许替换/移除路径。

## 10. 导入导出实现策略

### MVP YAML
- 用 YAML parser 解析为受限 DTO；拒绝未知危险字段/过大文件；保留用户可识别的 channels 与 dependencies。
- 导入前展示目标名冲突与 solver 计划；绝不直接执行 YAML 中任意脚本或本地可执行路径。
- 导出到临时文件、flush/sync 后原子 rename；目标覆盖需明确确认。

### P1 explicit spec
- 保存来源平台、实例版本、生成时间、原始 explicit URL 清单。
- 绝对 URL 可能包含私有仓库信息；UI 警告并在分享模式中提供脱敏副本。

### P2 offline channel
- 先解析目标 spec，再收集所有精确包 artifact；核验目标平台、依赖闭包、文件 hash 和体积。
- 包文件 + repodata/channel 元数据 + explicit spec + manifest 一起归档；本机无网回放集成测试。
- 下载 URL 有鉴权时使用凭据库读取；日志和 manifest 默认不得导出凭据。

### P2 wheelhouse
- 明确从环境导出 pip 管理包，再调用 pip 下载兼容目标的 wheels。
- 无 wheel 的源码包按构建需求标注，不能承诺目标机离线可安装。
- 与 Conda 包分开归档/展示；不能作为 Conda 离线完整性替代。

## 11. 前端实现约定

- 每个 feature 管理自己的 query 状态、加载/空/错误态；跨页共享选中实例和 job store。
- invoke/event 封装集中在 `src/lib/tauri.ts`；feature 组件不散落原始 command 字符串。
- 事件订阅注册后在组件卸载时清理；按 job ID 和 sequence 去重。
- 提交 mutation 后以 CLI 查询刷新真实状态，不只依赖乐观更新。
- 所有危险操作使用统一确认组件，内容显示目标路径；键盘焦点返回触发控件。
- 日志按行追加、虚拟化或分页；敏感字符串在 Rust 层先脱敏。

建议 UI 状态模型：
- Environment query key: `instanceId`。
- Package query key: `instanceId + normalizedPrefix`。
- Job store key: `jobId`；snapshot 与 event reducer 合并时按 sequence 防止回退。
- Mutations 根据目标 prefix 维护 pending lock 展示，后端仍是最终并发校验方。

## 12. 测试策略

### Rust 单元测试
- 参数构造不会将用户输入扩展成 flags；特殊字符、空格、中文路径。
- JSON parser 针对不同 Conda 版本样本、null/missing fields 和 malformed JSON。
- base/root prefix 删除保护、路径规范化、同名多 prefix 区分。
- 脱敏覆盖 URL userinfo/token/query/代理密码及错误日志。
- Job 状态转换、事件序号、取消竞态和重启恢复。

### CLI 集成测试
CI 使用固定可下载/预装的受支持 Conda 版本，测试真实：发现、列表、创建、包查询、删除保护、YAML 导出导入。测试环境隔离于 runner 现有用户环境；失败保留脱敏日志和 CLI 版本。

### 前端测试
- 表单校验、空/错误/加载状态、任务 reducer sequence 去重。
- UI 自动化：首次发现、创建成功/solver 失败、日志查看、取消、base 删除被拒绝、YAML 往返。
- 使用 mock 的测试不替代至少一条真实 Conda 端到端流水线。

### 发布测试
- Windows 10/11 干净虚拟机：无 Conda、单实例、多实例。
- 安装升级卸载、路径含空格/中文、代理/离线启动、非管理员权限。
- Code signing、自动更新/回滚、SQLite migration 与损坏恢复。

## 13. CI 与交付流程

建议流水线顺序：
1. 格式与静态检查：`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、前端 lint/typecheck。
2. 单元与组件测试。
3. Windows x64 CLI 集成测试（分 Conda backend 矩阵）。
4. Tauri production build 与安装器 smoke test。
5. 签名发布、生成 SHA-256 与依赖许可证清单、发布 notes。

确切命令以生成的 package scripts 与 Tauri 配置为准；初始仓库搭建时需补充 `package.json` scripts、CI workflow 和版本支持表。

## 14. 实施拆分与完成定义

### Epic A：桌面骨架与发现
- 初始化 Tauri 2 + React/TypeScript。
- 建立 Rust DTO/error/command 边界及 capability 最小权限。
- 发现 PATH/常见安装、probe 版本与 JSON 能力、多实例选择。
- DoD：无 Conda/单实例/多实例三类发现流程通过 Windows 测试。

### Epic B：环境浏览
- 环境列表、详情、包查询、刷新与错误状态。
- DoD：与 CLI 输出核对；同名不同路径可区分；真实 CLI 集成测试通过。

### Epic C：任务基础设施
- SQLite migrations、job manager、事件序号、日志脱敏、取消/中断。
- DoD：UI 事件丢失后 snapshot 可恢复；进程退出不误报成功；并发锁测试通过。

### Epic D：创建/删除环境
- 创建向导、输入 parser、dry-run capability、确认执行、base 防护。
- DoD：支持后端上的 dry-run 预览与执行一致；不支持时无伪预览；base 删除单测及集成测试通过。

### Epic E：YAML 导入导出
- parser、预览、原子文件写入、round-trip 测试。
- DoD：有效/无效/恶意/过大 YAML 均有确定行为；文案准确说明非离线归档。

### Epic F：维护与离线能力
- 包 CRUD/渠道管理（P1），explicit spec/离线 Conda channel/wheelhouse/conda-pack（P2）。
- 每种导出格式有独立 manifest、兼容性说明和无网集成验收；不将其混为“导出 wheel”。

## 15. 未决技术决策（开工前确认并记录 ADR）

1. Conda 支持矩阵的最低/最高版本及 mamba/micromamba 版本范围。
2. 前端组件库、路由、query/state 管理选择。
3. 异步进程库及 SQLite crate 选型；与 Tauri async runtime 的边界。
4. Conda dry-run 在目标矩阵中的实际支持命令及 JSON schema。
5. 安装器选择（MSIX/NSIS）、签名和自动更新服务。
6. 是否首版包含 Miniforge 下载引导的自动下载校验，或只提供官方安装页面链接。
7. 私有渠道凭据是否首版支持，以及凭据库的使用体验与企业代理需求。

未决项不得阻塞无依赖的界面/协议原型；但 dry-run、删除安全、CLI 兼容性和发布签名须在对应 Epic 实现前定案。

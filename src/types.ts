export interface CondaInstance {
  id: string;
  /** 运行目标：`windows` 或 `wsl:<distro>` */
  runtime: string;
  executablePath: string;
  kind: 'conda' | 'mamba' | 'micromamba';
  version: string;
  rootPrefix: string;
  platform: string;
  isDefault: boolean;
}

export interface EnvironmentSummary {
  instanceId: string;
  name: string | null;
  prefix: string;
  isBase: boolean;
  /** 是否为当前激活的环境 */
  isActive: boolean;
  pythonVersion: string | null;
  packageCount: number | null;
  platform: string | null;
  sizeBytes: number | null;
}

export interface PackageRecord {
  name: string;
  version: string;
  build: string | null;
  channel: string | null;
  packageType: 'conda' | 'pip' | 'unknown';
}

export interface CreateEnvironmentRequest {
  name: string;
  pythonVersion: string | null;
  packages: string[];
  channels: string[];
}

export interface SearchResult {
  name: string;
  version: string;
  channel: string;
}

export type JobStatus =
  | 'queued'
  | 'running'
  | 'cancel_requested'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface JobSnapshot {
  id: number;
  kind: string;
  target: string;
  status: JobStatus | string;
  summary: string;
  error: string | null;
  environmentPrefix: string | null;
  stage: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  log: string[];
}

export interface JobEvent {
  id: number;
  kind: string;
  target: string;
  status: string;
  summary: string;
  error: string | null;
  environmentPrefix: string | null;
  stage: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  logLine: string | null;
}

export interface PlanChange {
  action: string;
  name: string;
  fromVersion: string | null;
  toVersion: string | null;
  channel: string | null;
}

export interface PlanDownload {
  name: string;
  version: string | null;
  channel: string | null;
  size: number | null;
}

export interface OperationPlan {
  supported: boolean;
  command: string | null;
  changes: PlanChange[];
  downloads: PlanDownload[];
  warnings: string[];
  fetchBytes: number | null;
}

export interface YamlPreview {
  parsed: boolean;
  name: string | null;
  channels: string[];
  dependencies: string[];
  error: string | null;
}

export interface DiagnosticSection {
  title: string;
  content: string;
}

export interface DiagnosticReport {
  generatedAt: number;
  redacted: boolean;
  sections: DiagnosticSection[];
}

export interface InstallSource {
  id: string;
  label: string;
  downloadUrl: string;
  recommended: boolean;
}

export interface InstallInfo {
  name: string;
  version: string;
  arch: string;
  filename: string;
  license: string;
  description: string;
  sources: InstallSource[];
}

export interface ChannelInfo {
  channels: string[];
}

export interface ChannelTestResult {
  channel: string;
  target: string;
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;
}

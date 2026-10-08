export interface CondaInstance {
  id: string;
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

export interface OperationRecord {
  id: number;
  kind: string;
  target: string;
  status: 'running' | 'succeeded' | 'failed';
  summary: string;
  startedAt: number;
  finishedAt: number | null;
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

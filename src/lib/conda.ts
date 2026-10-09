import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import type {
  ChannelInfo,
  ChannelTestResult,
  CondaInstance,
  CreateEnvironmentRequest,
  DiagnosticReport,
  EnvironmentSummary,
  InstallInfo,
  JobEvent,
  JobSnapshot,
  OperationPlan,
  PackageRecord,
  SearchResult,
  YamlPreview,
} from '../types';

const demoInstance: CondaInstance = {
  id: 'demo-conda',
  runtime: 'windows',
  executablePath: 'C:\\Tools\\Miniforge3\\Scripts\\conda.exe',
  kind: 'conda',
  version: '24.9.2',
  rootPrefix: 'C:\\Tools\\Miniforge3',
  platform: 'win-64',
  isDefault: true,
};

const demoEnvironments: EnvironmentSummary[] = [
  { instanceId: demoInstance.id, name: 'base', prefix: demoInstance.rootPrefix, isBase: true, isActive: true, pythonVersion: '3.12.7', packageCount: 142, platform: 'win-64', sizeBytes: 8420081664 },
  { instanceId: demoInstance.id, name: 'vision-lab', prefix: 'D:\\Work\\conda_envs\\vision-lab', isBase: false, isActive: false, pythonVersion: '3.11.9', packageCount: 86, platform: 'win-64', sizeBytes: 3985000000 },
  { instanceId: demoInstance.id, name: 'data-tools', prefix: 'D:\\Work\\conda_envs\\data-tools', isBase: false, isActive: false, pythonVersion: '3.10.14', packageCount: 37, platform: 'win-64', sizeBytes: 1536000000 },
  { instanceId: demoInstance.id, name: 'py312-clean', prefix: 'C:\\Users\\dev\\.conda\\envs\\py312-clean', isBase: false, isActive: false, pythonVersion: '3.12.5', packageCount: 8, platform: 'win-64', sizeBytes: 214000000 },
];

const demoPackages: PackageRecord[] = [
  { name: 'python', version: '3.11.9', build: 'h966fe2a_0', channel: 'conda-forge', packageType: 'conda' },
  { name: 'pip', version: '24.2', build: 'pyh8b19718_1', channel: 'conda-forge', packageType: 'conda' },
  { name: 'numpy', version: '1.26.4', build: 'py311h0b4df5a_0', channel: 'conda-forge', packageType: 'conda' },
  { name: 'pandas', version: '2.2.3', build: 'py311hcf9f919_1', channel: 'conda-forge', packageType: 'conda' },
  { name: 'pytorch', version: '2.4.1', build: 'py3.11_cuda12.1_cudnn9_0', channel: 'pytorch', packageType: 'conda' },
  { name: 'opencv-python', version: '4.10.0.84', build: null, channel: 'pypi', packageType: 'pip' },
  { name: 'pillow', version: '10.4.0', build: 'py311h827c3e9_0', channel: 'conda-forge', packageType: 'conda' },
];

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

let demoJobId = 0;
function demoJob(kind: string, target: string, status: string, summary: string): JobSnapshot {
  demoJobId += 1;
  return {
    id: demoJobId,
    kind,
    target,
    status,
    summary,
    error: null,
    environmentPrefix: null,
    stage: null,
    createdAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: status === 'succeeded' || status === 'failed' ? Date.now() : null,
    log: [],
  };
}

function demoPlan(packages: string[]): OperationPlan {
  return {
    supported: true,
    command: null,
    changes: packages.map((name) => ({ action: 'install', name, fromVersion: null, toVersion: '1.0.0', channel: 'conda-forge' })),
    downloads: packages.map((name) => ({ name, version: '1.0.0', channel: 'conda-forge', size: 1024 * 512 })),
    warnings: [],
    fetchBytes: packages.length * 1024 * 512,
  };
}

// ---------- 实例 ----------

export async function listInstances(): Promise<CondaInstance[]> {
  if (isTauri()) return invoke('list_conda_instances');
  await delay(350);
  return [demoInstance];
}

export async function rediscover(): Promise<CondaInstance[]> {
  if (isTauri()) return invoke('discover_conda_instances');
  await delay(650);
  return [demoInstance];
}

export async function setDefaultInstance(instanceId: string): Promise<CondaInstance> {
  if (isTauri()) return invoke('set_default_conda_instance', { instanceId });
  await delay(100);
  return { ...demoInstance, id: instanceId };
}

// ---------- 环境 ----------

export async function listEnvironments(instanceId: string, force = false): Promise<EnvironmentSummary[]> {
  if (isTauri()) return invoke('list_environments', { instanceId, force });
  await delay(300);
  return demoEnvironments;
}

export async function activateEnvironment(instanceId: string, prefix: string): Promise<EnvironmentSummary[]> {
  if (isTauri()) return invoke('activate_environment', { instanceId, prefix });
  await delay(200);
  return demoEnvironments.map((env) => ({ ...env, isActive: env.prefix === prefix && !env.isBase }));
}

export async function listPackages(instanceId: string, prefix: string): Promise<PackageRecord[]> {
  if (isTauri()) return invoke('list_packages', { instanceId, prefix });
  await delay(220);
  if (prefix === demoInstance.rootPrefix) return demoPackages.slice(0, 5);
  return demoPackages;
}

export async function listJobs(): Promise<JobSnapshot[]> {
  if (isTauri()) return invoke('list_jobs');
  await delay(200);
  return [];
}

export async function cancelJob(jobId: number): Promise<void> {
  if (isTauri()) return invoke('cancel_job', { jobId });
  await delay(100);
}

export function onJobEvent(callback: (event: JobEvent) => void): Promise<UnlistenFn> {
  if (!isTauri()) return Promise.resolve(() => {});
  return listen<JobEvent>('job-event', (event) => callback(event.payload));
}

// ---------- 创建 / 变更 ----------

export async function planCreateEnvironment(instanceId: string, request: CreateEnvironmentRequest): Promise<OperationPlan> {
  if (isTauri()) return invoke('plan_create_environment', { instanceId, request });
  await delay(300);
  return demoPlan([`python=${request.pythonVersion ?? '3.12'}`, ...request.packages]);
}

export async function startCreateEnvironment(instanceId: string, request: CreateEnvironmentRequest): Promise<JobSnapshot> {
  if (isTauri()) return invoke('start_create_environment', { instanceId, request });
  await delay(300);
  return demoJob('create_environment', request.name, 'succeeded', `环境 ${request.name} 已创建`);
}

export async function planInstallPackages(instanceId: string, prefix: string, packages: string[]): Promise<OperationPlan> {
  if (isTauri()) return invoke('plan_install_packages', { instanceId, prefix, packages });
  await delay(300);
  return demoPlan(packages);
}

export async function startInstallPackages(instanceId: string, prefix: string, packages: string[]): Promise<JobSnapshot> {
  if (isTauri()) return invoke('start_install_packages', { instanceId, prefix, packages });
  await delay(300);
  return demoJob('install_packages', packages.join(', '), 'succeeded', `已安装 ${packages.join(', ')}`);
}

export async function planRemovePackages(instanceId: string, prefix: string, packages: string[]): Promise<OperationPlan> {
  if (isTauri()) return invoke('plan_remove_packages', { instanceId, prefix, packages });
  await delay(300);
  return {
    supported: true,
    command: null,
    changes: packages.map((name) => ({ action: 'remove', name, fromVersion: '1.0.0', toVersion: null, channel: null })),
    downloads: [],
    warnings: [],
    fetchBytes: 0,
  };
}

export async function startRemovePackages(instanceId: string, prefix: string, packages: string[]): Promise<JobSnapshot> {
  if (isTauri()) return invoke('start_remove_packages', { instanceId, prefix, packages });
  await delay(300);
  return demoJob('remove_packages', packages.join(', '), 'succeeded', `已卸载 ${packages.join(', ')}`);
}

export async function startDeleteEnvironment(instanceId: string, prefix: string): Promise<JobSnapshot> {
  if (isTauri()) return invoke('start_delete_environment', { instanceId, prefix });
  await delay(300);
  return demoJob('delete_environment', prefix, 'succeeded', '环境已删除');
}

export async function startCloneEnvironment(instanceId: string, sourcePrefix: string, targetName: string): Promise<JobSnapshot> {
  if (isTauri()) return invoke('start_clone_environment', { instanceId, sourcePrefix, targetName });
  await delay(300);
  return demoJob('clone_environment', targetName, 'succeeded', `环境 ${targetName} 已克隆`);
}

// ---------- 导出 / 导入 ----------

export async function exportEnvironmentYaml(instanceId: string, prefix: string): Promise<string> {
  if (isTauri()) return invoke('export_environment_yaml', { instanceId, prefix });
  await delay(400);
  return `name: demo\ndependencies:\n  - python=3.12.7\n  - numpy\n  - pandas\n`;
}

export async function exportEnvironmentYamlToFile(instanceId: string, prefix: string, destination: string): Promise<void> {
  if (isTauri()) return invoke('export_environment_yaml_to_file', { instanceId, prefix, destination });
  await delay(200);
}

export async function exportExplicitSpec(instanceId: string, prefix: string): Promise<string> {
  if (isTauri()) return invoke('export_explicit_spec', { instanceId, prefix });
  await delay(300);
  return '# explicit spec\nhttps://conda.anaconda.org/conda-forge/win-64/python-3.12.7-0.conda\n';
}

export async function exportExplicitSpecToFile(instanceId: string, prefix: string, destination: string): Promise<void> {
  if (isTauri()) return invoke('export_explicit_spec_to_file', { instanceId, prefix, destination });
  await delay(200);
}

export async function parseYamlPreview(source: string): Promise<YamlPreview> {
  if (isTauri()) return invoke('parse_yaml_preview', { source });
  await delay(200);
  return { parsed: true, name: 'demo-import', channels: ['conda-forge'], dependencies: ['python=3.11', 'numpy'], error: null };
}

export async function importEnvironmentYaml(instanceId: string, source: string, targetName?: string): Promise<JobSnapshot> {
  if (isTauri()) return invoke('import_environment_yaml', { instanceId, source, targetName: targetName ?? null });
  await delay(300);
  return demoJob('import_environment', targetName ?? 'imported', 'succeeded', '环境导入完成');
}

export async function importExplicitSpec(instanceId: string, prefix: string, source: string): Promise<JobSnapshot> {
  if (isTauri()) return invoke('import_explicit_spec', { instanceId, prefix, source });
  await delay(300);
  return demoJob('import_explicit', prefix, 'succeeded', '环境已从 explicit spec 创建');
}

// ---------- 包搜索 ----------

export async function searchPackages(instanceId: string, query: string): Promise<SearchResult[]> {
  if (isTauri()) return invoke('search_packages', { instanceId, query });
  await delay(300);
  return [
    { name: query, version: '1.0.0', channel: 'conda-forge' },
    { name: `${query}-extra`, version: '2.3.1', channel: 'defaults' },
  ];
}

export async function listPackageVersions(instanceId: string, packageName: string): Promise<SearchResult[]> {
  if (isTauri()) return invoke('list_package_versions', { instanceId, package: packageName });
  await delay(300);
  return [
    { name: packageName, version: '2.5.0', channel: 'conda-forge' },
    { name: packageName, version: '2.4.1', channel: 'conda-forge' },
    { name: packageName, version: '2.4.0', channel: 'defaults' },
    { name: packageName, version: '2.3.0', channel: 'conda-forge' },
  ];
}

// ---------- 渠道 ----------

export async function getChannels(instanceId: string): Promise<ChannelInfo> {
  if (isTauri()) return invoke('get_channels', { instanceId });
  await delay(250);
  return { channels: ['conda-forge', 'defaults'] };
}

export async function addChannel(instanceId: string, channel: string): Promise<ChannelInfo> {
  if (isTauri()) return invoke('add_channel', { instanceId, channel });
  await delay(300);
  return { channels: ['conda-forge', 'defaults', channel] };
}

export async function removeChannel(instanceId: string, channel: string): Promise<ChannelInfo> {
  if (isTauri()) return invoke('remove_channel', { instanceId, channel });
  await delay(300);
  return { channels: ['conda-forge', 'defaults'].filter((c) => c !== channel) };
}

export async function testChannelConnectivity(instanceId: string, channel?: string): Promise<ChannelTestResult[]> {
  if (isTauri()) return invoke('test_channel_connectivity', { instanceId, channel: channel ?? null });
  await delay(600);
  const name = channel ?? 'conda-forge';
  return [
    { channel: name, target: name === 'defaults' ? 'https://repo.anaconda.com/pkgs/main' : `https://conda.anaconda.org/${name}`, reachable: true, latencyMs: 120, error: null },
  ];
}

// ---------- 诊断 / 缓存 / 离线 ----------

export async function getDiagnostics(instanceId: string): Promise<DiagnosticReport> {
  if (isTauri()) return invoke('get_diagnostics', { instanceId });
  await delay(400);
  return { generatedAt: Date.now(), redacted: true, sections: [{ title: 'Conda 实例信息', content: '(演示数据)' }] };
}

export async function cleanCache(instanceId: string, kind: string): Promise<JobSnapshot> {
  if (isTauri()) return invoke('clean_cache', { instanceId, kind });
  await delay(300);
  return demoJob('clean_cache', kind, 'succeeded', '缓存清理完成');
}

export async function buildOfflineChannel(instanceId: string, prefix: string, destination: string): Promise<JobSnapshot> {
  if (isTauri()) return invoke('build_offline_channel', { instanceId, prefix, destination });
  await delay(300);
  return demoJob('build_offline_channel', prefix, 'succeeded', '离线包已下载');
}

export async function buildWheelhouse(instanceId: string, prefix: string, destination: string): Promise<JobSnapshot> {
  if (isTauri()) return invoke('build_wheelhouse', { instanceId, prefix, destination });
  await delay(300);
  return demoJob('build_wheelhouse', prefix, 'succeeded', 'wheelhouse 已构建');
}

export async function condaPackEnvironment(instanceId: string, prefix: string, destination: string): Promise<JobSnapshot> {
  if (isTauri()) return invoke('conda_pack_environment', { instanceId, prefix, destination });
  await delay(300);
  return demoJob('conda_pack', prefix, 'succeeded', '环境已打包');
}

// ---------- 终端 ----------

export async function openEnvironmentTerminal(instanceId: string, prefix: string): Promise<void> {
  if (isTauri()) return invoke('open_environment_terminal', { instanceId, prefix });
  await delay(150);
}

export async function openEnvironmentDirectory(instanceId: string, prefix: string): Promise<void> {
  if (isTauri()) return invoke('open_environment_directory', { instanceId, prefix });
  await delay(100);
}

// ---------- 安装引导 ----------

export async function getInstallInfo(): Promise<InstallInfo> {
  if (isTauri()) return invoke('get_install_info');
  await delay(150);
  return {
    name: 'Miniforge3',
    version: 'latest',
    arch: 'x86_64',
    filename: 'Miniforge3-Windows-x86_64.exe',
    license: 'BSD-3-Clause',
    description: 'Miniforge 是社区维护的轻量 Conda 发行版，默认使用 conda-forge 渠道。',
    sources: [
      { id: 'tuna', label: '清华 TUNA 镜像（推荐）', downloadUrl: 'https://mirrors.tuna.tsinghua.edu.cn/github-release/conda-forge/miniforge/LatestRelease/Miniforge3-Windows-x86_64.exe', recommended: true },
      { id: 'github', label: 'GitHub 官方', downloadUrl: 'https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Windows-x86_64.exe', recommended: false },
    ],
  };
}

export async function startDownloadInstaller(destination: string, url: string): Promise<JobSnapshot> {
  if (isTauri()) return invoke('start_download_installer', { destination, url });
  await delay(300);
  return demoJob('download_installer', destination, 'succeeded', '安装器已下载完成');
}

export async function launchInstaller(path: string): Promise<void> {
  if (isTauri()) return invoke('launch_installer', { path });
  await delay(100);
}

// ---------- 文件对话框 ----------

export async function pickYamlFile(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await open({
    multiple: false,
    filters: [{ name: 'YAML', extensions: ['yml', 'yaml'] }],
  });
  return typeof selected === 'string' ? selected : null;
}

export async function pickExplicitFile(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await open({
    multiple: false,
    filters: [{ name: 'Spec', extensions: ['txt'] }],
  });
  return typeof selected === 'string' ? selected : null;
}

export async function pickSaveFile(defaultName: string, extensions: string[]): Promise<string | null> {
  if (!isTauri()) return null;
  return save({ defaultPath: defaultName, filters: [{ name: 'File', extensions }] });
}

export async function pickDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === 'string' ? selected : null;
}

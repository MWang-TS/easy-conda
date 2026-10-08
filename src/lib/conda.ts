import { invoke, isTauri } from '@tauri-apps/api/core';
import type {
  ChannelInfo, ChannelTestResult, CondaInstance, CreateEnvironmentRequest,
  EnvironmentSummary, OperationRecord, PackageRecord, SearchResult,
} from '../types';

const demoInstance: CondaInstance = {
  id: 'demo-conda',
  executablePath: 'C:\\Tools\\Miniforge3\\Scripts\\conda.exe',
  kind: 'conda',
  version: '24.9.2',
  rootPrefix: 'C:\\Tools\\Miniforge3',
  platform: 'win-64',
  isDefault: true,
};

const demoEnvironments: EnvironmentSummary[] = [
  { instanceId: demoInstance.id, name: 'base', prefix: demoInstance.rootPrefix, isBase: true, pythonVersion: '3.12.7', packageCount: 142, platform: 'win-64', sizeBytes: 8420081664 },
  { instanceId: demoInstance.id, name: 'vision-lab', prefix: 'D:\\Work\\conda_envs\\vision-lab', isBase: false, pythonVersion: '3.11.9', packageCount: 86, platform: 'win-64', sizeBytes: 3985000000 },
  { instanceId: demoInstance.id, name: 'data-tools', prefix: 'D:\\Work\\conda_envs\\data-tools', isBase: false, pythonVersion: '3.10.14', packageCount: 37, platform: 'win-64', sizeBytes: 1536000000 },
  { instanceId: demoInstance.id, name: 'py312-clean', prefix: 'C:\\Users\\dev\\.conda\\envs\\py312-clean', isBase: false, pythonVersion: '3.12.5', packageCount: 8, platform: 'win-64', sizeBytes: 214000000 },
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

export async function listInstances(): Promise<CondaInstance[]> {
  if (isTauri()) return invoke('list_conda_instances');
  await delay(350);
  return [demoInstance];
}

export async function listEnvironments(instanceId: string, force = false): Promise<EnvironmentSummary[]> {
  if (isTauri()) return invoke('list_environments', { instanceId, force });
  await delay(300);
  return demoEnvironments;
}

export async function listPackages(instanceId: string, prefix: string): Promise<PackageRecord[]> {
  if (isTauri()) return invoke('list_packages', { instanceId, prefix });
  await delay(220);
  if (prefix === demoInstance.rootPrefix) return demoPackages.slice(0, 5);
  return demoPackages;
}

export async function rediscover(): Promise<CondaInstance[]> {
  if (isTauri()) return invoke('discover_conda_instances');
  await delay(650);
  return [demoInstance];
}

export async function createEnvironment(instanceId: string, request: CreateEnvironmentRequest): Promise<EnvironmentSummary> {
  if (isTauri()) return invoke('create_environment', { instanceId, request });
  await delay(1200);
  const env: EnvironmentSummary = {
    instanceId: demoInstance.id,
    name: request.name,
    prefix: `D:\\Work\\conda_envs\\${request.name}`,
    isBase: false,
    pythonVersion: request.pythonVersion ?? '3.12.7',
    packageCount: request.packages.length + 5,
    platform: 'win-64',
    sizeBytes: 150000000,
  };
  demoEnvironments.push(env);
  return env;
}

export async function deleteEnvironment(instanceId: string, prefix: string): Promise<void> {
  if (isTauri()) return invoke('start_delete_environment', { instanceId, prefix });
  await delay(800);
  const index = demoEnvironments.findIndex((env) => env.prefix === prefix);
  if (index >= 0) demoEnvironments.splice(index, 1);
}

export async function exportEnvironmentYaml(instanceId: string, prefix: string): Promise<string> {
  if (isTauri()) return invoke('export_environment_yaml', { instanceId, prefix });
  await delay(400);
  return `name: demo\ndependencies:\n  - python=3.12.7\n  - numpy\n  - pandas\n`;
}

export async function installPackages(instanceId: string, prefix: string, packages: string[]): Promise<void> {
  if (isTauri()) return invoke('install_packages', { instanceId, prefix, packages });
  await delay(1000);
}

export async function removePackages(instanceId: string, prefix: string, packages: string[]): Promise<void> {
  if (isTauri()) return invoke('remove_packages', { instanceId, prefix, packages });
  await delay(800);
}

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

export async function listOperations(): Promise<OperationRecord[]> {
  if (isTauri()) return invoke('list_operations');
  await delay(200);
  return [];
}

export async function openEnvironmentTerminal(instanceId: string, prefix: string): Promise<void> {
  if (isTauri()) return invoke('open_environment_terminal', { instanceId, prefix });
  await delay(150);
}

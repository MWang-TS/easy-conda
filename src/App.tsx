import { useEffect, useState } from 'react';
import {
  Activity, AlertCircle, ArrowDownToLine, Box, Check, ChevronDown,
  ChevronRight, CircleHelp, Clipboard, Command, Copy, Cpu, Database,
  ExternalLink, FolderOpen, Layers3, LoaderCircle, MoreHorizontal, Package,
  Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, TerminalSquare,
  Trash2, X,
} from 'lucide-react';
import {
  addChannel, createEnvironment, deleteEnvironment, exportEnvironmentYaml,
  getChannels, installPackages, listEnvironments, listInstances, listOperations,
  listPackages, listPackageVersions, openEnvironmentTerminal, rediscover,
  removeChannel, removePackages, searchPackages, testChannelConnectivity,
} from './lib/conda';
import type {
  ChannelInfo, ChannelTestResult, CondaInstance, EnvironmentSummary,
  OperationRecord, PackageRecord, SearchResult,
} from './types';

type View = 'environments' | 'tasks' | 'packages' | 'settings' | 'help';

const VIEW_META: Record<View, { label: string; icon: typeof Box }> = {
  environments: { label: '环境管理', icon: Box },
  tasks: { label: '任务中心', icon: Activity },
  packages: { label: '软件包', icon: Package },
  settings: { label: '设置', icon: Settings2 },
  help: { label: '帮助', icon: CircleHelp },
};

const PRIMARY_NAV: View[] = ['environments', 'tasks', 'packages'];
const SECONDARY_NAV: View[] = ['settings', 'help'];

const formatNumber = (value: number) => new Intl.NumberFormat('en-US').format(value);
const formatTime = (millis: number) => new Date(millis).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function formatBytes(bytes: number | null): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 'B';
  for (const next of units) {
    value /= 1024;
    unit = next;
    if (value < 1024) break;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

const OPERATION_LABEL: Record<string, string> = {
  create_environment: '创建环境',
  delete_environment: '删除环境',
  install_packages: '安装包',
  remove_packages: '卸载包',
};

// ---------- 新建环境对话框 ----------
function CreateEnvironmentDialog({ instanceId, onClose, onCreated }: {
  instanceId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [pythonVersion, setPythonVersion] = useState('3.12');
  const [packagesText, setPackagesText] = useState('');
  const [channel, setChannel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (!name.trim()) { setError('请输入环境名称'); return; }
    setSubmitting(true);
    setError('');
    try {
      await createEnvironment(instanceId, {
        name: name.trim(),
        pythonVersion: pythonVersion || null,
        packages: packagesText.split(/\s+/).filter(Boolean),
        channels: channel ? [channel] : [],
      });
      onCreated();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建环境失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-title">
        <div className="dialog-header">
          <div>
            <span className="dialog-kicker"><Sparkles size={14} /> 新建工作环境</span>
            <h2 id="create-title">创建 Conda 环境</h2>
            <p>为项目创建隔离的 Python 环境。</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button>
        </div>
        <div className="dialog-fields">
          <label>环境名称
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：my-project" />
          </label>
          <div className="field-row">
            <label>Python 版本
              <select value={pythonVersion} onChange={(event) => setPythonVersion(event.target.value)}>
                <option>3.12</option><option>3.11</option><option>3.10</option><option>3.9</option>
              </select>
            </label>
            <label>下载源 <span className="optional-label">可选</span>
              <select value={channel} onChange={(event) => setChannel(event.target.value)}>
                <option value="">使用当前配置</option>
                <option value="conda-forge">conda-forge</option>
                <option value="defaults">defaults</option>
              </select>
            </label>
          </div>
          <label>初始依赖 <span className="optional-label">可选</span>
            <input value={packagesText} onChange={(event) => setPackagesText(event.target.value)} placeholder="输入包名，以空格分隔" />
          </label>
          {error && <div className="dialog-error"><AlertCircle size={15} />{error}</div>}
          <div className="dialog-note"><ShieldCheck size={16} /><span>环境将使用所选下载源创建，依赖由 Conda 自动解析。</span></div>
        </div>
        <div className="dialog-footer">
          <button className="secondary-button" onClick={onClose} disabled={submitting}>取消</button>
          <button className="primary-button" onClick={() => void submit()} disabled={submitting}>
            {submitting ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
            {submitting ? '创建中…' : '创建'}
          </button>
        </div>
      </section>
    </div>
  );
}

// ---------- 导出 YAML 对话框 ----------
function ExportDialog({ yaml, onClose }: { yaml: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(yaml); setCopied(true); } catch { /* ignore */ }
  }
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="create-dialog export-dialog" role="dialog" aria-modal="true">
        <div className="dialog-header">
          <div><span className="dialog-kicker"><ArrowDownToLine size={14} /> 导出依赖</span><h2>environment.yml</h2><p>将下面的内容保存为文件，用于在其他机器上重建环境。</p></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button>
        </div>
        <div className="export-body">
          <button className="copy-button" onClick={() => void copy()}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? '已复制' : '复制内容'}</button>
          <pre>{yaml}</pre>
        </div>
        <div className="dialog-footer">
          <button className="secondary-button" onClick={onClose}>关闭</button>
        </div>
      </section>
    </div>
  );
}

// ---------- 任务中心 ----------
function TasksView() {
  const [operations, setOperations] = useState<OperationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void listOperations().then(setOperations).finally(() => setLoading(false));
  }, []);
  return (
    <div className="page-content">
      <section className="page-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" /> 操作记录</div><h1>任务中心</h1><p>查看创建、删除、安装等操作的执行结果与历史。</p></div>
      </section>
      <section className="tasks-card">
        {loading ? <div className="table-state"><LoaderCircle className="spin" size={19} />正在读取任务…</div> : operations.length === 0 ? (
          <div className="tasks-empty"><Clipboard size={28} /><strong>暂无操作记录</strong><span>创建环境、安装包等操作会显示在这里。</span></div>
        ) : (
          <ul className="task-list">
            {operations.map((operation) => (
              <li key={operation.id} className="task-row">
                <div className={`task-status ${operation.status}`} />
                <div className="task-main">
                  <strong>{OPERATION_LABEL[operation.kind] ?? operation.kind}</strong>
                  <span>{operation.target}</span>
                </div>
                <div className="task-summary">{operation.summary}</div>
                <div className="task-time">{formatTime(operation.startedAt)}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <footer className="app-footer"><span><span className="footer-dot" />操作记录保存在本次会话中</span></footer>
    </div>
  );
}

// ---------- 软件包管理 ----------
function PackagesView({ instance, environments }: { instance?: CondaInstance; environments: EnvironmentSummary[] }) {
  const [selectedEnv, setSelectedEnv] = useState<EnvironmentSummary | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [installed, setInstalled] = useState<PackageRecord[]>([]);
  const [installedQuery, setInstalledQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [upgradeTarget, setUpgradeTarget] = useState<PackageRecord | null>(null);
  const [versions, setVersions] = useState<SearchResult[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeVersion, setUpgradeVersion] = useState('');

  // 环境列表加载后默认选中第一个环境
  useEffect(() => {
    if (environments.length === 0) { setSelectedEnv(null); return; }
    setSelectedEnv((current) => environments.find((env) => env.prefix === current?.prefix) ?? environments[0]);
  }, [environments]);

  // 选中环境变化时加载其已安装软件包
  useEffect(() => {
    if (!instance || !selectedEnv) { setInstalled([]); return; }
    let alive = true;
    void listPackages(selectedEnv.instanceId, selectedEnv.prefix)
      .then((result) => { if (alive) setInstalled(result); })
      .catch((cause: unknown) => { if (alive) setError(cause instanceof Error ? cause.message : '无法读取包列表'); });
    return () => { alive = false; };
  }, [instance, selectedEnv]);

  async function doSearch() {
    if (!instance || !query.trim()) return;
    setSearching(true);
    setError('');
    try { setResults(await searchPackages(instance.id, query.trim())); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '搜索失败'); }
    finally { setSearching(false); }
  }

  async function install(name: string) {
    if (!instance || !selectedEnv) return;
    setBusy(name);
    setError('');
    try {
      await installPackages(instance.id, selectedEnv.prefix, [name]);
      setInstalled(await listPackages(selectedEnv.instanceId, selectedEnv.prefix));
    } catch (cause) { setError(cause instanceof Error ? cause.message : '安装失败'); }
    finally { setBusy(null); }
  }

  async function remove(name: string) {
    if (!instance || !selectedEnv) return;
    setBusy(name);
    setError('');
    try {
      await removePackages(instance.id, selectedEnv.prefix, [name]);
      setInstalled(await listPackages(selectedEnv.instanceId, selectedEnv.prefix));
    } catch (cause) { setError(cause instanceof Error ? cause.message : '卸载失败'); }
    finally { setBusy(null); }
  }

  async function openUpgrade(target: PackageRecord) {
    if (!instance || !selectedEnv) return;
    setUpgradeTarget(target);
    setUpgradeVersion('');
    setVersions([]);
    setLoadingVersions(true);
    setError('');
    try {
      const available = await listPackageVersions(instance.id, target.name);
      setVersions(available);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '读取版本失败'); }
    finally { setLoadingVersions(false); }
  }

  async function upgrade(spec: string) {
    if (!instance || !selectedEnv || !upgradeTarget) return;
    setUpgrading(true);
    setError('');
    try {
      await installPackages(instance.id, selectedEnv.prefix, [spec]);
      setInstalled(await listPackages(selectedEnv.instanceId, selectedEnv.prefix));
      setUpgradeTarget(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '升级失败'); }
    finally { setUpgrading(false); }
  }

  if (!instance) {
    return <div className="page-content"><div className="placeholder-card"><div className="placeholder-icon"><Package size={26} /></div><h1>未发现 Conda</h1><p>请先在环境管理页扫描并选择 Conda 实例。</p></div></div>;
  }

  const visibleInstalled = installed.filter((item) => item.name.toLowerCase().includes(installedQuery.toLowerCase()));
  const installedName = selectedEnv?.name ?? '未命名环境';

  return (
    <div className="page-content">
      <section className="page-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" /> 依赖管理</div><h1>软件包</h1><p>选择环境查看已安装软件包，或搜索并安装新的依赖。</p></div>
      </section>
      {error && <div className="error-banner"><AlertCircle size={17} /><span>{error}</span><button onClick={() => setError('')}><X size={15} /></button></div>}
      <div className="packages-layout">
        <section className="packages-card">
          <div className="packages-card-head">
            <h2>已安装软件包</h2>
            <p>选择环境查看其已安装的依赖</p>
          </div>
          <div className="env-select-row">
            <div className="env-select-wrap">
              <Package size={15} />
              <select value={selectedEnv?.prefix ?? ''} onChange={(event) => {
                const prefix = event.target.value;
                setSelectedEnv(environments.find((env) => env.prefix === prefix) ?? null);
              }}>
                {environments.length === 0 && <option value="">未发现环境</option>}
                {environments.map((env) => (
                  <option key={env.prefix} value={env.prefix}>{env.name ?? '未命名环境'}{env.isBase ? ' (base)' : ''}</option>
                ))}
              </select>
              <ChevronDown size={14} />
            </div>
          </div>
          <div className="installed-head">
            <label className="package-search"><Search size={14} /><input value={installedQuery} onChange={(event) => setInstalledQuery(event.target.value)} placeholder="筛选已安装包" /></label>
            <span className="installed-count">{installed.length} 个</span>
          </div>
          <ul className="installed-list">
            {visibleInstalled.map((item) => (
              <li key={item.name} className="installed-row" onClick={() => void openUpgrade(item)}>
                <div className="result-main"><strong>{item.name}</strong><span>{item.packageType === 'pip' ? 'PyPI' : item.channel ?? 'Conda'}</span></div>
                <code>{item.version}</code>
                <button className="mini-button" title="升级 / 指定版本" onClick={(event) => { event.stopPropagation(); void openUpgrade(item); }}><RefreshCw size={14} />升级</button>
                <button className="mini-button danger" onClick={(event) => { event.stopPropagation(); void remove(item.name); }} disabled={busy === item.name || selectedEnv?.isBase}>{busy === item.name ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}卸载</button>
              </li>
            ))}
            {visibleInstalled.length === 0 && <li className="result-empty">{selectedEnv ? '该环境暂无匹配的软件包' : '请选择一个环境'}</li>}
          </ul>
        </section>
        <section className="packages-card">
          <div className="packages-card-head"><h2>搜索新软件包</h2><p>安装到当前环境「{installedName}」</p></div>
          <div className="search-row">
            <label className="search-field wide"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void doSearch(); }} placeholder="输入包名，如 numpy" /></label>
            <button className="primary-button" onClick={() => void doSearch()} disabled={searching}>{searching ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}搜索</button>
          </div>
          <ul className="result-list">
            {results.map((result) => (
              <li key={`${result.name}-${result.channel}`} className="result-row">
                <div className="result-main"><strong>{result.name}</strong><span>{result.channel || '默认渠道'}</span></div>
                <code>{result.version}</code>
                <button className="mini-button" onClick={() => void install(result.name)} disabled={busy === result.name || !selectedEnv}>{busy === result.name ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}安装</button>
              </li>
            ))}
            {!searching && results.length === 0 && <li className="result-empty">输入包名后点击搜索</li>}
          </ul>
        </section>
      </div>
      <footer className="app-footer"><span><span className="footer-dot" />{instance.kind} {instance.version}</span><span>安装操作会应用到所选环境「{installedName}」</span></footer>

      {upgradeTarget && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setUpgradeTarget(null); }}>
          <section className="upgrade-dialog" role="dialog" aria-modal="true">
            <div className="dialog-header">
              <div>
                <span className="dialog-kicker"><RefreshCw size={14} /> 升级软件包</span>
                <h2>{upgradeTarget.name}</h2>
                <p>当前版本 <code className="current-version">{upgradeTarget.version}</code>，环境「{installedName}」</p>
              </div>
              <button className="icon-button" onClick={() => setUpgradeTarget(null)} aria-label="关闭"><X size={17} /></button>
            </div>
            <div className="dialog-fields">
              <button className="primary-button upgrade-latest" onClick={() => void upgrade(upgradeTarget.name)} disabled={upgrading}>
                {upgrading ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}升级到最新版
              </button>
              <div className="version-picker">
                <span className="version-picker-label">或指定版本</span>
                {loadingVersions ? (
                  <div className="table-state"><LoaderCircle className="spin" size={16} />正在读取可用版本…</div>
                ) : versions.length === 0 ? (
                  <div className="result-empty">未找到可用版本</div>
                ) : (
                  <div className="version-list">
                    {versions.map((item) => (
                      <button
                        key={`${item.version}-${item.channel}`}
                        className={`version-option ${upgradeVersion === item.version ? 'selected' : ''}`}
                        onClick={() => setUpgradeVersion(item.version)}
                      >
                        <span className="version-radio">{upgradeVersion === item.version ? <Check size={12} /> : null}</span>
                        <code>{item.version}</code>
                        <span className="version-channel">{item.channel || '默认渠道'}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {error && <div className="dialog-error"><AlertCircle size={15} />{error}</div>}
            </div>
            <div className="dialog-footer">
              <button className="secondary-button" onClick={() => setUpgradeTarget(null)} disabled={upgrading}>取消</button>
              <button className="primary-button" onClick={() => void upgrade(`${upgradeTarget.name}=${upgradeVersion}`)} disabled={upgrading || !upgradeVersion}>
                {upgrading ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}升级到 {upgradeVersion || '…'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

// ---------- 设置 ----------
const PRESET_CHANNELS: { label: string; value: string }[] = [
  { label: '清华镜像 · main', value: 'https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/main' },
  { label: '清华镜像 · conda-forge', value: 'https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge' },
  { label: 'Conda 官方 (defaults)', value: 'defaults' },
  { label: 'conda-forge', value: 'conda-forge' },
];

const DEFAULT_CHANNELS = [
  'https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/main',
  'defaults',
];

function SettingsView({ instance }: { instance?: CondaInstance }) {
  const [channels, setChannels] = useState<ChannelInfo | null>(null);
  const [newChannel, setNewChannel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [testResults, setTestResults] = useState<Record<string, ChannelTestResult>>({});
  const [testingAll, setTestingAll] = useState(false);
  const [testingChannel, setTestingChannel] = useState<string | null>(null);

  async function load() {
    if (!instance) return;
    try { setChannels(await getChannels(instance.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '读取渠道失败'); }
  }
  useEffect(() => { void load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [instance]);

  async function add() {
    if (!instance || !newChannel.trim()) return;
    setBusy(newChannel.trim());
    setError('');
    try { setChannels(await addChannel(instance.id, newChannel.trim())); setNewChannel(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '添加渠道失败'); }
    finally { setBusy(null); }
  }

  async function remove(channel: string) {
    if (!instance) return;
    setBusy(channel);
    setError('');
    try { setChannels(await removeChannel(instance.id, channel)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '删除渠道失败'); }
    finally { setBusy(null); }
  }

  async function applyPreset(value: string) {
    if (!instance) return;
    setBusy(value);
    setError('');
    try { setChannels(await addChannel(instance.id, value)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '添加渠道失败'); }
    finally { setBusy(null); }
  }

  async function applyDefault() {
    if (!instance) return;
    setBusy('__default__');
    setError('');
    try {
      let current = channels;
      for (const value of DEFAULT_CHANNELS) {
        current = await addChannel(instance.id, value);
      }
      setChannels(current);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '恢复默认失败'); }
    finally { setBusy(null); }
  }

  async function testAll() {
    if (!instance) return;
    setTestingAll(true);
    setError('');
    try {
      const results = await testChannelConnectivity(instance.id);
      const map: Record<string, ChannelTestResult> = {};
      for (const result of results) map[result.channel] = result;
      setTestResults(map);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : '连通性测试失败'); }
    finally { setTestingAll(false); }
  }

  async function testOne(channel: string) {
    if (!instance) return;
    setTestingChannel(channel);
    setError('');
    try {
      const results = await testChannelConnectivity(instance.id, channel);
      if (results[0]) setTestResults((prev) => ({ ...prev, [channel]: results[0] }));
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : '连通性测试失败'); }
    finally { setTestingChannel(null); }
  }

  if (!instance) {
    return <div className="page-content"><div className="placeholder-card"><div className="placeholder-icon"><Settings2 size={26} /></div><h1>未发现 Conda</h1><p>请先在环境管理页扫描并选择 Conda 实例。</p></div></div>;
  }

  return (
    <div className="page-content">
      <section className="page-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" /> 源与配置</div><h1>设置</h1><p>管理 Conda 下载源（渠道）与实例配置。</p></div>
      </section>
      {error && <div className="error-banner"><AlertCircle size={17} /><span>{error}</span><button onClick={() => setError('')}><X size={15} /></button></div>}
      <div className="settings-layout">
        <section className="settings-card">
          <div className="settings-card-head"><h2>下载源（渠道）</h2><p>优先级从高到低排列，安装包时依次查找</p></div>
          <div className="channel-add">
            <label className="search-field wide"><input value={newChannel} onChange={(event) => setNewChannel(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void add(); }} placeholder="添加渠道，如 conda-forge" /></label>
            <button className="primary-button" onClick={() => void add()} disabled={busy !== null}><Plus size={16} />添加</button>
            <button className="secondary-button" onClick={() => void testAll()} disabled={testingAll}>{testingAll ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}{testingAll ? '测试中…' : '测试全部'}</button>
          </div>
          <div className="preset-channels">
            <span className="preset-label">快捷添加</span>
            {PRESET_CHANNELS.map((preset) => {
              const isCurrent = channels?.channels[0] === preset.value;
              return (
                <button key={preset.value} className={`preset-chip ${isCurrent ? 'active' : ''}`} onClick={() => void applyPreset(preset.value)} disabled={busy !== null} title={preset.value}>
                  {busy === preset.value ? '添加中…' : (<>{isCurrent && <Check size={12} />}{preset.label}{isCurrent && <span className="preset-current">当前</span>}</>)}
                </button>
              );
            })}
            <button className="preset-chip" onClick={() => void applyDefault()} disabled={busy !== null}>
              {busy === '__default__' ? '添加中…' : '恢复默认（清华 + 官方）'}
            </button>
          </div>
          <div className="current-channel">
            <span className="current-channel-label">当前使用的下载源</span>
            <code>{channels?.channels[0] ?? '未配置'}</code>
          </div>
          <ul className="channel-list">
            {(channels?.channels ?? []).map((channel, index) => {
              const result = testResults[channel];
              return (
                <li key={channel} className="channel-row">
                  <span className="channel-index">{index + 1}</span>
                  <code>{channel}</code>
                  {result && (
                    <span className={`channel-test-status ${result.reachable ? 'ok' : 'fail'}`} title={result.target}>
                      {result.reachable ? `${result.latencyMs ?? '—'} ms` : (result.error ?? '不可达')}
                    </span>
                  )}
                  <button className="mini-button" onClick={() => void testOne(channel)} disabled={testingChannel === channel || testingAll}>
                    {testingChannel === channel ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
                    测试
                  </button>
                  <button className="mini-button danger" onClick={() => void remove(channel)} disabled={busy === channel}><Trash2 size={14} />移除</button>
                </li>
              );
            })}
            {(channels?.channels ?? []).length === 0 && <li className="result-empty">暂无渠道</li>}
          </ul>
        </section>
        <section className="settings-card">
          <div className="settings-card-head"><h2>Conda 实例</h2><p>当前使用的 Conda 安装信息</p></div>
          <ul className="instance-list">
            <li><span>类型</span><strong>{instance.kind}</strong></li>
            <li><span>版本</span><strong>{instance.version}</strong></li>
            <li><span>平台</span><strong>{instance.platform}</strong></li>
            <li><span>根目录</span><code>{instance.rootPrefix}</code></li>
            <li><span>可执行文件</span><code>{instance.executablePath}</code></li>
          </ul>
        </section>
      </div>
      <footer className="app-footer"><span><span className="footer-dot" />配置修改会写入 Conda 用户配置</span></footer>
    </div>
  );
}

// ---------- 帮助 ----------
function HelpView() {
  return (
    <div className="page-content">
      <section className="page-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" /> 使用说明</div><h1>帮助</h1><p>了解 Easy Conda 的功能与常见问题。</p></div>
      </section>
      <div className="help-list">
        <div className="help-card"><h3>环境管理</h3><p>在「环境管理」页查看本机所有 Conda 环境，选择环境查看详情。可创建新环境或删除非 base 环境。</p></div>
        <div className="help-card"><h3>软件包</h3><p>在「软件包」页搜索并安装依赖，或卸载环境中的包。安装会触发 Conda 依赖解析。</p></div>
        <div className="help-card"><h3>下载源</h3><p>在「设置」页管理渠道。添加 conda-forge 等镜像可加速或切换下载来源。</p></div>
        <div className="help-card"><h3>导出依赖</h3><p>在环境详情面板点击导出按钮，可复制 environment.yml 用于在其他机器重建环境。</p></div>
        <div className="help-card"><h3>任务中心</h3><p>所有创建、删除、安装、卸载操作都会记录在任务中心，便于追溯执行结果。</p></div>
      </div>
      <footer className="app-footer"><span><span className="footer-dot" />Easy Conda 0.1.0</span></footer>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>('environments');
  const [instances, setInstances] = useState<CondaInstance[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentSummary[]>([]);
  const [packages, setPackages] = useState<PackageRecord[]>([]);
  const [selected, setSelected] = useState<EnvironmentSummary | null>(null);
  const [query, setQuery] = useState('');
  const [packageQuery, setPackageQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [exportYaml, setExportYaml] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busyAction, setBusyAction] = useState(false);

  async function refresh(discover = false) {
    setRefreshing(true);
    setError('');
    try {
      const found = discover ? await rediscover() : await listInstances();
      setInstances(found);
      if (found[0]) {
        const envs = await listEnvironments(found[0].id, discover);
        setEnvironments(envs);
        setSelected((current) => envs.find((env) => env.prefix === current?.prefix) ?? envs[0] ?? null);
      } else {
        setEnvironments([]);
        setSelected(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取 Conda 环境');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    if (!selected) { setPackages([]); return; }
    let alive = true;
    void listPackages(selected.instanceId, selected.prefix)
      .then((result) => { if (alive) setPackages(result); })
      .catch((cause: unknown) => { if (alive) setError(cause instanceof Error ? cause.message : '无法读取包列表'); });
    return () => { alive = false; };
  }, [selected]);

  async function handleExport() {
    if (!selected) return;
    setBusyAction(true);
    try { setExportYaml(await exportEnvironmentYaml(selected.instanceId, selected.prefix)); setShowExport(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '导出失败'); }
    finally { setBusyAction(false); }
  }

  async function handleDelete() {
    if (!selected || selected.isBase) return;
    setBusyAction(true);
    try { await deleteEnvironment(selected.instanceId, selected.prefix); setConfirmDelete(false); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '删除失败'); setConfirmDelete(false); }
    finally { setBusyAction(false); }
  }

  async function handleOpenTerminal() {
    if (!selected) return;
    try { await openEnvironmentTerminal(selected.instanceId, selected.prefix); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '打开终端失败'); }
  }

  const activeInstance = instances.find((instance) => instance.isDefault) ?? instances[0];
  const visibleEnvironments = environments.filter((environment) =>
    `${environment.name ?? ''} ${environment.prefix}`.toLowerCase().includes(query.toLowerCase()),
  );
  const visiblePackages = packages.filter((item) => item.name.toLowerCase().includes(packageQuery.toLowerCase()));
  const totalPackages = environments.reduce((sum, environment) => sum + (environment.packageCount ?? 0), 0);

  return (
    <div className="app-shell">
      <aside className="rail">
        <div className="brand-mark"><Layers3 size={19} strokeWidth={2.3} /></div>
        {PRIMARY_NAV.map((id) => {
          const Icon = VIEW_META[id].icon;
          return (
            <button key={id} className={`rail-button ${view === id ? 'active' : ''}`} title={VIEW_META[id].label} onClick={() => setView(id)}>
              <Icon size={19} />
            </button>
          );
        })}
        <div className="rail-spacer" />
        {SECONDARY_NAV.map((id) => {
          const Icon = VIEW_META[id].icon;
          return (
            <button key={id} className={`rail-button ${view === id ? 'active' : ''}`} title={VIEW_META[id].label} onClick={() => setView(id)}>
              <Icon size={19} />
            </button>
          );
        })}
        <div className="avatar">EC</div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="breadcrumb"><span>工作区</span><ChevronRight size={14} /><strong>{VIEW_META[view].label}</strong></div>
          <div className="topbar-actions">
            <div className="instance-picker"><span className="instance-dot" /><span>{activeInstance?.kind ?? 'Conda'} {activeInstance?.version ?? ''}</span><ChevronDown size={14} /></div>
            <button className="icon-button" title="刷新环境" onClick={() => void refresh()} disabled={refreshing}>
              <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
            </button>
            <button className="profile-button">本地计算机 <ChevronDown size={14} /></button>
          </div>
        </header>

        {view === 'tasks' ? <TasksView /> : view === 'packages' ? <PackagesView instance={activeInstance} environments={environments} /> : view === 'settings' ? <SettingsView instance={activeInstance} /> : view === 'help' ? <HelpView /> : (
          <div className="page-content">
            <section className="page-heading">
              <div>
                <div className="eyebrow"><span className="eyebrow-line" /> 环境与依赖</div>
                <h1>环境管理</h1>
                <p>集中查看和管理本机 Conda 环境。</p>
              </div>
              <button className="primary-button" onClick={() => setShowCreate(true)}><Plus size={17} /> 新建环境</button>
            </section>

            {error && <div className="error-banner"><AlertCircle size={17} /><span>{error}</span><button onClick={() => setError('')} aria-label="关闭"><X size={15} /></button></div>}

            <section className="overview-grid" aria-label="环境概览">
              <div className="overview-item"><div className="overview-icon mint"><Layers3 size={17} /></div><div><span className="metric-label">环境总数</span><strong>{loading ? '—' : environments.length}</strong></div><span className="metric-foot">个环境</span></div>
              <div className="overview-item"><div className="overview-icon blue"><Package size={17} /></div><div><span className="metric-label">已安装包</span><strong>{loading ? '—' : formatNumber(totalPackages)}</strong></div><span className="metric-foot">跨环境统计</span></div>
              <div className="overview-item"><div className="overview-icon coral"><Cpu size={17} /></div><div><span className="metric-label">默认 Python</span><strong className="metric-version">{activeInstance ? '3.12.7' : '未检测'}</strong></div><span className="metric-foot">base 环境</span></div>
              <div className="overview-item"><div className="overview-icon violet"><ShieldCheck size={17} /></div><div><span className="metric-label">Conda 状态</span><strong className="metric-status"><i />{activeInstance ? '运行正常' : '未发现'}</strong></div><span className="metric-foot">{activeInstance?.platform ?? '请检查安装'}</span></div>
            </section>

            <section className="environment-section">
              <div className="section-heading">
                <div><h2>所有环境 <span className="count-pill">{environments.length}</span></h2><p>管理已发现的 Conda 环境与软件包</p></div>
                <div className="section-tools">
                  <label className="search-field"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索环境" /><kbd>⌘ K</kbd></label>
                  <button className="subtle-button" title="重新扫描" onClick={() => void refresh(true)} disabled={refreshing}><RefreshCw size={15} /></button>
                </div>
              </div>

              <div className="environment-layout">
                <div className="environment-table-wrap">
                  <table className="environment-table">
                    <thead><tr><th>环境名称</th><th>Python</th><th>软件包</th><th>磁盘占用</th><th>位置</th><th aria-label="操作" /></tr></thead>
                    <tbody>
                      {loading ? <tr><td colSpan={6} className="table-state"><LoaderCircle className="spin" size={19} />正在读取环境…</td></tr> : visibleEnvironments.map((environment) => (
                        <tr key={`${environment.instanceId}:${environment.prefix}`} className={selected?.prefix === environment.prefix ? 'selected' : ''} onClick={() => setSelected(environment)}>
                          <td><div className="environment-name"><div className={`env-icon ${environment.isBase ? 'env-base' : ''}`}>{environment.isBase ? <Command size={15} /> : <Box size={15} />}</div><div><strong>{environment.name ?? '未命名环境'}</strong><span>{environment.isBase ? '基础环境' : 'Conda 环境'}</span></div>{environment.isBase && <span className="base-tag">BASE</span>}</div></td>
                          <td><span className="python-tag">{environment.pythonVersion ? `Python ${environment.pythonVersion}` : '—'}</span></td>
                          <td className="package-count">{environment.packageCount ?? '—'} <span>个</span></td>
                          <td className="package-count size-cell">{formatBytes(environment.sizeBytes)}</td>
                          <td><span className="path-cell" title={environment.prefix}><FolderOpen size={14} />{environment.prefix}</span></td>
                          <td><button className="row-menu" title="更多操作" onClick={(event) => event.stopPropagation()}><MoreHorizontal size={17} /></button></td>
                        </tr>
                      ))}
                      {!loading && visibleEnvironments.length === 0 && <tr><td colSpan={6} className="table-empty"><Database size={22} /><strong>{environments.length ? '没有匹配的环境' : '尚未发现 Conda 环境'}</strong><span>{environments.length ? '尝试其他搜索关键词。' : '请检查 Conda 安装，或重新扫描。'}</span></td></tr>}
                    </tbody>
                  </table>
                  <div className="table-footer"><span>共 {environments.length} 个环境</span><span className="sync-status"><span />已同步</span></div>
                </div>

                <aside className="detail-panel">
                  {selected ? <>
                    <div className="detail-topline"><span>环境详情</span><button className="row-menu" title="环境操作"><MoreHorizontal size={17} /></button></div>
                    <div className="detail-identity"><div className={`detail-env-icon ${selected.isBase ? 'env-base' : ''}`}>{selected.isBase ? <Command size={20} /> : <Box size={20} />}</div><div><h3>{selected.name ?? '未命名环境'}</h3><span className="detail-ready"><i />运行正常</span></div></div>
                    <div className="detail-path"><span>环境路径</span><div title={selected.prefix}>{selected.prefix}<button title="打开环境目录"><ExternalLink size={13} /></button></div></div>
                    <div className="detail-specs"><div><span>Python 版本</span><strong>{selected.pythonVersion ?? '未知'}</strong></div><div><span>平台</span><strong>{selected.platform ?? activeInstance?.platform ?? '未知'}</strong></div><div><span>已安装包</span><strong>{selected.packageCount ?? '—'} 个</strong></div><div><span>环境类型</span><strong>{selected.isBase ? 'Base' : '用户环境'}</strong></div><div><span>磁盘占用</span><strong>{formatBytes(selected.sizeBytes)}</strong></div></div>
                    <div className="detail-divider" />
                    <div className="package-heading"><div><h4>已安装软件包</h4><span>{packages.length} 个主要包</span></div><button title="导出依赖" onClick={() => void handleExport()} disabled={busyAction}><ArrowDownToLine size={15} /></button></div>
                    <label className="package-search"><Search size={14} /><input value={packageQuery} onChange={(event) => setPackageQuery(event.target.value)} placeholder="搜索软件包" /></label>
                    <div className="package-list">{visiblePackages.map((item) => <div className="package-row" key={item.name}><div className="package-symbol"><Package size={14} /></div><div className="package-info"><strong>{item.name}</strong><span>{item.packageType === 'pip' ? 'PyPI' : item.channel ?? 'Conda'}</span></div><code>{item.version}</code></div>)}{visiblePackages.length === 0 && <div className="package-empty">没有匹配的软件包</div>}</div>
                    <div className="detail-actions"><button title="激活环境并打开 PowerShell 窗口" onClick={() => void handleOpenTerminal()}><TerminalSquare size={15} />激活终端</button><button title="导出依赖" onClick={() => void handleExport()} disabled={busyAction}><ArrowDownToLine size={15} />导出</button><button title="删除环境" onClick={() => setConfirmDelete(true)} disabled={selected.isBase || busyAction}><Trash2 size={15} />删除</button></div>
                  </> : <div className="detail-empty"><Database size={24} /><span>选择一个环境查看详情</span></div>}
                </aside>
              </div>
            </section>

            <footer className="app-footer"><span><span className="footer-dot" />{activeInstance ? `${activeInstance.kind} ${activeInstance.version}` : '未连接 Conda'}</span><span>{activeInstance?.rootPrefix ?? '未检测到安装路径'}</span><button title="设置" onClick={() => setView('settings')}><Settings2 size={14} /></button></footer>
          </div>
        )}
      </main>

      {showCreate && activeInstance && <CreateEnvironmentDialog instanceId={activeInstance.id} onClose={() => setShowCreate(false)} onCreated={() => void refresh()} />}

      {showExport && <ExportDialog yaml={exportYaml} onClose={() => setShowExport(false)} />}

      {confirmDelete && selected && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmDelete(false); }}>
          <section className="confirm-dialog" role="alertdialog" aria-modal="true">
            <div className="confirm-icon"><Trash2 size={22} /></div>
            <h2>删除环境</h2>
            <p>确定要删除环境 <strong>{selected.name ?? '未命名环境'}</strong> 吗？此操作不可撤销，将删除以下目录：</p>
            <code className="confirm-path">{selected.prefix}</code>
            <div className="dialog-footer">
              <button className="secondary-button" onClick={() => setConfirmDelete(false)} disabled={busyAction}>取消</button>
              <button className="danger-button" onClick={() => void handleDelete()} disabled={busyAction}>{busyAction ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={15} />}删除</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity, AlertCircle, ArrowDownToLine, Box, Check, ChevronDown,
  ChevronRight, CircleHelp, Clipboard, Command, Copy, Cpu, Database,
  Download, ExternalLink, FileCode2, FolderOpen, GitBranch, HardDrive, Layers3,
  LoaderCircle, MoreHorizontal, Moon, Package, Plus, RefreshCw, Search,
  Settings2, ShieldCheck, Sparkles, Sun, TerminalSquare, Trash2, Upload, X,
} from 'lucide-react';
import {
  addChannel, activateEnvironment, buildOfflineChannel, buildWheelhouse,
  cancelJob, cleanCache,
  condaPackEnvironment, exportEnvironmentYaml, exportEnvironmentYamlToFile,
  exportExplicitSpecToFile, getChannels, getDiagnostics, getInstallInfo,
  importEnvironmentYaml, launchInstaller, listEnvironments, listInstances,
  listJobs, listPackages, listPackageVersions, onJobEvent,
  openEnvironmentDirectory, openEnvironmentTerminal, parseYamlPreview,
  pickDirectory, pickSaveFile,
  pickYamlFile, planCreateEnvironment, planInstallPackages, planRemovePackages,
  rediscover, removeChannel, searchPackages, setDefaultInstance,
  startCloneEnvironment, startCreateEnvironment, startDeleteEnvironment,
  startDownloadInstaller, startInstallPackages, startRemovePackages,
  testChannelConnectivity,
} from './lib/conda';
import type {
  ChannelInfo, ChannelTestResult, CondaInstance, DiagnosticReport,
  EnvironmentSummary, InstallInfo, JobSnapshot, OperationPlan, PackageRecord,
  SearchResult, YamlPreview,
} from './types';
import { applyTheme, getInitialTheme, persistTheme, type Theme } from './main';

type View = 'environments' | 'tasks' | 'packages' | 'settings' | 'install' | 'help';

const VIEW_META: Record<View, { label: string; icon: typeof Box }> = {
  environments: { label: '环境管理', icon: Box },
  tasks: { label: '操作日志', icon: Activity },
  packages: { label: '库依赖管理', icon: Package },
  settings: { label: '设置', icon: Settings2 },
  install: { label: '安装 Conda', icon: Download },
  help: { label: '帮助', icon: CircleHelp },
};

const PRIMARY_NAV: View[] = ['environments', 'packages'];
const SECONDARY_NAV: View[] = ['settings', 'install', 'help', 'tasks'];

const APP_VERSION = '1.0.0';

const OPERATION_LABEL: Record<string, string> = {
  create_environment: '创建环境',
  delete_environment: '删除环境',
  install_packages: '安装包',
  remove_packages: '卸载包',
  clone_environment: '克隆环境',
  import_environment: '导入 YAML',
  import_explicit: '导入 explicit spec',
  clean_cache: '清理缓存',
  clean_packages: '清理缓存包',
  clean_tarballs: '清理下载包',
  build_offline_channel: '离线包仓库',
  build_wheelhouse: '构建 wheelhouse',
  conda_pack: 'conda-pack 打包',
  download_installer: '下载安装器',
};

const JOB_STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  cancel_requested: '取消中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

const PLAN_ACTION_LABEL: Record<string, string> = {
  install: '安装',
  remove: '移除',
  update: '更新',
  downgrade: '降级',
  unknown: '变更',
};

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

function applyJobEvent(current: JobSnapshot | undefined, event: { id: number; kind: string; target: string; status: string; summary: string; error: string | null; environmentPrefix: string | null; stage: string | null; createdAt: number; startedAt: number | null; finishedAt: number | null; logLine: string | null }): JobSnapshot {
  const log = current ? current.log : [];
  if (event.logLine) log.push(event.logLine);
  return {
    id: event.id,
    kind: event.kind,
    target: event.target,
    status: event.status,
    summary: event.summary,
    error: event.error,
    environmentPrefix: event.environmentPrefix,
    stage: event.stage,
    createdAt: event.createdAt,
    startedAt: event.startedAt,
    finishedAt: event.finishedAt,
    log,
  };
}

// ---------- 求解计划预览对话框 ----------
function PlanDialog({ plan, title, confirming, onConfirm, onCancel }: {
  plan: OperationPlan;
  title: string;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="create-dialog" role="dialog" aria-modal="true">
        <div className="dialog-header">
          <div>
            <span className="dialog-kicker"><ShieldCheck size={14} /> 变更预览</span>
            <h2>{title}</h2>
            <p>以下是 Conda 求解器给出的变更计划，请确认后执行。</p>
          </div>
          <button className="icon-button" onClick={onCancel} aria-label="关闭"><X size={17} /></button>
        </div>
        <div className="dialog-fields">
          {!plan.supported && (
            <div className="dialog-error"><AlertCircle size={15} />预览不可用，将直接执行并确认。</div>
          )}
          {plan.warnings.map((warning, index) => (
            <div className="dialog-note" key={index}><AlertCircle size={15} /><span>{warning}</span></div>
          ))}
          {plan.changes.length > 0 ? (
            <div className="plan-section">
              <div className="plan-section-title">变更 {plan.changes.length} 项</div>
              <ul className="plan-list">
                {plan.changes.map((change, index) => (
                  <li key={`${change.name}-${index}`}>
                    <span className={`plan-badge ${change.action}`}>{PLAN_ACTION_LABEL[change.action] ?? change.action}</span>
                    <strong>{change.name}</strong>
                    <code>
                      {change.action === 'update'
                        ? `${change.fromVersion ?? '?'} → ${change.toVersion ?? '?'}`
                        : change.toVersion ?? change.fromVersion ?? ''}
                    </code>
                    {change.channel && <span className="plan-channel">{change.channel}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="result-empty">无需要变更的包</div>
          )}
          {plan.downloads.length > 0 && (
            <div className="plan-section">
              <div className="plan-section-title">将下载 {plan.downloads.length} 个包{plan.fetchBytes != null ? `（约 ${formatBytes(plan.fetchBytes)}）` : ''}</div>
              <ul className="plan-list compact">
                {plan.downloads.slice(0, 20).map((download, index) => (
                  <li key={`${download.name}-${index}`}><strong>{download.name}</strong><code>{download.version ?? ''}</code>{download.size != null && <span className="plan-channel">{formatBytes(download.size)}</span>}</li>
                ))}
                {plan.downloads.length > 20 && <li className="result-empty">…另有 {plan.downloads.length - 20} 个</li>}
              </ul>
            </div>
          )}
        </div>
        <div className="dialog-footer">
          <button className="secondary-button" onClick={onCancel} disabled={confirming}>取消</button>
          <button className="primary-button" onClick={onConfirm} disabled={confirming}>
            {confirming ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
            {confirming ? '提交中…' : '确认执行'}
          </button>
        </div>
      </section>
    </div>
  );
}

// ---------- 新建环境对话框（含求解预览） ----------
function CreateEnvironmentDialog({ instanceId, onClose, onCreated }: {
  instanceId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [pythonVersion, setPythonVersion] = useState('3.12');
  const [packagesText, setPackagesText] = useState('');
  const [channel, setChannel] = useState('');
  const [plan, setPlan] = useState<OperationPlan | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  function buildRequest() {
    return {
      name: name.trim(),
      pythonVersion: pythonVersion || null,
      packages: packagesText.split(/\s+/).filter(Boolean),
      channels: channel ? [channel] : [],
    };
  }

  async function preview() {
    if (!name.trim()) { setError('请输入环境名称'); return; }
    setSubmitting(true);
    setError('');
    try { setPlan(await planCreateEnvironment(instanceId, buildRequest())); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '求解预览失败'); }
    finally { setSubmitting(false); }
  }

  async function confirm() {
    setSubmitting(true);
    setError('');
    try {
      await startCreateEnvironment(instanceId, buildRequest());
      onCreated();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建环境失败');
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      {plan ? (
        <PlanDialog plan={plan} title="创建环境" confirming={submitting} onConfirm={() => void confirm()} onCancel={() => setPlan(null)} />
      ) : (
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
            <div className="dialog-note"><ShieldCheck size={16} /><span>将先执行 dry-run 求解预览，确认后才会真正创建。</span></div>
          </div>
          <div className="dialog-footer">
            <button className="secondary-button" onClick={onClose} disabled={submitting}>取消</button>
            <button className="primary-button" onClick={() => void preview()} disabled={submitting}>
              {submitting ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}
              {submitting ? '求解中…' : '预览求解'}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

// ---------- 导出对话框 ----------
function ExportDialog({ yaml, onClose, onSave }: { yaml: string; onClose: () => void; onSave: (yaml: string) => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(yaml); setCopied(true); } catch { /* ignore */ }
  }
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="create-dialog export-dialog" role="dialog" aria-modal="true">
        <div className="dialog-header">
          <div><span className="dialog-kicker"><ArrowDownToLine size={14} /> 导出依赖</span><h2>environment.yml</h2><p>复制内容或保存为文件，用于在其他机器上重建环境。</p></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button>
        </div>
        <div className="export-body">
          <div className="export-actions">
            <button className="copy-button" onClick={() => void copy()}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? '已复制' : '复制内容'}</button>
            <button className="secondary-button" onClick={() => onSave(yaml)}><ArrowDownToLine size={15} />保存到文件</button>
          </div>
          <pre>{yaml}</pre>
        </div>
        <div className="dialog-footer">
          <button className="secondary-button" onClick={onClose}>关闭</button>
        </div>
      </section>
    </div>
  );
}

// ---------- 导入对话框 ----------
function ImportDialog({ instanceId, onClose, onImported }: {
  instanceId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [preview, setPreview] = useState<YamlPreview | null>(null);
  const [targetName, setTargetName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function pick() {
    setError('');
    const path = await pickYamlFile();
    if (!path) return;
    setSource(path);
    setPreview(null);
    try { setPreview(await parseYamlPreview(path)); } catch (cause) { setError(cause instanceof Error ? cause.message : '解析失败'); }
  }

  async function submit() {
    if (!source) return;
    setBusy(true);
    setError('');
    try {
      await importEnvironmentYaml(instanceId, source, targetName || undefined);
      onImported();
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '导入失败'); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="create-dialog" role="dialog" aria-modal="true">
        <div className="dialog-header">
          <div><span className="dialog-kicker"><Upload size={14} /> 导入环境</span><h2>导入 environment.yml</h2><p>从 YAML 文件创建环境。</p></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button>
        </div>
        <div className="dialog-fields">
          <button className="secondary-button" onClick={() => void pick()}><FolderOpen size={15} />选择 YAML 文件</button>
          {source && <div className="dialog-note"><FileCode2 size={15} /><span>{source}</span></div>}
          {preview && preview.parsed && (
            <div className="plan-section">
              <div className="plan-section-title">解析预览</div>
              <div className="dialog-note"><span>环境名：{preview.name ?? '（未指定）'}　渠道：{preview.channels.join(', ') || '（默认）'}　依赖 {preview.dependencies.length} 项</span></div>
              <ul className="plan-list compact">
                {preview.dependencies.slice(0, 20).map((dependency, index) => <li key={index}><strong>{dependency}</strong></li>)}
                {preview.dependencies.length > 20 && <li className="result-empty">…另有 {preview.dependencies.length - 20} 项</li>}
              </ul>
            </div>
          )}
          {preview && !preview.parsed && <div className="dialog-error"><AlertCircle size={15} />{preview.error}</div>}
          <label>目标环境名 <span className="optional-label">可选</span>
            <input value={targetName} onChange={(event) => setTargetName(event.target.value)} placeholder="留空则使用 YAML 中的名称" />
          </label>
          {error && <div className="dialog-error"><AlertCircle size={15} />{error}</div>}
        </div>
        <div className="dialog-footer">
          <button className="secondary-button" onClick={onClose} disabled={busy}>取消</button>
          <button className="primary-button" onClick={() => void submit()} disabled={busy || !source}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />}导入
          </button>
        </div>
      </section>
    </div>
  );
}

// ---------- 克隆对话框 ----------
function CloneDialog({ instanceId, sourcePrefix, sourceName, onClose, onCloned }: {
  instanceId: string;
  sourcePrefix: string;
  sourceName: string;
  onClose: () => void;
  onCloned: () => void;
}) {
  const [targetName, setTargetName] = useState(`${sourceName}-clone`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (!targetName.trim()) { setError('请输入目标环境名'); return; }
    setBusy(true);
    setError('');
    try {
      await startCloneEnvironment(instanceId, sourcePrefix, targetName.trim());
      onCloned();
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '克隆失败'); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="create-dialog" role="dialog" aria-modal="true">
        <div className="dialog-header">
          <div><span className="dialog-kicker"><GitBranch size={14} /> 克隆环境</span><h2>克隆「{sourceName}」</h2><p>创建当前环境的一份拷贝。</p></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button>
        </div>
        <div className="dialog-fields">
          <label>目标环境名
            <input autoFocus value={targetName} onChange={(event) => setTargetName(event.target.value)} />
          </label>
          {error && <div className="dialog-error"><AlertCircle size={15} />{error}</div>}
        </div>
        <div className="dialog-footer">
          <button className="secondary-button" onClick={onClose} disabled={busy}>取消</button>
          <button className="primary-button" onClick={() => void submit()} disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <GitBranch size={16} />}克隆
          </button>
        </div>
      </section>
    </div>
  );
}

// ---------- 任务中心 ----------
function JobRow({ job, onCancel }: { job: JobSnapshot; onCancel: (id: number) => void }) {
  const [expanded, setExpanded] = useState(false);
  const cancellable = job.status === 'queued' || job.status === 'running' || job.status === 'cancel_requested';
  return (
    <li className="task-row">
      <div className={`task-status ${job.status}`} />
      <div className="task-main">
        <strong>{OPERATION_LABEL[job.kind] ?? job.kind}</strong>
        <span>{job.target}</span>
      </div>
      <div className="task-summary">
        {job.status === 'failed' && job.error ? job.error : job.summary}
      </div>
      <div className="task-meta">
        <span className={`job-status-label ${job.status}`}>{JOB_STATUS_LABEL[job.status] ?? job.status}</span>
        <span>{formatTime(job.startedAt ?? job.createdAt)}</span>
      </div>
      <div className="task-actions">
        {cancellable && <button className="mini-button danger" onClick={() => onCancel(job.id)}>取消</button>}
        {job.log.length > 0 && <button className="mini-button" onClick={() => setExpanded((value) => !value)}>{expanded ? '收起' : '日志'}</button>}
      </div>
      {expanded && <pre className="job-log">{job.log.join('\n')}</pre>}
    </li>
  );
}

function TasksView({ jobs, onCancel }: { jobs: JobSnapshot[]; onCancel: (id: number) => void }) {
  return (
    <div className="page-content">
      <section className="page-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" /> 历史记录</div><h1>操作日志</h1><p>查看创建、删除、安装等操作的执行状态、日志与历史。</p></div>
      </section>
      <section className="tasks-card">
        {jobs.length === 0 ? (
          <div className="tasks-empty"><Clipboard size={28} /><strong>暂无操作日志</strong><span>创建环境、安装包等操作会实时显示在这里。</span></div>
        ) : (
          <ul className="task-list">
            {jobs.map((job) => <JobRow key={job.id} job={job} onCancel={onCancel} />)}
          </ul>
        )}
      </section>
      <footer className="app-footer"><span><span className="footer-dot" />操作日志保存在本机</span></footer>
    </div>
  );
}

// ---------- 库依赖管理 ----------
function PackagesView({ instance, environments, packagesVersion }: {
  instance?: CondaInstance;
  environments: EnvironmentSummary[];
  packagesVersion: number;
}) {
  const [selectedEnv, setSelectedEnv] = useState<EnvironmentSummary | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [installed, setInstalled] = useState<PackageRecord[]>([]);
  const [installedQuery, setInstalledQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [upgradeTarget, setUpgradeTarget] = useState<PackageRecord | null>(null);
  const [versions, setVersions] = useState<SearchResult[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeVersion, setUpgradeVersion] = useState('');
  const [plan, setPlan] = useState<OperationPlan | null>(null);
  const [planAction, setPlanAction] = useState<{ packages: string[]; title: string } | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (environments.length === 0) { setSelectedEnv(null); return; }
    setSelectedEnv((current) => environments.find((env) => env.prefix === current?.prefix) ?? environments[0]);
  }, [environments]);

  useEffect(() => {
    if (!instance || !selectedEnv) { setInstalled([]); return; }
    let alive = true;
    void listPackages(selectedEnv.instanceId, selectedEnv.prefix)
      .then((result) => { if (alive) setInstalled(result); })
      .catch((cause: unknown) => { if (alive) setError(cause instanceof Error ? cause.message : '无法读取包列表'); });
    return () => { alive = false; };
  }, [instance, selectedEnv, packagesVersion]);

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
    setError('');
    try { setPlan(await planInstallPackages(instance.id, selectedEnv.prefix, [name])); setPlanAction({ packages: [name], title: `安装 ${name}` }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '预览失败'); }
  }

  async function remove(name: string) {
    if (!instance || !selectedEnv) return;
    setError('');
    try { setPlan(await planRemovePackages(instance.id, selectedEnv.prefix, [name])); setPlanAction({ packages: [name], title: `卸载 ${name}` }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '预览失败'); }
  }

  async function confirmPlan() {
    if (!instance || !selectedEnv || !planAction) return;
    setConfirming(true);
    setError('');
    try {
      if (planAction.title.startsWith('卸载')) {
        await startRemovePackages(instance.id, selectedEnv.prefix, planAction.packages);
      } else {
        await startInstallPackages(instance.id, selectedEnv.prefix, planAction.packages);
      }
      setPlan(null);
      setPlanAction(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '提交失败'); }
    finally { setConfirming(false); }
  }

  async function openUpgrade(target: PackageRecord) {
    if (!instance || !selectedEnv) return;
    setUpgradeTarget(target);
    setUpgradeVersion('');
    setVersions([]);
    setLoadingVersions(true);
    setError('');
    try { setVersions(await listPackageVersions(instance.id, target.name)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '读取版本失败'); }
    finally { setLoadingVersions(false); }
  }

  async function upgrade(spec: string) {
    if (!instance || !selectedEnv || !upgradeTarget) return;
    setUpgrading(true);
    setError('');
    try {
      await startInstallPackages(instance.id, selectedEnv.prefix, [spec]);
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
        <div><div className="eyebrow"><span className="eyebrow-line" /> 依赖管理</div><h1>库依赖管理</h1><p>选择环境查看已安装软件包，或搜索并安装新的依赖。</p></div>
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
                <button className="mini-button danger" onClick={(event) => { event.stopPropagation(); void remove(item.name); }} disabled={selectedEnv?.isBase}><Trash2 size={14} />卸载</button>
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
                <button className="mini-button" onClick={() => void install(result.name)} disabled={!selectedEnv}><Plus size={14} />安装</button>
              </li>
            ))}
            {!searching && results.length === 0 && <li className="result-empty">输入包名后点击搜索</li>}
          </ul>
        </section>
      </div>
      <footer className="app-footer"><span><span className="footer-dot" />{instance.kind} {instance.version}</span><span>安装操作会应用到所选环境「{installedName}」</span></footer>

      {plan && planAction && (
        <PlanDialog plan={plan} title={planAction.title} confirming={confirming} onConfirm={() => void confirmPlan()} onCancel={() => setPlan(null)} />
      )}

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
                      <button key={`${item.version}-${item.channel}`} className={`version-option ${upgradeVersion === item.version ? 'selected' : ''}`} onClick={() => setUpgradeVersion(item.version)}>
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

function SettingsView({ instance, onJobStarted, theme, onThemeChange }: {
  instance?: CondaInstance;
  onJobStarted: () => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}) {
  const [channels, setChannels] = useState<ChannelInfo | null>(null);
  const [newChannel, setNewChannel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [testResults, setTestResults] = useState<Record<string, ChannelTestResult>>({});
  const [testingAll, setTestingAll] = useState(false);
  const [testingChannel, setTestingChannel] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticReport | null>(null);
  const [loadingDiagnostics, setLoadingDiagnostics] = useState(false);
  const [cleaning, setCleaning] = useState<string | null>(null);
  const [cleanMsg, setCleanMsg] = useState('');

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

  async function runDiagnostics() {
    if (!instance) return;
    setLoadingDiagnostics(true);
    setError('');
    try { setDiagnostics(await getDiagnostics(instance.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '诊断失败'); }
    finally { setLoadingDiagnostics(false); }
  }

  async function clean(kind: string) {
    if (!instance) return;
    setError('');
    setCleanMsg('');
    setCleaning(kind);
    try {
      await cleanCache(instance.id, kind);
      setCleanMsg(kind === 'packages'
        ? '已提交「清理缓存包」任务，可在操作日志查看进度。'
        : '已提交「清理下载包」任务，可在操作日志查看进度。');
      onJobStarted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '清理失败');
    } finally {
      setCleaning(null);
    }
  }

  if (!instance) {
    return <div className="page-content"><div className="placeholder-card"><div className="placeholder-icon"><Settings2 size={26} /></div><h1>未发现 Conda</h1><p>请先在环境管理页扫描并选择 Conda 实例。</p></div></div>;
  }

  return (
    <div className="page-content">
      <section className="page-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" /> 源与配置</div><h1>设置</h1><p>管理 Conda 下载源（渠道）、缓存与实例配置。</p></div>
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
                    {testingChannel === channel ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}测试
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
        <section className="settings-card">
          <div className="settings-card-head"><h2>缓存与诊断</h2><p>清理当前所选实例的 Conda 包缓存，或生成脱敏诊断报告</p></div>
          <div className="channel-add">
            <button className="secondary-button" onClick={() => void clean('tarballs')} disabled={cleaning !== null}>
              {cleaning === 'tarballs' ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}
              清理下载包
            </button>
            <button className="secondary-button" onClick={() => void clean('packages')} disabled={cleaning !== null}>
              {cleaning === 'packages' ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}
              清理缓存包
            </button>
            <button className="secondary-button" onClick={() => void runDiagnostics()} disabled={loadingDiagnostics}>{loadingDiagnostics ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}诊断报告</button>
          </div>
          <div className="install-body" style={{ paddingTop: 0 }}>
            <p className="install-desc" style={{ marginBottom: 8 }}>
              清理作用于当前所选实例（{instance.runtime.startsWith('wsl:') ? `WSL · ${instance.runtime.slice(4)}` : '本地 Windows'}）的 Conda 包缓存目录，为所有环境共享，并非删除某个环境：
              「清理下载包」删除已下载的 .conda/.tar.bz2 压缩包；「清理缓存包」删除已解压但未被任何环境引用的包。
            </p>
            {cleanMsg && <div className="dialog-note"><Check size={15} /><span>{cleanMsg}</span></div>}
          </div>
          {diagnostics && (
            <div className="diagnostics-list">
              {diagnostics.sections.map((section, index) => (
                <div className="diagnostic-section" key={index}>
                  <div className="plan-section-title">{section.title}</div>
                  <pre className="diagnostic-content">{section.content}</pre>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="settings-card">
          <div className="settings-card-head"><h2>外观</h2><p>选择明亮或暗色主题</p></div>
          <div className="theme-picker">
            <button className={`theme-option ${theme === 'light' ? 'active' : ''}`} onClick={() => onThemeChange('light')}>
              <Sun size={16} />明亮
            </button>
            <button className={`theme-option ${theme === 'dark' ? 'active' : ''}`} onClick={() => onThemeChange('dark')}>
              <Moon size={16} />暗色
            </button>
          </div>
        </section>
      </div>
      <footer className="app-footer"><span><span className="footer-dot" />渠道修改会写入 Conda 用户配置</span></footer>
    </div>
  );
}

// ---------- 帮助 ----------
// ---------- 安装引导 ----------
function InstallView({ instances, jobs, onRefresh }: {
  instances: CondaInstance[];
  jobs: JobSnapshot[];
  onRefresh: (force: boolean) => Promise<void>;
}) {
  const [info, setInfo] = useState<InstallInfo | null>(null);
  const [installerPath, setInstallerPath] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string>('');
  const [downloading, setDownloading] = useState(false);
  const [launched, setLaunched] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void getInstallInfo().then((result) => {
      setInfo(result);
      setSourceId((result.sources.find((source) => source.recommended) ?? result.sources[0])?.id ?? '');
    }).catch(() => {});
  }, []);

  const hasConda = instances.length > 0;
  const latestDownload = jobs.find((job) => job.kind === 'download_installer');
  const downloadFailed = latestDownload?.status === 'failed';
  const activeSource = info?.sources.find((source) => source.id === sourceId) ?? info?.sources[0];

  async function download() {
    setError('');
    if (!activeSource) return;
    const path = await pickSaveFile(info?.filename ?? 'Miniforge3-Windows-x86_64.exe', ['exe']);
    if (!path) return;
    setInstallerPath(path);
    setDownloading(true);
    setLaunched(false);
    try {
      await startDownloadInstaller(path, activeSource.downloadUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '下载失败');
    } finally {
      setDownloading(false);
    }
  }

  async function launch() {
    if (!installerPath) return;
    setError('');
    try {
      await launchInstaller(installerPath);
      setLaunched(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '启动安装器失败');
    }
  }

  const statusText = latestDownload
    ? JOB_STATUS_LABEL[latestDownload.status] ?? latestDownload.status
    : null;

  return (
    <div className="page-content">
      <section className="page-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" /> 初始化</div><h1>安装 Conda</h1><p>为没有 Conda 的电脑安装一个轻量的 Conda 发行版。</p></div>
      </section>

      {error && <div className="error-banner"><AlertCircle size={17} /><span>{error}</span><button onClick={() => setError('')}><X size={15} /></button></div>}

      {hasConda && (
        <div className="dialog-note" style={{ marginBottom: 16 }}>
          <ShieldCheck size={16} />
          <span>已检测到 {instances.length} 个 Conda 安装，无需重新安装。可在环境管理页使用。</span>
        </div>
      )}

      <div className="settings-layout">
        <section className="settings-card">
          <div className="settings-card-head"><h2>推荐：{info?.name ?? 'Miniforge'}</h2><p>轻量、开源、默认 conda-forge 渠道</p></div>
          <div className="install-body">
            <p className="install-desc">{info?.description ?? '正在加载安装信息…'}</p>
            <ul className="instance-list">
              <li><span>发行版</span><strong>{info?.name ?? '—'}</strong></li>
              <li><span>版本</span><strong>{info?.version ?? '—'}</strong></li>
              <li><span>架构</span><strong>{info?.arch ?? '—'}</strong></li>
              <li><span>许可证</span><strong>{info?.license ?? '—'}</strong></li>
              <li><span>可选下载源</span><strong>{info?.sources.length ?? 0} 个</strong></li>
            </ul>
          </div>
        </section>

        <section className="settings-card">
          <div className="settings-card-head"><h2>安装步骤</h2><p>下载 → 运行安装器 → 重新扫描</p></div>
          <div className="install-body">
            <ol className="install-steps">
              <li className={installerPath ? 'done' : ''}>
                <span className="install-step-index">1</span>
                <div>
                  <strong>下载安装器</strong>
                  <p>选择下载源后，将 Miniforge 安装器下载到本地。</p>
                  <div className="install-source-row">
                    <div className="env-select-wrap">
                      <Download size={15} />
                      <select value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
                        {(info?.sources ?? []).map((source) => (
                          <option key={source.id} value={source.id}>{source.label}{source.recommended ? '（推荐）' : ''}</option>
                        ))}
                      </select>
                      <ChevronDown size={14} />
                    </div>
                    <button className="primary-button" onClick={() => void download()} disabled={downloading || !activeSource}>
                      {downloading ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
                      {downloading ? '下载中…' : '下载'}
                    </button>
                  </div>
                  {activeSource && <div className="dialog-note"><span>来源：{activeSource.downloadUrl}</span></div>}
                  {installerPath && <div className="dialog-note"><FileCode2 size={15} /><span>{installerPath}</span></div>}
                </div>
              </li>
              <li className={installerPath ? '' : 'locked'}>
                <span className="install-step-index">2</span>
                <div>
                  <strong>运行安装器</strong>
                  <p>安装器会引导你选择安装位置并完成安装（可能需要管理员权限，由安装器自行处理）。</p>
                  <button className="primary-button" onClick={() => void launch()} disabled={!installerPath || (latestDownload?.status === 'running')}>
                    <ExternalLink size={16} />运行安装器
                  </button>
                  {launched && <div className="dialog-note"><Check size={15} /><span>已启动安装器，请在新窗口中完成安装。</span></div>}
                </div>
              </li>
              <li className={hasConda ? 'done' : ''}>
                <span className="install-step-index">3</span>
                <div>
                  <strong>重新扫描</strong>
                  <p>安装完成后重新扫描本机，识别新的 Conda 实例。</p>
                  <button className="secondary-button" onClick={() => void onRefresh(true)}><RefreshCw size={15} />重新扫描</button>
                </div>
              </li>
            </ol>
            {statusText && (
              <div className="dialog-note">
                <span>下载状态：{statusText}{downloadFailed && latestDownload?.error ? ` — ${latestDownload.error}` : ''}</span>
              </div>
            )}
          </div>
        </section>
      </div>

      <footer className="app-footer"><span><span className="footer-dot" />不会自动下载或提权，安装过程由你手动控制</span></footer>
    </div>
  );
}

function HelpView() {
  return (
    <div className="page-content">
      <section className="page-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" /> 使用说明</div><h1>帮助</h1><p>了解 Easy Conda 的功能与常见问题。</p></div>
      </section>
      <div className="help-list">
        <div className="help-card">
          <h3>运行目标（本机 / WSL）</h3>
          <p>顶栏的下拉菜单可切换要管理的 Conda 运行目标：本地 Windows 或已安装的 WSL 发行版（如 Ubuntu）。切换后环境列表会立即清空并重新加载，环境管理标题右侧会显示当前目标。</p>
        </div>
        <div className="help-card">
          <h3>环境管理</h3>
          <p>集中查看、搜索和排序所有环境。选中环境可在右侧详情面板查看路径、Python 版本、包数、磁盘占用与激活状态。支持新建、克隆、导入、删除环境；删除 base 或已激活环境会被拦截，危险操作会二次确认。</p>
        </div>
        <div className="help-card">
          <h3>激活环境与终端</h3>
          <p>点击详情面板的「激活环境并打开终端」可把该环境设为当前激活环境，并打开对应终端（Windows 用 PowerShell，WSL 用 bash）。列表中已激活的环境会显示绿色「已激活」标记。</p>
        </div>
        <div className="help-card">
          <h3>库依赖管理</h3>
          <p>选择环境后查看已安装包，或按名称搜索新包。安装、卸载、升级前都会先执行 dry-run 求解预览，展示将增删的包与下载体积，确认后才真正执行。</p>
        </div>
        <div className="help-card">
          <h3>创建环境</h3>
          <p>填写环境名、选择 Python 版本与下载源、可添加初始依赖。点击「预览求解」会生成变更计划，确认后才会真正创建。</p>
        </div>
        <div className="help-card">
          <h3>导入 / 导出</h3>
          <p>导出 environment.yml（跨平台依赖规格）或 explicit spec（精确重建）；也可从 YAML 文件导入环境。导出可复制内容或保存为文件。</p>
        </div>
        <div className="help-card">
          <h3>下载源（渠道）</h3>
          <p>在「设置」页查看、添加、移除渠道，支持清华等国内镜像快捷添加，并可测试各渠道连通性与延迟。</p>
        </div>
        <div className="help-card">
          <h3>离线交付</h3>
          <p>支持三种导出：离线包仓库（Conda 包 + explicit spec）、pip wheelhouse（仅覆盖 pip 依赖）、conda-pack 归档（需环境内已装 conda-pack）。注意 wheelhouse 不包含 Conda 包。</p>
        </div>
        <div className="help-card">
          <h3>操作日志</h3>
          <p>创建、删除、安装、导入等操作都会生成记录，实时展示状态、阶段与脱敏日志，运行中的操作可取消。</p>
        </div>
        <div className="help-card">
          <h3>诊断与缓存</h3>
          <p>「设置」页可清理 Conda 缓存（下载包/缓存包），或生成脱敏诊断报告（实例信息、渠道连通性、环境清单）用于排查问题。</p>
        </div>
        <div className="help-card">
          <h3>外观主题</h3>
          <p>顶栏或「设置」页可切换明亮 / 暗色主题，偏好会自动保存，下次启动保持。</p>
        </div>
        <div className="help-card">
          <h3>安装 Conda</h3>
          <p>未检测到 Conda 时自动进入「安装 Conda」引导，可选择清华等国内镜像下载 Miniforge 安装器，下载完成后手动运行安装，再重新扫描。</p>
        </div>
      </div>
      <footer className="app-footer"><span><span className="footer-dot" />Easy Conda 0.2.0</span></footer>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>('environments');
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());
  const [instances, setInstances] = useState<CondaInstance[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentSummary[]>([]);
  const [packages, setPackages] = useState<PackageRecord[]>([]);
  const [jobs, setJobs] = useState<JobSnapshot[]>([]);
  const [packagesVersion, setPackagesVersion] = useState(0);
  const [selected, setSelected] = useState<EnvironmentSummary | null>(null);
  const [query, setQuery] = useState('');
  const [packageQuery, setPackageQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [exportYaml, setExportYaml] = useState('');
  const [showClone, setShowClone] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [targetMenuOpen, setTargetMenuOpen] = useState(false);
  // 标记是否已完成首次启动检测，用于「无 Conda 时自动跳转安装引导」且只跳一次。
  const initialCheckDone = useRef(false);

  function changeTheme(next: Theme) {
    setTheme(next);
    applyTheme(next);
    persistTheme(next);
  }

  function toggleTheme() {
    changeTheme(theme === 'dark' ? 'light' : 'dark');
  }

  const refresh = useCallback(async (discover = false) => {
    setRefreshing(true);
    setError('');
    try {
      const found = discover ? await rediscover() : await listInstances();
      setInstances(found);
      const target = found.find((instance) => instance.isDefault) ?? found[0];
      if (target) {
        const envs = await listEnvironments(target.id, discover);
        setEnvironments(envs);
        setSelected((current) => envs.find((env) => env.prefix === current?.prefix) ?? envs[0] ?? null);
      } else {
        setEnvironments([]);
        setSelected(null);
      }
      // 首次启动检测：若未发现任何 Conda，自动进入安装引导页（仅触发一次，
      // 之后用户手动切换到其他页面不会被再次强制跳转）。
      if (!initialCheckDone.current) {
        initialCheckDone.current = true;
        if (found.length === 0) {
          setView('install');
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取 Conda 环境');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // 订阅任务事件，实时更新任务中心，并在任务完成后刷新数据。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onJobEvent((event) => {
      setJobs((prev) => {
        const current = prev.find((job) => job.id === event.id);
        const updated = applyJobEvent(current, event);
        return [updated, ...prev.filter((job) => job.id !== event.id)];
      });
      const terminal = event.status === 'succeeded' || event.status === 'failed' || event.status === 'cancelled';
      if (terminal) {
        if (['create_environment', 'delete_environment', 'clone_environment', 'import_environment', 'import_explicit'].includes(event.kind)) {
          void refresh();
        }
        if (event.kind === 'install_packages' || event.kind === 'remove_packages') {
          setPackagesVersion((value) => value + 1);
        }
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [refresh]);

  // 初始加载任务历史
  useEffect(() => {
    void listJobs().then(setJobs).catch(() => {});
  }, []);

  useEffect(() => {
    if (!selected) { setPackages([]); return; }
    let alive = true;
    void listPackages(selected.instanceId, selected.prefix)
      .then((result) => { if (alive) setPackages(result); })
      .catch((cause: unknown) => { if (alive) setError(cause instanceof Error ? cause.message : '无法读取包列表'); });
    return () => { alive = false; };
  }, [selected, packagesVersion]);

  async function handleExport() {
    if (!selected) return;
    setBusyAction(true);
    try { setExportYaml(await exportEnvironmentYaml(selected.instanceId, selected.prefix)); setShowExport(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '导出失败'); }
    finally { setBusyAction(false); }
  }

  async function handleSaveYaml(_yaml: string) {
    const path = await pickSaveFile('environment.yml', ['yml', 'yaml']);
    if (!path || !selected) return;
    try { await exportEnvironmentYamlToFile(selected.instanceId, selected.prefix, path); setShowExport(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败'); }
  }

  async function handleExportExplicit() {
    if (!selected) return;
    const path = await pickSaveFile('explicit-spec.txt', ['txt']);
    if (!path) return;
    try { await exportExplicitSpecToFile(selected.instanceId, selected.prefix, path); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '导出失败'); }
  }

  async function handleDelete() {
    if (!selected || selected.isBase) return;
    setBusyAction(true);
    try { await startDeleteEnvironment(selected.instanceId, selected.prefix); setConfirmDelete(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '删除失败'); setConfirmDelete(false); }
    finally { setBusyAction(false); }
  }

  async function handleCancelJob(id: number) {
    try { await cancelJob(id); } catch (cause) { setError(cause instanceof Error ? cause.message : '取消失败'); }
  }

  async function handleOpenDirectory() {
    if (!selected) return;
    try { await openEnvironmentDirectory(selected.instanceId, selected.prefix); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '打开目录失败'); }
  }

  async function handleActivateAndOpenTerminal(environment: EnvironmentSummary) {
    try {
      // 先激活环境（应用内记录激活态），再打开对应终端。
      if (!environment.isActive) {
        const envs = await activateEnvironment(environment.instanceId, environment.prefix);
        setEnvironments(envs);
        setSelected((current) => envs.find((env) => env.prefix === current?.prefix) ?? current);
      }
      await openEnvironmentTerminal(environment.instanceId, environment.prefix);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '激活环境失败'); }
  }

  async function handleSwitchInstance(instanceId: string) {
    try {
      // 立即清空旧目标的环境，显示加载态，避免切换到新目标后仍显示旧目标的环境。
      setEnvironments([]);
      setPackages([]);
      setSelected(null);
      setLoading(true);
      await setDefaultInstance(instanceId);
      setInstances((prev) => prev.map((instance) => ({ ...instance, isDefault: instance.id === instanceId })));
      const envs = await listEnvironments(instanceId, true);
      setEnvironments(envs);
      setSelected(envs[0] ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '切换实例失败');
    } finally {
      setLoading(false);
    }
  }

  async function switchTarget(runtime: string) {
    setTargetMenuOpen(false);
    const target = instances.find((instance) => instance.runtime === runtime);
    if (!target) {
      setError(`未找到运行目标：${runtime}，请先重新扫描`);
      return;
    }
    await handleSwitchInstance(target.id);
  }

  async function handleBuildOffline() {
    if (!activeInstance || !selected) return;
    const dest = await pickDirectory();
    if (!dest) return;
    try { await buildOfflineChannel(activeInstance.id, selected.prefix, dest); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '构建失败'); }
  }

  async function handleBuildWheelhouse() {
    if (!activeInstance || !selected) return;
    const dest = await pickDirectory();
    if (!dest) return;
    try { await buildWheelhouse(activeInstance.id, selected.prefix, dest); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '构建失败'); }
  }

  async function handleCondaPack() {
    if (!activeInstance || !selected) return;
    const dest = await pickSaveFile(`${selected.name ?? 'env'}.tar.gz`, ['tar.gz', 'gz']);
    if (!dest) return;
    try { await condaPackEnvironment(activeInstance.id, selected.prefix, dest); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '打包失败'); }
  }

  const activeInstance = instances.find((instance) => instance.isDefault) ?? instances[0];
  const wslDistros = [...new Set(instances.filter((instance) => instance.runtime.startsWith('wsl:')).map((instance) => instance.runtime.slice(4)))];
  const visibleEnvironments = environments.filter((environment) =>
    `${environment.name ?? ''} ${environment.prefix}`.toLowerCase().includes(query.toLowerCase()),
  );
  const visiblePackages = packages.filter((item) => item.name.toLowerCase().includes(packageQuery.toLowerCase()));
  const totalPackages = environments.reduce((sum, environment) => sum + (environment.packageCount ?? 0), 0);
  const baseEnv = environments.find((environment) => environment.isBase);

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
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="breadcrumb"><span>工作区</span><ChevronRight size={14} /><strong>{VIEW_META[view].label}</strong><span className="version-tag">v{APP_VERSION}</span></div>
          <div className="topbar-actions">
            <select className="instance-picker" value={activeInstance?.id ?? ''} onChange={(event) => void handleSwitchInstance(event.target.value)} title="切换 Conda 实例">
              {instances.map((instance) => (
                <option key={instance.id} value={instance.id}>
                  {instance.kind} {instance.version}{instance.runtime.startsWith('wsl:') ? `（WSL · ${instance.runtime.slice(4)}）` : ''}
                </option>
              ))}
            </select>
            <button className="icon-button" title="刷新环境" onClick={() => void refresh()} disabled={refreshing}>
              <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
            </button>
            <button className="icon-button" title={theme === 'dark' ? '切换到明亮模式' : '切换到暗色模式'} onClick={toggleTheme}>
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <div className="target-menu-wrap">
              <button className="profile-button" onClick={() => setTargetMenuOpen((value) => !value)}>
                {activeInstance ? (activeInstance.runtime.startsWith('wsl:') ? `WSL · ${activeInstance.runtime.slice(4)}` : '本地 Windows') : '未连接 Conda'} <ChevronDown size={14} />
              </button>
              {targetMenuOpen && (
                <>
                  <div className="target-menu-backdrop" onClick={() => setTargetMenuOpen(false)} />
                  <div className="target-menu" role="menu">
                    <button
                      className={`target-menu-item ${activeInstance && !activeInstance.runtime.startsWith('wsl:') ? 'active' : ''}`}
                      onClick={() => void switchTarget('windows')}
                    >
                      <Cpu size={14} />当前 Windows 操作系统
                    </button>
                    {wslDistros.map((distro) => (
                      <button
                        key={distro}
                        className={`target-menu-item ${activeInstance?.runtime === `wsl:${distro}` ? 'active' : ''}`}
                        onClick={() => void switchTarget(`wsl:${distro}`)}
                      >
                        <TerminalSquare size={14} />WSL · {distro}
                      </button>
                    ))}
                    {wslDistros.length === 0 && (
                      <div className="target-menu-empty">未检测到 WSL 发行版</div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {view === 'tasks' ? <TasksView jobs={jobs} onCancel={(id) => void handleCancelJob(id)} /> : view === 'packages' ? <PackagesView instance={activeInstance} environments={environments} packagesVersion={packagesVersion} /> : view === 'settings' ? <SettingsView instance={activeInstance} onJobStarted={() => setView('tasks')} theme={theme} onThemeChange={changeTheme} /> : view === 'install' ? <InstallView instances={instances} jobs={jobs} onRefresh={(force) => refresh(force)} /> : view === 'help' ? <HelpView /> : (
          <div className="page-content">
            <section className="page-heading">
              <div>
                <div className="eyebrow"><span className="eyebrow-line" /> 环境与依赖</div>
                <h1>环境管理</h1>
                <p>集中查看和管理本机 Conda 环境。</p>
              </div>
              <div className="heading-actions">
                <div className="target-badge" title="当前管理的 Conda 运行目标">
                  {activeInstance ? (
                    activeInstance.runtime.startsWith('wsl:')
                      ? <><TerminalSquare size={14} />WSL · {activeInstance.runtime.slice(4)}</>
                      : <><Cpu size={14} />本地 Windows</>
                  ) : (
                    <><AlertCircle size={14} />未连接 Conda</>
                  )}
                </div>
                <button className="secondary-button" onClick={() => setShowImport(true)}><Upload size={16} /> 导入</button>
                <button className="primary-button" onClick={() => setShowCreate(true)}><Plus size={17} /> 新建环境</button>
              </div>
            </section>

            {error && <div className="error-banner"><AlertCircle size={17} /><span>{error}</span><button onClick={() => setError('')} aria-label="关闭"><X size={15} /></button></div>}

            <section className="overview-grid" aria-label="环境概览">
              <div className="overview-item"><div className="overview-icon mint"><Layers3 size={17} /></div><div><span className="metric-label">环境总数</span><strong>{loading ? '—' : environments.length}</strong></div><span className="metric-foot">个环境</span></div>
              <div className="overview-item"><div className="overview-icon blue"><Package size={17} /></div><div><span className="metric-label">已安装包</span><strong>{loading ? '—' : formatNumber(totalPackages)}</strong></div><span className="metric-foot">跨环境统计</span></div>
              <div className="overview-item"><div className="overview-icon coral"><Cpu size={17} /></div><div><span className="metric-label">默认 Python</span><strong className="metric-version">{baseEnv?.pythonVersion ?? (activeInstance ? '未知' : '未检测')}</strong></div><span className="metric-foot">base 环境</span></div>
              <div className="overview-item"><div className="overview-icon violet"><ShieldCheck size={17} /></div><div><span className="metric-label">Conda 状态</span><strong className="metric-status"><i />{activeInstance ? '运行正常' : '未发现'}</strong></div><span className="metric-foot">{activeInstance?.platform ?? '请检查安装'}</span></div>
            </section>

            <section className="environment-section">
              <div className="section-heading">
                <div><h2>所有环境 <span className="count-pill">{environments.length}</span></h2><p>管理已发现的 Conda 环境与软件包</p></div>
                <div className="section-tools">
                  <label className="search-field"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索环境" /></label>
                  <button className="subtle-button" title="重新扫描" onClick={() => void refresh(true)} disabled={refreshing}><RefreshCw size={15} /></button>
                </div>
              </div>

              <div className="environment-layout">
                <div className="environment-table-wrap">
                  <table className="environment-table">
                    <thead><tr><th>环境名称</th><th>Python</th><th>软件包</th><th>磁盘占用</th><th>状态</th><th aria-label="操作" /></tr></thead>
                    <tbody>
                      {loading ? <tr><td colSpan={6} className="table-state"><LoaderCircle className="spin" size={19} />正在读取环境…</td></tr> : visibleEnvironments.map((environment) => (
                        <tr key={`${environment.instanceId}:${environment.prefix}`} className={selected?.prefix === environment.prefix ? 'selected' : ''} onClick={() => setSelected(environment)}>
                          <td><div className="environment-name"><div className={`env-icon ${environment.isBase ? 'env-base' : ''}`}>{environment.isBase ? <Command size={15} /> : <Box size={15} />}</div><div><strong>{environment.name ?? '未命名环境'}</strong><span>{environment.isBase ? '基础环境' : 'Conda 环境'}</span></div>{environment.isBase && <span className="base-tag">BASE</span>}</div></td>
                          <td><span className="python-tag">{environment.pythonVersion ? `Python ${environment.pythonVersion}` : '—'}</span></td>
                          <td className="package-count">{environment.packageCount ?? '—'} <span>个</span></td>
                          <td className="package-count size-cell">{formatBytes(environment.sizeBytes)}</td>
                          <td>{environment.isActive ? <span className="env-state active"><i />已激活</span> : <span className="env-state">未激活</span>}</td>
                          <td><button className="row-menu" title="更多操作" onClick={(event) => event.stopPropagation()}><MoreHorizontal size={17} /></button></td>
                        </tr>
                      ))}
                      {!loading && visibleEnvironments.length === 0 && (
                        <tr>
                          <td colSpan={6} className="table-empty">
                            <Database size={22} />
                            <strong>{environments.length ? '没有匹配的环境' : '尚未发现 Conda 环境'}</strong>
                            <span>{environments.length ? '尝试其他搜索关键词。' : '请检查 Conda 安装，或重新扫描。'}</span>
                            {environments.length === 0 && (
                              <button className="primary-button" style={{ marginTop: 14 }} onClick={() => setView('install')}>
                                <Download size={16} /> 安装 Conda
                              </button>
                            )}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  <div className="table-footer"><span>共 {environments.length} 个环境</span><span className="sync-status"><span />已同步</span></div>
                </div>

                <aside className="detail-panel">
                  {selected ? <>
                    <div className="detail-topline"><span>环境详情</span><button className="row-menu" title="环境操作"><MoreHorizontal size={17} /></button></div>
                    <div className="detail-identity"><div className={`detail-env-icon ${selected.isBase ? 'env-base' : ''}`}>{selected.isBase ? <Command size={20} /> : <Box size={20} />}</div><div><h3>{selected.name ?? '未命名环境'}</h3><span className={selected.isActive ? 'detail-ready active' : 'detail-ready'}><i />{selected.isActive ? '已激活' : '未激活'}</span></div></div>
                    <div className="detail-path"><span>环境路径</span><div title={selected.prefix}>{selected.prefix}<button title="打开环境目录" onClick={() => void handleOpenDirectory()}><ExternalLink size={13} /></button></div></div>
                    <div className="detail-specs"><div><span>Python 版本</span><strong>{selected.pythonVersion ?? '未知'}</strong></div><div><span>平台</span><strong>{selected.platform ?? activeInstance?.platform ?? '未知'}</strong></div><div><span>已安装包</span><strong>{selected.packageCount ?? '—'} 个</strong></div><div><span>环境类型</span><strong>{selected.isBase ? 'Base' : '用户环境'}</strong></div><div><span>磁盘占用</span><strong>{formatBytes(selected.sizeBytes)}</strong></div></div>
                    <div className="detail-divider" />
                    <div className="package-heading"><div><h4>已安装软件包</h4><span>{packages.length} 个主要包</span></div><button title="导出依赖" onClick={() => void handleExport()} disabled={busyAction}><ArrowDownToLine size={15} /></button></div>
                    <label className="package-search"><Search size={14} /><input value={packageQuery} onChange={(event) => setPackageQuery(event.target.value)} placeholder="搜索软件包" /></label>
                    <div className="package-list">{visiblePackages.map((item) => <div className="package-row" key={item.name}><div className="package-symbol"><Package size={14} /></div><div className="package-info"><strong>{item.name}</strong><span>{item.packageType === 'pip' ? 'PyPI' : item.channel ?? 'Conda'}</span></div><code>{item.version}</code></div>)}{visiblePackages.length === 0 && <div className="package-empty">没有匹配的软件包</div>}</div>
                    <div className="detail-actions">
                      <button className="icon-action" data-tooltip="激活环境并打开终端" onClick={() => void handleActivateAndOpenTerminal(selected)}><TerminalSquare size={16} /></button>
                      <button className="icon-action" data-tooltip="导出 environment.yml" onClick={() => void handleExport()} disabled={busyAction}><ArrowDownToLine size={16} /></button>
                      <button className="icon-action" data-tooltip="导出 explicit spec" onClick={() => void handleExportExplicit()}><FileCode2 size={16} /></button>
                      {!selected.isBase && <button className="icon-action" data-tooltip="克隆环境" onClick={() => setShowClone(true)}><GitBranch size={16} /></button>}
                      <button className="icon-action" data-tooltip="离线包仓库" onClick={() => void handleBuildOffline()}><HardDrive size={16} /></button>
                      <button className="icon-action" data-tooltip="构建 wheelhouse" onClick={() => void handleBuildWheelhouse()}><Box size={16} /></button>
                      {!selected.isBase && <button className="icon-action" data-tooltip="conda-pack 打包" onClick={() => void handleCondaPack()}><Package size={16} /></button>}
                      <button className="icon-action danger" data-tooltip="删除环境" onClick={() => setConfirmDelete(true)} disabled={selected.isBase || busyAction}><Trash2 size={16} /></button>
                    </div>
                  </> : <div className="detail-empty"><Database size={24} /><span>选择一个环境查看详情</span></div>}
                </aside>
              </div>
            </section>

            <footer className="app-footer"><span><span className="footer-dot" />{activeInstance ? `${activeInstance.kind} ${activeInstance.version}` : '未连接 Conda'}</span><span>{activeInstance?.rootPrefix ?? '未检测到安装路径'}</span><button title="设置" onClick={() => setView('settings')}><Settings2 size={14} /></button></footer>
          </div>
        )}
      </main>

      {showCreate && activeInstance && <CreateEnvironmentDialog instanceId={activeInstance.id} onClose={() => setShowCreate(false)} onCreated={() => void refresh()} />}

      {showImport && activeInstance && <ImportDialog instanceId={activeInstance.id} onClose={() => setShowImport(false)} onImported={() => void refresh()} />}

      {showExport && <ExportDialog yaml={exportYaml} onClose={() => setShowExport(false)} onSave={(yaml) => void handleSaveYaml(yaml)} />}

      {showClone && selected && activeInstance && <CloneDialog instanceId={activeInstance.id} sourcePrefix={selected.prefix} sourceName={selected.name ?? '未命名环境'} onClose={() => setShowClone(false)} onCloned={() => void refresh()} />}

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

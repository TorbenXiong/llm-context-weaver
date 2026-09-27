/**
 * 工作台页面：建任务（文件 / 粘贴）、任务列表、实时进度、控制操作、结果查看与下载。
 * 数据读取直连 IndexedDB（与 SW 同 origin），控制命令走 runtime 消息。
 */
import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { splitIntoChunks } from '../core/chunking/chunker';
import { streamBlobChunks } from '../core/chunking/streamChunker';
import { inferPipelineMode, inferTaskKind, recommendJobConfig } from '../core/config/smartDefaults';
import { isExtractionResult } from '../core/protocol/schema';
import { DEFAULT_PROMPT_TEMPLATES } from '../core/protocol/prompts';
import { renderKnowledgeMarkdown, renderSkillMarkdown } from '../core/protocol/render';
import { addChunks, appendChunks, chunkMetasByJob, createJob, deleteJob, getJob, getResult, jobProgress, listJobs, resultsByJob, saveJob } from '../core/storage/jobStore';
import { activeResultIds } from '../core/engine/reprocess';
import {
  DEFAULT_JOB_CONFIG,
  type Job,
  type JobConfig,
  type JobProgress,
  type JobStatus,
  type PipelineMode,
  type PromptTemplateSet,
  type TaskKind,
} from '../core/types';

const STATUS_LABEL: Record<JobStatus, string> = {
  split: '分块中',
  processing: '处理中',
  waiting: '等待中',
  collecting: '收集中',
  reducing: '归并中',
  paused: '已暂停',
  completed: '已完成',
  canceled: '已取消',
  failed: '已失败',
};
const DISPATCH_PHASE_LABEL: Record<NonNullable<Job['current']>['phase'], string> = {
  prepared: '准备中',
  submitting: '提交中',
  acknowledged: '已确认',
};
const EVENT_KIND_LABEL: Record<string, string> = {
  submitted: '已提交',
  collected: '已收集',
  'generation-end': '生成结束',
  'inspection-complete': '检测完成',
  'provider-error': '提供方错误',
  'rate-limit': '官方限流',
  'manual-intervention': '手工干预',
};
const eventKindLabel = (kind: string): string => EVENT_KIND_LABEL[kind] ?? kind;
const ACTIVE_STATUSES: readonly JobStatus[] = ['split', 'processing', 'waiting', 'collecting', 'reducing'];
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function sendCmd(cmd: Record<string, unknown>): Promise<void> {
  const res = (await chrome.runtime.sendMessage(cmd)) as { ok?: boolean; error?: string } | null;
  if (!res) throw new Error('扩展后台未响应，请在扩展管理页面重新加载插件后重试');
  if (res.ok !== true) throw new Error(res.error ?? '命令执行失败');
}

export function App() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const nextJobs = await listJobs();
    setJobs(nextJobs);
    setSelectedId((current) => current && nextJobs.some((job) => job.id === current)
      ? current
      : nextJobs[0]?.id ?? null);
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 1500);
    return () => clearInterval(t);
  }, [refresh]);
  return (
    <div className="page">
      <header className="page-header">
        <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
        <div>
          <h1>LLM Context Weaver</h1>
          <p>将长文本与聊天记录整理成可复用的结构化结果</p>
        </div>
        <span className="provider-label">DeepSeek Web</span>
      </header>
      <NewJobForm
        jobs={jobs}
        onStarted={(id) => {
          setSelectedId(id);
          void refresh();
        }}
      />
      <div className="layout">
        <aside className="job-list">
          <h2>任务列表</h2>
          {jobs.length === 0 && <p className="empty-list">任务开始后会显示在这里</p>}
          {jobs.map((j) => (
            <div key={j.id} className="job-item-row">
              <button className={`job-item ${j.id === selectedId ? 'selected' : ''}`} onClick={() => setSelectedId(j.id)}>
                <span className="job-name">{j.name}</span>
                <span className={`chip st-${j.status}`}>{STATUS_LABEL[j.status]}</span>
              </button>
              {!ACTIVE_STATUSES.includes(j.status) && (
                <button
                  className="job-delete"
                  title="删除本地任务"
                  aria-label={`删除本地任务：${j.name}`}
                  onClick={() => {
                    if (!window.confirm(`确定删除“${j.name}”及其本地结果？网页会话不会受影响。`)) return;
                    void deleteJob(j.id).then(() => {
                      if (selectedId === j.id) setSelectedId(null);
                      return refresh();
                    });
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </aside>
        <section className="job-main">
          {selectedId ? (
            <JobDetail
              jobId={selectedId}
              onDeleted={() => {
                setSelectedId(null);
                void refresh();
              }}
            />
          ) : (
            <div className="empty-detail">
              <span className="empty-detail-symbol" aria-hidden="true">→</span>
              <p>选择任务查看进度与结果</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function NewJobForm({ jobs, onStarted }: { jobs: Job[]; onStarted: (id: string) => void }) {
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [maxChunkChars, setMaxChunkChars] = useState(DEFAULT_JOB_CONFIG.maxChunkChars);
  const [fanIn, setFanIn] = useState(DEFAULT_JOB_CONFIG.fanIn);
  const [sendDelayMs, setSendDelayMs] = useState(DEFAULT_JOB_CONFIG.sendDelayMs);
  const [generationTimeoutMs, setGenerationTimeoutMs] = useState(DEFAULT_JOB_CONFIG.generationTimeoutMs);
  const [deepThinking, setDeepThinking] = useState(DEFAULT_JOB_CONFIG.deepThinking);
  const [smartSearch, setSmartSearch] = useState(DEFAULT_JOB_CONFIG.smartSearch);
  const [taskKindOverride, setTaskKindOverride] = useState<TaskKind | 'auto'>('auto');
  const [pipelineModeOverride, setPipelineModeOverride] = useState<PipelineMode | 'auto'>('auto');
  const [taskInstruction, setTaskInstruction] = useState(DEFAULT_JOB_CONFIG.taskInstruction);
  const [promptTemplates, setPromptTemplates] = useState<PromptTemplateSet>({ ...DEFAULT_PROMPT_TEMPLATES });
  const [deleteProviderSessionsOnComplete, setDeleteProviderSessionsOnComplete] = useState(
    DEFAULT_JOB_CONFIG.deleteProviderSessionsOnComplete,
  );
  const [smartTuning, setSmartTuning] = useState(true);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputChars = file?.size ?? text.length;
  const recommendation = recommendJobConfig(inputChars);
  const taskKind = taskKindOverride === 'auto' ? inferTaskKind(taskInstruction) : taskKindOverride;
  const pipelineMode = pipelineModeOverride === 'auto'
    ? inferPipelineMode(taskKind, previewCount ?? 2)
    : pipelineModeOverride;

  useEffect(() => {
    if (!smartTuning || inputChars <= 0) return;
    setMaxChunkChars(recommendation.maxChunkChars);
    setFanIn(recommendation.fanIn);
    setSendDelayMs(recommendation.sendDelayMs);
    setGenerationTimeoutMs(recommendation.generationTimeoutMs);
  }, [smartTuning, inputChars, recommendation.maxChunkChars, recommendation.fanIn, recommendation.sendDelayMs, recommendation.generationTimeoutMs]);

  // 分块预览防抖：大文本避免每次输入都全量切分
  useEffect(() => {
    if (file) {
      setPreviewCount(null);
      return;
    }
    const t = setTimeout(() => {
      if (!text) {
        setPreviewCount(null);
        return;
      }
      try {
        const chunks = splitIntoChunks(text, { maxChars: maxChunkChars, hardMaxChars: DEFAULT_JOB_CONFIG.hardMaxChunkChars });
        setPreviewCount(chunks.length);
      } catch {
        setPreviewCount(null);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [file, text, maxChunkChars]);

  const hasActive = jobs.some((j) => ACTIVE_STATUSES.includes(j.status));

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    if (!name) setName(f.name.replace(/\.[^.]+$/, ''));
    setText('');
  }

  async function onStart() {
    setBusy(true);
    setError(null);
    let incompleteJobId: string | null = null;
    try {
      let actualChunkCount = 0;
      const config: JobConfig = {
        ...DEFAULT_JOB_CONFIG,
        pipelineMode,
        maxChunkChars: Math.max(1_000, Math.min(maxChunkChars, DEFAULT_JOB_CONFIG.hardMaxChunkChars)),
        fanIn: Math.max(2, Math.min(fanIn, 32)),
        sendDelayMs: Math.max(0, Math.min(sendDelayMs, 60_000)),
        generationTimeoutMs: Math.max(60_000, Math.min(generationTimeoutMs, 30 * 60_000)),
        deepThinking,
        smartSearch,
        deleteProviderSessionsOnComplete,
        taskKind,
        taskInstruction: taskInstruction.trim(),
        promptTemplates,
      };
      if (config.taskKind === 'custom' && !config.taskInstruction) throw new Error('自定义处理模式需要填写任务要求');
      const opts = { maxChars: config.maxChunkChars, hardMaxChars: DEFAULT_JOB_CONFIG.hardMaxChunkChars };
      const job = await createJob(name.trim() || '未命名任务', config, 'deepseek');
      incompleteJobId = job.id;
      if (file) {
        let index = 0;
        let batch: string[] = [];
        for await (const chunk of streamBlobChunks(file, opts)) {
          batch.push(chunk);
          if (batch.length >= 100) {
            await appendChunks(job.id, index, batch);
            index += batch.length;
            batch = [];
          }
        }
        if (batch.length > 0) {
          await appendChunks(job.id, index, batch);
          index += batch.length;
        }
        if (index === 0) throw new Error('分块结果为空');
        actualChunkCount = index;
      } else {
        if (!text.trim()) throw new Error('请先选择文件或粘贴文本');
        const chunks = splitIntoChunks(text, opts);
        if (chunks.length === 0) throw new Error('分块结果为空');
        await addChunks(job.id, chunks);
        actualChunkCount = chunks.length;
      }
      const resolvedMode = pipelineModeOverride === 'auto'
        ? inferPipelineMode(config.taskKind, actualChunkCount)
        : pipelineModeOverride;
      if (resolvedMode !== config.pipelineMode) {
        const imported = await getJob(job.id);
        if (!imported) throw new Error('导入后任务状态缺失');
        await saveJob({ ...imported, config: { ...imported.config, pipelineMode: resolvedMode } });
      }
      incompleteJobId = null;
      await sendCmd({ channel: 'ui', type: 'start', jobId: job.id });
      setText('');
      setFile(null);
      setName('');
      onStarted(job.id);
    } catch (e) {
      if (incompleteJobId) await deleteJob(incompleteJobId).catch(() => undefined);
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card compose-card">
      <div className="form-grid">
        <label>
          任务名称
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：项目群聊天记录 2026" />
        </label>
      </div>

      <label className="task-instruction">
        任务要求（核心目标）
        <textarea
          value={taskInstruction}
          onChange={(e) => setTaskInstruction(e.target.value)}
          placeholder="例如：提取可复用的编程经验；或翻译成英文并保留 Markdown 格式"
          rows={3}
        />
      </label>
      <details className="prompt-editor">
        <summary>阶段提示词（可编辑）</summary>
        <p className="hint">模板只保留通用流程约束；具体任务要求来自上方“任务要求”。可用占位符：<code>{'{{marker}}'}</code>、<code>{'{{task}}'}</code>、<code>{'{{input}}'}</code>、<code>{'{{index}}'}</code>、<code>{'{{chunkRef}}'}</code>、<code>{'{{samples}}'}</code>、<code>{'{{plan}}'}</code>、<code>{'{{formatPlan}}'}</code>、<code>{'{{results}}'}</code>、<code>{'{{stage}}'}</code>、<code>{'{{finalRule}}'}</code>、<code>{'{{format}}'}</code>、<code>{'{{generic}}'}</code>。</p>
        {([
          ['index', '目标相关索引'],
          ['extract', '目标处理 / 分块提取'],
          ['format', '动态格式规范'],
          ['normalize', '按规范统一格式'],
          ['reduce', '中间归并 / 最终交付'],
        ] as const).map(([key, label]) => (
          <label key={key}>
            {label}
            <textarea
              rows={8}
              value={promptTemplates[key]}
              onChange={(e) => setPromptTemplates((current) => ({ ...current, [key]: e.target.value }))}
            />
          </label>
        ))}
        <button type="button" onClick={() => setPromptTemplates({ ...DEFAULT_PROMPT_TEMPLATES })}>恢复通用模板</button>
      </details>
      <div className="source-section">
        <label className="file-source">
          <span className="source-label-row"><span>选择文件</span><small>支持 .txt、.log、.md、.json</small></span>
          <input type="file" accept=".txt,.log,.md,.json,text/plain,application/json" onChange={(e) => void onFileChange(e)} />
        </label>
        {file ? (
          <p className="selected-file">已选择文件：<strong>{file.name}</strong>（{file.size.toLocaleString()} 字节，开始时流式导入）</p>
        ) : (
          <label className="source-input">
            粘贴原文
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="直接粘贴需要处理的文本"
              rows={5}
            />
          </label>
        )}
      </div>
      <details>
        <summary>高级参数</summary>
        <div className="form-grid mode-overrides">
          <label>
            结果形式
            <select value={taskKindOverride} onChange={(e) => setTaskKindOverride(e.target.value as TaskKind | 'auto')}>
              <option value="auto">自动识别</option>
              <option value="knowledge">结构化提取</option>
              <option value="custom">文本处理</option>
            </select>
          </label>
          <label>
            处理流程
            <select value={pipelineModeOverride} onChange={(e) => setPipelineModeOverride(e.target.value as PipelineMode | 'auto')}>
              <option value="auto">自动选择</option>
              <option value="staged">多阶段处理</option>
              <option value="direct">直接处理</option>
            </select>
          </label>
        </div>
        <label className="toggle-row">
          <input type="checkbox" checked={smartTuning} onChange={(e) => setSmartTuning(e.target.checked)} />
          <span>智能配置数值参数</span>
        </label>
        {inputChars > 0 && (
          <p className="hint">
            {recommendation.explanation}（当前输入规模约 {inputChars.toLocaleString()} 字符）
          </p>
        )}
        <div className="form-grid">
          <label>
            分块目标长度（字符）
            <input
              type="number"
              min={1000}
              max={DEFAULT_JOB_CONFIG.hardMaxChunkChars}
              value={maxChunkChars}
              disabled={smartTuning}
              onChange={(e) => setMaxChunkChars(Number(e.target.value) || DEFAULT_JOB_CONFIG.maxChunkChars)}
            />
            <small className="hint">这是软目标；优先保留完整段落，允许适度超过，达到硬护栏时才按句末或标点拆分。</small>
          </label>
          <label>
            归并扇入
            <input
              type="number"
              min={2}
              max={32}
              value={fanIn}
              disabled={smartTuning}
              onChange={(e) => setFanIn(Number(e.target.value) || DEFAULT_JOB_CONFIG.fanIn)}
            />
          </label>
          <label>
            发送间隔（毫秒）
            <input
              type="number"
              min={0}
              max={60000}
              value={sendDelayMs}
              disabled={smartTuning}
              onChange={(e) => setSendDelayMs(Number(e.target.value) || DEFAULT_JOB_CONFIG.sendDelayMs)}
            />
          </label>
        </div>
      </details>
      <div className="actions compose-actions">
        <div className="compose-action-options">
          <label className="toggle-row">
            <input type="checkbox" checked={deepThinking} onChange={(e) => setDeepThinking(e.target.checked)} />
            <span>深度思考</span>
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked={smartSearch} onChange={(e) => setSmartSearch(e.target.checked)} />
            <span>智能搜索</span>
          </label>
          <label className="toggle-row warning-row">
            <input
              type="checkbox"
              checked={deleteProviderSessionsOnComplete}
              onChange={(e) => setDeleteProviderSessionsOnComplete(e.target.checked)}
            />
            <span>完成后自动删除会话</span>
          </label>
        </div>
        <div className="compose-action-end">
          <button className="primary" disabled={busy || hasActive || (!file && !text)} onClick={() => void onStart()}>
            {busy ? '创建/导入中…' : previewCount != null ? `开始任务（${previewCount.toLocaleString()} 块）` : '开始任务'}
          </button>
          {hasActive && <span className="muted">已有进行中的任务（MVP 单任务）</span>}
          {error && <span className="error">{error}</span>}
        </div>
      </div>
    </div>
  );
}

function JobDetail({ jobId, onDeleted }: { jobId: string; onDeleted: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [prog, setProg] = useState<JobProgress | null>(null);
  const [failedMeta, setFailedMeta] = useState<{ index: number; attempts: number; stage?: string; error: string | null }[]>([]);
  const [resultMetas, setResultMetas] = useState<import('../core/types').ChunkMeta[]>([]);
  const [resultRecords, setResultRecords] = useState<import('../core/types').ResultRecord[]>([]);
  const [selectedResultIds, setSelectedResultIds] = useState<string[]>([]);
  const [finalMd, setFinalMd] = useState<string | null>(null);
  const [finalJson, setFinalJson] = useState<string | null>(null);
  const [finalSkill, setFinalSkill] = useState<string | null>(null);
  const [showResult, setShowResult] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const j = await getJob(jobId);
    setJob(j ?? null);
    if (!j) return;
    setProg(await jobProgress(jobId));
    const metas = await chunkMetasByJob(jobId);
    setResultMetas(metas);
    const records = await resultsByJob(jobId);
    setResultRecords(records);
    const activeIds = activeResultIds(j, metas, records);
    setSelectedResultIds((current) => current.filter((id) => activeIds.has(id)));
    setFailedMeta(metas
      .filter((meta) => meta.status === 'failed')
      .sort((left, right) => left.index - right.index)
      .map((meta) => ({ index: meta.index, attempts: meta.attempts, stage: meta.stage, error: meta.error })));
    if (j.status !== 'completed' || !j.finalResultId) {
      setFinalMd(null);
      setFinalJson(null);
      setFinalSkill(null);
      setShowResult(false);
    } else {
      const r = await getResult(j.finalResultId);
      if (r) {
        if (typeof r.parsed === 'string') {
          setFinalMd(r.parsed);
          setFinalJson(null);
          setFinalSkill(null);
        } else if (isExtractionResult(r.parsed)) {
          setFinalMd(renderKnowledgeMarkdown(r.parsed, j.name, j.config.taskInstruction));
          setFinalSkill(renderSkillMarkdown(r.parsed, j.name, j.config.taskInstruction));
          // version 仅用于内部校验，下载给用户的 JSON 保持固定模板，不额外增加顶层字段。
          const { version: _version, ...publicResult } = r.parsed;
          setFinalJson(JSON.stringify(publicResult, null, 2));
        } else {
          const json = JSON.stringify(r.parsed, null, 2);
          setFinalMd(`\`\`\`json\n${json}\n\`\`\``);
          setFinalJson(json);
          setFinalSkill(null);
        }
      }
    }
  }, [jobId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 1500);
    return () => clearInterval(t);
  }, [load]);

  if (!job) {
    return (
      <div className="card">
        <p className="muted">任务不存在或已删除。</p>
      </div>
    );
  }
  const active = ACTIVE_STATUSES.includes(job.status);
  const pct = prog && prog.total > 0 ? Math.round((prog.done / prog.total) * 100) : 0;
  const now = Date.now();
  const latestRateLimit = job.rateLimitEvents?.at(-1);
  const trafficHistory = job.trafficHistory ?? [];
  const trafficInputSinceRateLimit = trafficHistory.filter((sample) =>
    !latestRateLimit || sample.submittedAt > latestRateLimit.occurredAt,
  );
  const trafficOutputSinceRateLimit = trafficHistory.filter((sample) =>
    !latestRateLimit || (sample.completedAt ?? sample.submittedAt) > latestRateLimit.occurredAt,
  );
  const trafficIntervalInput = trafficInputSinceRateLimit.reduce(
    (total, sample) => total + Math.max(0, sample.inputChars),
    0,
  );
  const trafficIntervalOutput = trafficOutputSinceRateLimit.reduce(
    (total, sample) => total + Math.max(0, sample.outputChars ?? 0),
    0,
  );
  const cooldownActive = job.sessionCooldownUntil != null && job.sessionCooldownUntil > now;
  const officialCooldown = job.sessionCooldownReason?.startsWith('Provider 官方限流') === true;
  const cooldownStartedAt = cooldownActive
    ? job.sessionCooldownStartedAt ?? (officialCooldown && latestRateLimit &&
      latestRateLimit.occurredAt + latestRateLimit.retryAfterMs === job.sessionCooldownUntil
      ? latestRateLimit.occurredAt : null)
    : null;
  const intervalInput = trafficIntervalInput;
  const intervalOutput = trafficIntervalOutput;
  const cumulativeInput = (latestRateLimit?.cumulativeInputChars
    ?? latestRateLimit?.inputChars
    ?? 0) + intervalInput;
  const cumulativeOutput = (latestRateLimit?.cumulativeOutputChars
    ?? latestRateLimit?.outputChars
    ?? 0) + intervalOutput;
  const limitType = officialCooldown ? '官方限流' : '主动限流';
  const showRateLimitSummary = cooldownActive;
  const showTrafficSummary = trafficHistory.length > 0 || latestRateLimit != null;
  const run = (cmd: Record<string, unknown>) => {
    setError(null);
    void sendCmd(cmd)
      .then(load)
      .catch((e) => setError(errMsg(e)));
  };
  const activeIds = activeResultIds(job, resultMetas, resultRecords);
  const selectableResults = resultRecords
    .filter((result) => activeIds.has(result.id))
    .sort((left, right) => right.createdAt - left.createdAt);
  const resultKindLabel: Record<string, string> = {
    index: '索引', extract: '提炼', format: '格式规范', normalize: '格式统一', reduce: '归并',
  };
  const resultLooksEmpty = (value: unknown): boolean => {
    if (typeof value === 'string') return value.trim().length === 0;
    if (Array.isArray(value)) return value.length === 0 || value.every(resultLooksEmpty);
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      return entries.length === 0 || entries.every(([, item]) => resultLooksEmpty(item));
    }
    return value == null;
  };

  function download(filename: string, content: string, type: string) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="card detail-card">
      <div className="detail-header">
        <h2>{job.name}</h2>
        <span className={`chip st-${job.status}`}>{STATUS_LABEL[job.status]}</span>
      </div>
      <p className="muted">
        {job.config.taskKind === 'custom' ? '文本处理' : '结构化提取'}
        {` · ${job.config.pipelineMode === 'staged' ? '多阶段流程' : '直接流程'}`}
        {job.config.taskKind === 'knowledge' ? ' · 动态格式归档' : ''}
        {job.config.taskInstruction ? ` · 要求：${job.config.taskInstruction}` : ''}
      </p>
      <div className="bar">
        <div className="bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="progress-summary">
        <div className="summary-table-wrap">
          <table className="summary-table">
            <tbody>
              <tr>
                <th scope="row">进度</th>
                <td>分块 {prog ? `${prog.done}/${prog.total}` : '…'}</td>
                {prog && job.config.pipelineMode === 'staged' ? <td>已建立索引 {prog.indexed}/{prog.total}</td> : null}
                <td>已发送总计 {job.stats.sent}</td>
                <td>已收集总计 {job.stats.collected}</td>
                <td>限流 {job.stats.rateLimitHits} 次</td>
                {job.providerSessionRefs.length > 0 ? <td>DeepSeek 网页会话 {job.providerSessionRefs.length}</td> : null}
                {prog && prog.failed > 0 ? <td>失败 {prog.failed}</td> : null}
              </tr>
              {job.formatState?.phase === 'planning' || job.formatState?.phase === 'normalizing' || job.reduceState ? (
                <tr>
                  <th scope="row">阶段</th>
                  <td colSpan={6}>
                    {job.formatState?.phase === 'planning' ? '正在生成动态格式规范' : null}
                    {job.formatState?.phase === 'normalizing'
                      ? `格式统一（${Math.min(job.formatState.nextGroup + 1, job.formatState.groups.length)}/${job.formatState.groups.length} 批）` : null}
                    {job.reduceState
                      ? `归并第 ${job.reduceState.level} 层（${Math.min(job.reduceState.nextGroup + 1, job.reduceState.groups.length)}/${job.reduceState.groups.length} 组）` : null}
                  </td>
                </tr>
              ) : null}
              {showTrafficSummary ? (
                <tr>
                  <th scope="row">流量</th>
                  <td>本轮输入 {intervalInput.toLocaleString()}</td>
                  <td>本轮输出 {intervalOutput.toLocaleString()}</td>
                  <td>累计输入 {cumulativeInput.toLocaleString()}</td>
                  <td colSpan={3}>累计输出 {cumulativeOutput.toLocaleString()} 字符</td>
                </tr>
              ) : null}
              {showRateLimitSummary ? (
                <tr>
                  <th scope="row">限流</th>
                  <td>限流类型 {limitType ?? '—'}</td>
                  <td>限流时间 {cooldownStartedAt != null ? new Date(cooldownStartedAt).toLocaleTimeString() : '—'}</td>
                  <td>重试时间 {cooldownActive && job.sessionCooldownUntil ? new Date(job.sessionCooldownUntil).toLocaleTimeString() : '—'}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
      <>
        <div className="current-unit-row">
          {job.current ? <p className="muted">
            当前单元：<code>{job.current.marker}</code>
            {` · 阶段 ${DISPATCH_PHASE_LABEL[job.current.phase]}`}
          </p> : <p className="muted">任务运行日志</p>}
          <button className="log-button" onClick={() => setShowLog((value) => !value)}>
            {showLog ? '隐藏日志' : '日志'}
          </button>
        </div>
      </>
      {showLog && (
        <div className="job-log" role="log">
          {(job.eventLog ?? []).length === 0 ? <p className="muted">暂无运行日志</p> : (
            <ul>
              {[...(job.eventLog ?? [])].reverse().map((event, index) => (
                <li key={`${event.at}-${index}`}>
                  <time>{new Date(event.at).toLocaleString()}</time>
                  <span>{eventKindLabel(event.kind)}</span>
                  <em>{event.detail}</em>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {job.status !== 'completed' && job.lastError && <p className="error">最近错误：{job.lastError}</p>}
      <div className="actions">
        {job.current?.rateLimited && cooldownActive && officialCooldown && (
          <button
            className="primary"
            onClick={() => run({ channel: 'ui', type: 'manualContinue', jobId })}
          >
            我已手工继续生成，确认结果
          </button>
        )}
        {active && <button onClick={() => run({ channel: 'ui', type: 'pause', jobId })}>暂停</button>}
        {job.status === 'paused' && (
          <button className="primary" onClick={() => run({ channel: 'ui', type: 'resume', jobId })}>
            继续
          </button>
        )}
        {(active || job.status === 'paused') && (
          <button className="danger" onClick={() => run({ channel: 'ui', type: 'cancel', jobId })}>
            取消
          </button>
        )}
        {!active && job.providerSessionRefs.length > 0 && (
          <button
            className="danger"
            onClick={() => {
              if (!window.confirm(`确定从 DeepSeek 删除该任务创建的 ${job.providerSessionRefs.length} 个网页会话？删除后不可恢复。`)) return;
              run({ channel: 'ui', type: 'cleanupSessions', jobId });
            }}
          >
            清理 DeepSeek 网页会话（{job.providerSessionRefs.length}）
          </button>
        )}
        {job.failedChunks.length > 0 && (
          <button onClick={() => run({ channel: 'ui', type: 'retryFailed', jobId })}>
            重试全部失败（{job.failedChunks.length}）
          </button>
        )}
        {job.status === 'failed' && !job.current && (
          <button className="primary" onClick={() => run({ channel: 'ui', type: 'retryFailed', jobId })}>
            恢复任务
          </button>
        )}
        {job.status === 'failed' && job.current && (
          <>
            <button className="primary" onClick={() => run({ channel: 'ui', type: 'retryFailed', jobId })}>
              再次对账
            </button>
            <button
              className="danger"
              onClick={() => {
                if (!window.confirm('仅当你已确认网页没有收到当前请求时继续。强制重试可能产生重复发送，是否继续？')) return;
                run({ channel: 'ui', type: 'forceRetryCurrent', jobId });
              }}
            >
              确认未发送，强制重试
            </button>
          </>
        )}
        {!active && selectableResults.length > 0 && (
          <div className="reprocess-panel">
            <strong>选择会话重新发起</strong>
            <p className="muted">只选择同一阶段；已选会话的后续阶段会自动重算，历史日志会保留。</p>
            <div className="reprocess-list">
              {selectableResults.map((result) => (
                <label key={result.id} className="reprocess-item">
                  <input
                    type="checkbox"
                    checked={selectedResultIds.includes(result.id)}
                    onChange={(event) => setSelectedResultIds((current) => event.target.checked
                      ? [...current, result.id]
                      : current.filter((id) => id !== result.id))}
                  />
                  <span>{resultKindLabel[result.kind] ?? result.kind} / {result.ref} · {result.raw.length.toLocaleString()} 字符{resultLooksEmpty(result.parsed) ? ' · 空内容' : ''}</span>
                </label>
              ))}
            </div>
            <button
              className="primary"
              disabled={selectedResultIds.length === 0}
              onClick={() => run({ channel: 'ui', type: 'reprocessResults', jobId, resultIds: selectedResultIds })}
            >
              重新发起选中会话
            </button>
          </div>
        )}
        {job.status === 'completed' && finalMd && (
          <>
            <button className="primary" onClick={() => setShowResult((v) => !v)}>
              {showResult ? '隐藏结果' : '查看结果'}
            </button>
            <button onClick={() => download(`${job.name}.md`, finalMd, 'text/markdown')}>下载 Markdown</button>
            {finalJson && (
              <button onClick={() => download(`${job.name}.json`, finalJson, 'application/json')}>下载 JSON</button>
            )}
            {finalSkill && (
              <button onClick={() => download(`${job.name}-SKILL.md`, finalSkill, 'text/markdown')}>导出 Skill.md</button>
            )}
          </>
        )}
        {!active && (
          <button
            className="danger"
            onClick={() => {
              if (!window.confirm('确定删除本地任务及其全部分块与结果？DeepSeek 网页会话不会被删除，请先使用“清理 DeepSeek 网页会话”。')) return;
              void (async () => {
                await deleteJob(jobId);
                onDeleted();
              })().catch((e) => setError(errMsg(e)));
            }}
          >
            删除本地任务
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {job.failedChunks.length > 0 && (
        <details>
          <summary>失败分块（{job.failedChunks.length}）</summary>
          <ul className="fail-list">
            {job.failedChunks.map((i) => (
              <li key={i}>
                #{i}{' '}
                {failedMeta.find((meta) => meta.index === i)?.error
                  ? <span className="muted">（{failedMeta.find((meta) => meta.index === i)?.error}；尝试 {failedMeta.find((meta) => meta.index === i)?.attempts ?? 0} 次）</span>
                  : null}{' '}
                <button onClick={() => run({ channel: 'ui', type: 'retryChunk', jobId, index: i })}>重试</button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {showResult && finalMd && <pre className="result">{finalMd}</pre>}
    </div>
  );
}

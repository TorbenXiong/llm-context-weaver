/**
 * 工作台页面：建任务（文件 / 粘贴）、任务列表、实时进度、控制操作、结果查看与下载。
 * 数据读取直连 IndexedDB（与 SW 同 origin），控制命令走 runtime 消息。
 */
import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { splitIntoChunks } from '../core/chunking/chunker';
import { streamBlobChunks } from '../core/chunking/streamChunker';
import { recommendJobConfig } from '../core/config/smartDefaults';
import { fileTestByteLimit, normalizeTestScope, reachedFileTestLimit, selectTestChunks } from '../core/config/testScope';
import { isExtractionResult } from '../core/protocol/schema';
import { renderKnowledgeMarkdown, renderSkillMarkdown } from '../core/protocol/render';
import { addChunks, appendChunks, createJob, deleteJob, getJob, getResult, jobProgress, listJobs } from '../core/storage/jobStore';
import {
  DEFAULT_JOB_CONFIG,
  type Job,
  type JobConfig,
  type JobProgress,
  type JobStatus,
  type PipelineMode,
  type TaskKind,
  type TestScope,
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
    setJobs(await listJobs());
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 1500);
    return () => clearInterval(t);
  }, [refresh]);
  return (
    <div className="page">
      <header className="page-header">
        <h1>LLM Context Weaver</h1>
        <p>超大文本 / 聊天记录 → 分块提炼 → 递归归并 → 结构化知识 · MVP：DeepSeek Web</p>
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
          {jobs.length === 0 && <p className="muted">还没有任务。</p>}
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
            <p className="muted">选择左侧任务查看详情。</p>
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
  const [taskKind, setTaskKind] = useState<TaskKind>(DEFAULT_JOB_CONFIG.taskKind);
  const [pipelineMode, setPipelineMode] = useState<PipelineMode>(DEFAULT_JOB_CONFIG.pipelineMode);
  const [taskInstruction, setTaskInstruction] = useState(DEFAULT_JOB_CONFIG.taskInstruction);
  const [testScope, setTestScope] = useState<TestScope>(DEFAULT_JOB_CONFIG.testScope);
  const [testPercent, setTestPercent] = useState(DEFAULT_JOB_CONFIG.testPercent);
  const [testSessionLimit, setTestSessionLimit] = useState(DEFAULT_JOB_CONFIG.testSessionLimit);
  const [deleteProviderSessionsOnComplete, setDeleteProviderSessionsOnComplete] = useState(
    DEFAULT_JOB_CONFIG.deleteProviderSessionsOnComplete,
  );
  const [smartTuning, setSmartTuning] = useState(true);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputChars = file?.size ?? text.length;
  const recommendation = recommendJobConfig(inputChars);

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
        setPreviewCount(selectTestChunks(chunks, normalizeTestScope({ testScope, testPercent, testSessionLimit })).length);
      } catch {
        setPreviewCount(null);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [file, text, maxChunkChars, testScope, testPercent, testSessionLimit]);

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
        testScope,
        testPercent: testScope === 'percent' ? Math.max(1, Math.min(100, Math.floor(testPercent || 100))) : 100,
        testSessionLimit: testScope === 'sessions' ? Math.max(1, Math.min(100_000, Math.floor(testSessionLimit || 1))) : 0,
      };
      if (config.taskKind === 'custom' && !config.taskInstruction) throw new Error('自定义处理模式需要填写任务要求');
      const opts = { maxChars: config.maxChunkChars, hardMaxChars: DEFAULT_JOB_CONFIG.hardMaxChunkChars };
      const scopeConfig = normalizeTestScope(config);
      const job = await createJob(name.trim() || '未命名任务', config, 'deepseek');
      incompleteJobId = job.id;
      if (file) {
        let index = 0;
        let batch: string[] = [];
        const percentTarget = fileTestByteLimit(file.size, scopeConfig);
        const encoder = new TextEncoder();
        let selectedBytes = 0;
        let selectedCount = 0;
        for await (const chunk of streamBlobChunks(file, opts)) {
          if (reachedFileTestLimit(selectedBytes, selectedCount, scopeConfig, percentTarget)) break;
          batch.push(chunk);
          selectedCount++;
          selectedBytes += encoder.encode(chunk).byteLength;
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
      } else {
        if (!text.trim()) throw new Error('请先选择文件或粘贴文本');
        const chunks = splitIntoChunks(text, opts);
        if (chunks.length === 0) throw new Error('分块结果为空');
        const selectedChunks = selectTestChunks(chunks, scopeConfig);
        if (selectedChunks.length === 0) throw new Error('测试范围没有选中任何分块');
        await addChunks(job.id, selectedChunks);
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
    <div className="card">
      <h2>新建任务</h2>
      <div className="form-grid">
        <label>
          任务名称
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：项目群聊天记录 2026" />
        </label>
        <label>
          选择文件（.txt / .log / .md / .json）
          <input type="file" accept=".txt,.log,.md,.json,text/plain,application/json" onChange={(e) => void onFileChange(e)} />
        </label>
      </div>
      <div className="form-grid">
        <label>
          任务类型
          <select value={taskKind} onChange={(e) => setTaskKind(e.target.value as TaskKind)}>
            <option value="knowledge">结构化知识提取</option>
            <option value="custom">自定义文本处理</option>
          </select>
        </label>
        <label>
          处理流程
          <select value={pipelineMode} onChange={(e) => setPipelineMode(e.target.value as PipelineMode)}>
            <option value="staged">多阶段：相关索引 → 目标处理 → 归并</option>
            <option value="direct">直接处理：分块处理 → 归并</option>
          </select>
          <small className="hint">大文件和知识提取推荐多阶段；翻译、改写等线性任务可用直接处理。</small>
        </label>
        <label>
          任务要求（核心目标）
          <textarea
            value={taskInstruction}
            onChange={(e) => setTaskInstruction(e.target.value)}
            placeholder={taskKind === 'custom' ? '例如：翻译成英文，并保留 Markdown 格式' : '例如：提取可复用的编程知识，不要收录闲聊'}
            rows={2}
          />
          <small className="hint">模型优先执行这里的要求；任务类型只决定结果格式。</small>
        </label>
      </div>
      {file ? (
        <p className="muted">已选择文件：{file.name}（{file.size.toLocaleString()} 字节，开始时流式导入）</p>
      ) : (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="或直接粘贴聊天记录文本（大文件请用上方文件选择）…"
          rows={6}
        />
      )}
      <div className="test-scope card-inset">
        <div className="form-grid">
          <label>
            测试提炼范围
            <select value={testScope} onChange={(e) => setTestScope(e.target.value as TestScope)}>
              <option value="all">全部输入</option>
              <option value="percent">按输入百分比</option>
              <option value="sessions">最多知识提炼会话数</option>
            </select>
          </label>
          {testScope === 'percent' && (
            <label>
              输入百分比（1-100）
              <input
                type="number"
                min={1}
                max={100}
                value={testPercent}
                onChange={(e) => setTestPercent(Number(e.target.value) || 1)}
              />
            </label>
          )}
          {testScope === 'sessions' && (
            <label>
              最多提炼会话数
              <input
                type="number"
                min={1}
                max={100000}
                value={testSessionLimit || 1}
                onChange={(e) => setTestSessionLimit(Number(e.target.value) || 1)}
              />
            </label>
          )}
        </div>
        <small className="hint">限制参与知识提炼的原文分块数；归并不计入。多阶段流程每个分块会先索引再处理，设置 3 表示汇总前 3 个分块的知识。</small>
      </div>
      <div className="run-options">
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
          <span>完成后自动删除 DeepSeek 网页会话</span>
        </label>
      </div>
      <details>
        <summary>高级参数</summary>
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
      <div className="actions">
        <button className="primary" disabled={busy || hasActive || (!file && !text)} onClick={() => void onStart()}>
          {busy ? '创建/导入中…' : previewCount != null ? `开始任务（${previewCount.toLocaleString()} 块）` : '开始任务'}
        </button>
        {hasActive && <span className="muted">已有进行中的任务（MVP 单任务）</span>}
        {error && <span className="error">{error}</span>}
      </div>
    </div>
  );
}

function JobDetail({ jobId, onDeleted }: { jobId: string; onDeleted: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [prog, setProg] = useState<JobProgress | null>(null);
  const [finalMd, setFinalMd] = useState<string | null>(null);
  const [finalJson, setFinalJson] = useState<string | null>(null);
  const [finalSkill, setFinalSkill] = useState<string | null>(null);
  const [showResult, setShowResult] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const j = await getJob(jobId);
    setJob(j ?? null);
    if (!j) return;
    setProg(await jobProgress(jobId));
    if (j.status === 'completed' && j.finalResultId) {
      const r = await getResult(j.finalResultId);
      if (r) {
        if (typeof r.parsed === 'string') {
          setFinalMd(r.parsed);
          setFinalJson(null);
          setFinalSkill(null);
        } else if (isExtractionResult(r.parsed)) {
          setFinalMd(renderKnowledgeMarkdown(r.parsed, j.name));
          setFinalSkill(renderSkillMarkdown(r.parsed, j.name));
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
  const run = (cmd: Record<string, unknown>) => {
    setError(null);
    void sendCmd(cmd)
      .then(load)
      .catch((e) => setError(errMsg(e)));
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
    <div className="card">
      <div className="detail-header">
        <h2>{job.name}</h2>
        <span className={`chip st-${job.status}`}>{STATUS_LABEL[job.status]}</span>
      </div>
      <p className="muted">
        {job.config.taskKind === 'custom' ? '自定义文本处理' : '结构化知识提取'}
        {` · ${job.config.pipelineMode === 'staged' ? '多阶段流程' : '直接流程'}`}
        {job.config.testScope === 'percent' ? ` · 测试范围 ${job.config.testPercent}%` : ''}
        {job.config.testScope === 'sessions' ? ` · 测试最多 ${job.config.testSessionLimit} 个提炼会话` : ''}
        {job.config.taskInstruction ? ` · 要求：${job.config.taskInstruction}` : ''}
      </p>
      <div className="bar">
        <div className="bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="muted">
        分块 {prog ? `${prog.done}/${prog.total}` : '…'}
        {prog && job.config.pipelineMode === 'staged' ? ` · 已建立索引 ${prog.indexed}/${prog.total}` : ''}
        {prog && prog.failed > 0 ? ` · 失败 ${prog.failed}` : ''}
        {job.reduceState
          ? ` · 归并第 ${job.reduceState.level} 层（${Math.min(job.reduceState.nextGroup + 1, job.reduceState.groups.length)}/${job.reduceState.groups.length} 组）`
          : ''}
        {` · 已发送 ${job.stats.sent} · 已收集 ${job.stats.collected} · 限流 ${job.stats.rateLimitHits} 次`}
        {job.providerSessionRefs.length > 0 ? ` · DeepSeek 网页会话 ${job.providerSessionRefs.length}` : ''}
        {job.sessionCooldownUntil && job.sessionCooldownUntil > Date.now()
          ? ` · 主动冷却至 ${new Date(job.sessionCooldownUntil).toLocaleTimeString()}`
          : ''}
      </p>
      {job.current && (
        <p className="muted">
          当前单元：<code>{job.current.marker}</code>
          {` · 阶段 ${job.current.phase}`}
        </p>
      )}
      {job.status !== 'completed' && job.lastError && <p className="error">最近错误：{job.lastError}</p>}
      <div className="actions">
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

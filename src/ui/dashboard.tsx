/**
 * 工作台页面：建任务（文件 / 粘贴）、任务列表、实时进度、控制操作、结果查看与下载。
 * 数据读取直连 IndexedDB（与 SW 同 origin），控制命令走 runtime 消息。
 */
import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { splitIntoChunks } from '../core/chunking/chunker';
import { streamBlobChunks } from '../core/chunking/streamChunker';
import { renderKnowledgeMarkdown } from '../core/protocol/render';
import { addChunks, appendChunks, createJob, deleteJob, getJob, getResult, jobProgress, listJobs } from '../core/storage/jobStore';
import { DEFAULT_JOB_CONFIG, type Job, type JobConfig, type JobProgress, type JobStatus } from '../core/types';

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
  if (res && res.ok === false) throw new Error(res.error ?? '命令执行失败');
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
            <button
              key={j.id}
              className={`job-item ${j.id === selectedId ? 'selected' : ''}`}
              onClick={() => setSelectedId(j.id)}
            >
              <span className="job-name">{j.name}</span>
              <span className={`chip st-${j.status}`}>{STATUS_LABEL[j.status]}</span>
            </button>
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
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        setPreviewCount(
          splitIntoChunks(text, { maxChars: maxChunkChars, hardMaxChars: DEFAULT_JOB_CONFIG.hardMaxChunkChars }).length,
        );
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
      const config: JobConfig = { ...DEFAULT_JOB_CONFIG, maxChunkChars, fanIn, sendDelayMs };
      const opts = { maxChars: maxChunkChars, hardMaxChars: DEFAULT_JOB_CONFIG.hardMaxChunkChars };
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
      } else {
        if (!text.trim()) throw new Error('请先选择文件或粘贴文本');
        const chunks = splitIntoChunks(text, opts);
        if (chunks.length === 0) throw new Error('分块结果为空');
        await addChunks(job.id, chunks);
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
          选择文件（.txt / .log / .md）
          <input type="file" accept=".txt,.log,.md,text/plain" onChange={(e) => void onFileChange(e)} />
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
      <details>
        <summary>高级参数</summary>
        <div className="form-grid">
          <label>
            分块大小（字符）
            <input
              type="number"
              value={maxChunkChars}
              onChange={(e) => setMaxChunkChars(Number(e.target.value) || DEFAULT_JOB_CONFIG.maxChunkChars)}
            />
          </label>
          <label>
            归并扇入
            <input
              type="number"
              value={fanIn}
              onChange={(e) => setFanIn(Number(e.target.value) || DEFAULT_JOB_CONFIG.fanIn)}
            />
          </label>
          <label>
            发送间隔（毫秒）
            <input
              type="number"
              value={sendDelayMs}
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
        setFinalMd(renderKnowledgeMarkdown(r.parsed, j.name));
        setFinalJson(JSON.stringify(r.parsed, null, 2));
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
      <div className="bar">
        <div className="bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="muted">
        分块 {prog ? `${prog.done}/${prog.total}` : '…'}
        {prog && prog.failed > 0 ? ` · 失败 ${prog.failed}` : ''}
        {job.reduceState
          ? ` · 归并第 ${job.reduceState.level} 层（${Math.min(job.reduceState.nextGroup + 1, job.reduceState.groups.length)}/${job.reduceState.groups.length} 组）`
          : ''}
        {` · 已发送 ${job.stats.sent} · 已收集 ${job.stats.collected} · 限流 ${job.stats.rateLimitHits} 次`}
      </p>
      {job.current && (
        <p className="muted">
          当前单元：<code>{job.current.marker}</code>
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
          </>
        )}
        {!active && (
          <button
            className="danger"
            onClick={() => {
              if (!window.confirm('确定删除该任务及其全部分块与结果？')) return;
              void (async () => {
                await deleteJob(jobId);
                onDeleted();
              })().catch((e) => setError(errMsg(e)));
            }}
          >
            删除
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

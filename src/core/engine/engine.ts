/** Provider 无关的持久化编排引擎。 */
import {
  buildDistillationPrompt,
  buildExtractionPrompt,
  buildFormatPlanPrompt,
  buildNormalizePrompt,
  buildIndexPrompt,
  buildReducePrompt,
  formatMarker,
} from '../protocol/prompts';
import { isExtractionResult, isFormatPlan, isJsonResult, parseFormatPlan, parseIndexResult, parseJsonResult, sanitizeExtraction, sanitizeJsonResult } from '../protocol/schema';
import type { ProviderHost, ProviderInspection } from '../provider';
import { planGroups } from '../reduce/reducePlanner';
import {
  chunkMetasByJob,
  compareChunkOrder,
  commitCollected,
  commitIndexed,
  commitUnitFailure,
  commitReprocessPlan,
  getActiveJobId,
  getChunkMeta,
  getChunkTextById,
  getJob,
  getResult,
  jobProgress,
  listJobs,
  markUnitSubmitted,
  appendJobEvent,
  nextPendingChunk,
  saveChunkMeta,
  saveJob,
  setActiveJobId,
  resultsByJob,
  splitChunkForContextLimit,
} from '../storage/jobStore';
import type { ChunkMeta, CurrentUnit, FormatState, Job, JobStatus, RateLimitEvent, ResultPayload, ResultRecord, UnitKind } from '../types';
import { sleep } from '../util/sleep';
import { isActive, isTerminal, transitionJob } from './stateMachine';
import { planReprocess } from './reprocess';

export interface EngineHost extends ProviderHost {
  scheduleAlarm(name: string, when: number): void;
  clearAlarm(name: string): void;
  log(...args: unknown[]): void;
}

const TIMEOUT_ALARM = (jobId: string): string => `lcw:t:${jobId}`;
const RESUME_ALARM = (jobId: string): string => `lcw:r:${jobId}`;
const RETRY_DELAY_MS = 5_000;
/** generationEnd 可能因页面事件竞态丢失，主动轮询负责可靠收单。 */
const FIRST_RECONCILE_MS = 3_000;
const REGEN_CHECK_MS = 8_000;
const DEEP_THINKING_RECONCILE_MS = 15_000;
const DEEP_THINKING_SETTLE_MS = 10_000;
/** 兼容旧版只持久化 rateLimited=true、没有 retryAfterAt 的任务。 */
/** 旧任务没有持久化 Provider 的 retryAfterAt 时，保守按 65 分钟恢复。 */
const LEGACY_RATE_LIMIT_GRACE_MS = 65 * 60_000;
const RATE_LIMIT_EVENT_HISTORY_LIMIT = 50;
const errMsg = (error: unknown): string => error instanceof Error ? error.message : String(error);

function hasMeaningfulPayload(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some(hasMeaningfulPayload);
  if (value && typeof value === 'object') return Object.values(value).some(hasMeaningfulPayload);
  return false;
}

interface UnitRef {
  kind: UnitKind;
  ref: string;
  prevAttempt: number;
}

export class Engine {
  constructor(private readonly host: EngineHost) {}

  async startJob(jobId: string): Promise<void> {
    const activeId = await getActiveJobId();
    if (activeId && activeId !== jobId) {
      const other = await getJob(activeId);
      if (other && isActive(other.status)) throw new Error('已有进行中的任务，请先暂停或取消');
    }
    let job = await this.mustGet(jobId);
    if (job.status === 'split' || job.status === 'failed') {
      await setActiveJobId(jobId);
      job = await this.to(job, job.current ? 'waiting' : (job.reduceState || job.formatState) ? 'reducing' : 'processing');
    } else if (!isActive(job.status)) {
      throw new Error(`任务当前状态(${job.status})不可启动`);
    } else {
      await setActiveJobId(jobId);
    }
    if (job.current) await this.reconcile(job, 'start');
    else await this.pump(job.id);
  }

  async pump(jobId: string): Promise<void> {
    let job = await getJob(jobId);
    if (!job || !isActive(job.status)) return;
    if (job.current) return this.reconcile(job, 'pump');
    if (job.status === 'waiting') job = await this.to(job, (job.reduceState || job.formatState) ? 'reducing' : 'processing');
    // 没有在途单元时也先探测账号，避免暂停/重启后切换账号仍被旧官方冷却拦截。
    try {
      const connectionId = await this.ensureConnection(job);
      job = await this.syncProviderAccount(job, connectionId);
    } catch {
      // 具体 Provider 不可用时由后续 dispatch 路径按既有错误处理重试。
    }
    if (await this.deferForDispatchCooldown(job)) return;
    job = (await getJob(job.id)) ?? job;
    if (job.status === 'processing') return this.dispatchNextChunkStage(job);
    if (job.status === 'reducing') return this.dispatchNextReduce(job);
  }

  /** 恢复旧版本或已持久化的 Provider 冷却；具体何时冷却由 Provider Adapter 决定。 */
  private async deferForDispatchCooldown(job: Job): Promise<boolean> {
    const now = Date.now();
    const existing = job.sessionCooldownUntil;
    const accountLimit = job.providerAccountKey
      ? (job.providerRateLimits ?? []).find((entry) => entry.providerId === job.providerId &&
        entry.accountKey === job.providerAccountKey && entry.limitedUntil > now)
      : undefined;
    if (accountLimit) {
      let waiting: Job = { ...job, sessionCooldownUntil: accountLimit.limitedUntil,
        sessionCooldownStartedAt: accountLimit.occurredAt,
        sessionCooldownReason: accountLimit.reason,
        sessionCooldownAccountKey: accountLimit.accountKey };
      await saveJob(waiting);
      if (waiting.status !== 'waiting') waiting = await this.to(waiting, 'waiting');
      this.host.scheduleAlarm(RESUME_ALARM(job.id), accountLimit.limitedUntil);
      return true;
    }
    if (existing != null) {
      // 已识别账号时，限流列表是唯一的调度依据。旧摘要不能挡住不在列表中的账号。
      if (job.providerAccountKey && !accountLimit) {
        await saveJob({ ...job, sessionCooldownUntil: undefined, sessionCooldownStartedAt: undefined,
          sessionCooldownReason: undefined, sessionCooldownAccountKey: undefined });
        return false;
      }
      const until = existing;
      if (until > now) {
        this.host.scheduleAlarm(RESUME_ALARM(job.id), until);
        return true;
      }
      job = { ...job, sessionCooldownUntil: undefined, sessionCooldownStartedAt: undefined,
        sessionCooldownReason: undefined, sessionCooldownAccountKey: undefined };
      await saveJob(job);
      return false;
    }
    return false;
  }

  async pause(jobId: string): Promise<void> {
    const job = await getJob(jobId);
    if (!job || !isActive(job.status)) return;
    await this.to(job, 'paused');
    this.host.clearAlarm(TIMEOUT_ALARM(jobId));
    this.host.clearAlarm(RESUME_ALARM(jobId));
  }

  async resume(jobId: string): Promise<void> {
    let job = await getJob(jobId);
    if (!job || job.status !== 'paused') return;
    // 暂停期间 Service Worker/扩展可能被重载，activeJobId 不能只依赖旧内存周期。
    // 先重新声明活动任务，确保 Adapter ready/generation 事件和后续告警都能找到它。
    await setActiveJobId(jobId);
    job = await this.to(job, job.prevStatus ?? (job.reduceState || job.formatState ? 'reducing' : 'processing'));
    if (job.current) {
      await this.onAlarm(RESUME_ALARM(job.id));
    }
    else await this.pump(job.id);
  }

  async cancel(jobId: string): Promise<void> {
    let job = await getJob(jobId);
    if (!job || isTerminal(job.status)) return;
    job = { ...job, current: null };
    await saveJob(job);
    await this.to(job, 'canceled');
    this.host.clearAlarm(TIMEOUT_ALARM(jobId));
    this.host.clearAlarm(RESUME_ALARM(jobId));
    if ((await getActiveJobId()) === jobId) await setActiveJobId(null);
  }

  async retryChunk(jobId: string, index: number): Promise<void> {
    let job = await getJob(jobId);
    const meta = await getChunkMeta(jobId, index);
    if (!job || !meta || meta.status !== 'failed') return;
    const cooldownActive = job.sessionCooldownUntil != null && job.sessionCooldownUntil > Date.now();
    await saveChunkMeta({ ...meta, status: 'pending', attempts: 0, resultId: null, error: null });
    job = { ...job, failedChunks: job.failedChunks.filter((value) => value !== index), reduceState: null, formatState: null,
      finalResultId: null, lastError: null,
      sessionCooldownUntil: cooldownActive ? job.sessionCooldownUntil : undefined,
      sessionCooldownStartedAt: cooldownActive ? job.sessionCooldownStartedAt : undefined,
      sessionCooldownReason: cooldownActive ? job.sessionCooldownReason : undefined,
      sessionCooldownAccountKey: cooldownActive ? job.sessionCooldownAccountKey : undefined };
    await saveJob(job);
    if (job.status === 'failed' || job.status === 'completed') job = await this.to(job, 'processing');
    if (isActive(job.status)) {
      // 失败任务可能是在扩展重载后手动重试，旧的 activeJobId 不一定还存在。
      // 先重新声明活动任务，确保 Adapter 事件和后续告警都能找到它。
      await setActiveJobId(job.id);
      await this.pump(job.id);
    }
  }

  async retryFailed(jobId: string): Promise<void> {
    let job = await getJob(jobId);
    if (!job) return;
    if (job.status === 'paused' && job.failedChunks.length > 0) {
      const cooldownActive = job.sessionCooldownUntil != null && job.sessionCooldownUntil > Date.now();
      for (const index of job.failedChunks) {
        const meta = await getChunkMeta(jobId, index);
        if (meta?.status === 'failed') {
          await saveChunkMeta({ ...meta, status: 'pending', attempts: 0, resultId: null, error: null });
        }
      }
      await saveJob({
        ...job,
        failedChunks: [],
        reduceState: null,
        formatState: null,
        finalResultId: null,
        lastError: null,
        sessionCooldownUntil: cooldownActive ? job.sessionCooldownUntil : undefined,
        sessionCooldownStartedAt: cooldownActive ? job.sessionCooldownStartedAt : undefined,
        sessionCooldownReason: cooldownActive ? job.sessionCooldownReason : undefined,
        sessionCooldownAccountKey: cooldownActive ? job.sessionCooldownAccountKey : undefined,
      });
      return;
    }
    // 模糊投递保留 current；恢复动作首先对账，绝不直接重发。
    if (job.current) {
      if (job.status === 'failed') job = await this.to(job, 'waiting');
      await setActiveJobId(job.id);
      return this.reconcile(job, 'manual recovery');
    }
    for (const index of job.failedChunks) {
      const meta = await getChunkMeta(jobId, index);
      if (meta?.status === 'failed') await saveChunkMeta({ ...meta, status: 'pending', attempts: 0, resultId: null, error: null });
    }
    const cooldownActive = job.sessionCooldownUntil != null && job.sessionCooldownUntil > Date.now();
    job = {
      ...job,
      failedChunks: [],
      reduceState: null,
      formatState: null,
      finalResultId: null,
      lastError: null,
      sessionCooldownUntil: cooldownActive ? job.sessionCooldownUntil : undefined,
      sessionCooldownStartedAt: cooldownActive ? job.sessionCooldownStartedAt : undefined,
      sessionCooldownReason: cooldownActive ? job.sessionCooldownReason : undefined,
      sessionCooldownAccountKey: cooldownActive ? job.sessionCooldownAccountKey : undefined,
    };
    await saveJob(job);
    if (job.status === 'failed' || job.status === 'completed') job = await this.to(job, 'processing');
    await setActiveJobId(job.id);
    if (isActive(job.status)) await this.pump(job.id);
  }

  /** 仅供用户确认远端未收到请求后使用；这是唯一允许主动越过模糊投递保护的入口。 */
  async forceRetryCurrent(jobId: string): Promise<void> {
    let job = await getJob(jobId);
    if (!job?.current || job.status !== 'failed') return;
    job = await this.to(job, 'waiting');
    await setActiveJobId(job.id);
    await this.resend(job, '用户确认远端未收到请求', true);
  }

  /** 用户已在 Provider 网页端手工点击继续生成；这里只读确认结果，不代替用户点击。 */
  async manualContinue(jobId: string): Promise<void> {
    let job = await getJob(jobId);
    if (!job?.current || !isActive(job.status) || !job.current.rateLimited) return;
    job = {
      ...job,
      current: { ...job.current, manualIntervention: true, continuationProbeAt: undefined },
      lastError: null,
    };
    await saveJob(appendJobEvent(job, 'manual-intervention', '用户确认已手工继续生成，开始只读确认'));
    await this.reconcile(job, 'manual intervention');
  }

  /** 删除本任务创建的 Provider 网页会话，但保留本地任务与提炼结果。 */
  async cleanupSessions(jobId: string): Promise<void> {
    const job = await this.mustGet(jobId);
    if (isActive(job.status)) throw new Error('任务仍在运行，请完成或取消后再清理网页会话');
    const refs = Array.isArray(job.providerSessionRefs) ? job.providerSessionRefs : [];
    if (refs.length === 0) return;
    if (!this.host.cleanupSessions) throw new Error('当前 Provider 不支持删除网页会话');
    const connectionId = await this.host.connect(job);
    const result = await this.host.cleanupSessions(connectionId, refs);
    const deleted = new Set(result.deletedRefs);
    const remaining = refs.filter((ref) => !deleted.has(ref));
    await saveJob({
      ...job,
      providerConnectionId: connectionId,
      providerSessionRefs: remaining,
      lastError: remaining.length > 0 ? `仍有 ${remaining.length} 个网页会话未确认删除` : null,
    });
    if (remaining.length > 0) throw new Error(`仍有 ${remaining.length} 个网页会话未确认删除，请稍后重试`);
  }

  async resumeActive(): Promise<void> {
    const activeId = await getActiveJobId();
    let job = activeId ? await getJob(activeId) : undefined;
    if (!job || !isActive(job.status)) {
      // 扩展重载或旧版本迁移后，KV 活动指针可能丢失，但任务状态仍可靠地持久化在 jobs 表中。
      // 按更新时间恢复唯一应继续的任务，避免任务永久停在 waiting 而没有任何告警。
      const candidates = (await listJobs())
        .filter((candidate) => isActive(candidate.status))
        .sort((left, right) => right.updatedAt - left.updatedAt);
      job = candidates[0];
      if (!job) {
        if (activeId) await setActiveJobId(null);
        return;
      }
      await setActiveJobId(job.id);
      if (candidates.length > 1) {
        this.host.log('检测到多个活动任务，恢复最近更新的任务', job.id, candidates.length);
      }
    }
    this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + 250);
  }

  async onAlarm(name: string): Promise<void> {
    const match = /^lcw:([tr]):(.+)$/.exec(name);
    if (!match?.[2]) return;
    let job = await getJob(match[2]);
    if (!job || !isActive(job.status)) return;
    if (job.current || job.sessionCooldownUntil != null || job.providerRateLimits?.length) {
      try {
        const connectionId = await this.ensureConnection(job);
        job = await this.syncProviderAccount(job, connectionId);
      } catch {
        // 对账路径会报告 Provider 暂不可用；告警处理不能因此丢失持久化状态。
      }
    }
    if (await this.deferForDispatchCooldown(job)) return;
    job = (await getJob(job.id)) ?? job;
    if (job.current?.rateLimited) {
      if (job.current.manualIntervention) {
        await this.reconcile(job, 'manual intervention after cooldown');
        return;
      }
      const retryAfterAt = job.current.retryAfterAt ?? Date.now() + LEGACY_RATE_LIMIT_GRACE_MS;
      if (!job.current.retryAfterAt) {
        await saveJob({ ...job, current: { ...job.current, retryAfterAt } });
      }
      if (retryAfterAt > Date.now()) {
        this.host.scheduleAlarm(RESUME_ALARM(job.id), retryAfterAt);
        return;
      }
      if (match[1] === 'r' || match[1] === 't') {
        await this.resend(job, 'Provider 限流退避结束');
        return;
      }
    }
    if (job.current) await this.reconcile(job, match[1] === 't' ? 'timeout' : 'retry');
    else await this.pump(job.id);
  }

  async onAdapterReady(connectionId: string, accountKey?: string, accountLabel?: string): Promise<void> {
    const job = await this.activeJob();
    if (!job || (job.providerConnectionId && job.providerConnectionId !== connectionId)) return;
    const changed = !!accountKey && accountKey !== job.providerAccountKey;
    const synced = await this.syncProviderAccount(job, connectionId, accountKey, accountLabel);
    if (changed && isActive(synced.status)) {
      this.host.scheduleAlarm(RESUME_ALARM(synced.id), Date.now() + 1);
      return;
    }
    if (synced.current) this.host.scheduleAlarm(RESUME_ALARM(synced.id), Date.now() + 1_500);
  }

  async onGenerationStart(_connectionId: string): Promise<void> {}

  async onGenerationEnd(connectionId: string): Promise<void> {
    const job = await this.activeJob();
    if (!job || !job.current || job.providerConnectionId !== connectionId) return;
    if (job.status !== 'waiting' && job.status !== 'paused') return;
    const observed = appendJobEvent(job, 'generation-end', `${job.current.kind}/${job.current.ref} 收到 Provider 生成结束事件`);
    await saveJob(observed);
    if (job.current.rateLimited && !job.current.manualIntervention) {
      // 限流期间的手工操作必须由用户点击“我已手工继续生成”确认后才对账。
      this.host.scheduleAlarm(RESUME_ALARM(job.id), job.current.retryAfterAt ?? Date.now() + LEGACY_RATE_LIMIT_GRACE_MS);
      return;
    }
    if (job.config.deepThinking) {
      this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + DEEP_THINKING_SETTLE_MS);
    } else {
      await this.reconcile(observed, 'generation end');
    }
  }

  /** 由用户选择当前有效会话后重跑；历史结果只读保留，后续阶段按依赖自动重建。 */
  async reprocessResults(jobId: string, resultIds: string[]): Promise<void> {
    const activeId = await getActiveJobId();
    if (activeId && activeId !== jobId) {
      const other = await getJob(activeId);
      if (other && isActive(other.status)) throw new Error('已有进行中的任务，请先暂停或取消');
    }
    const job = await this.mustGet(jobId);
    const metas = await chunkMetasByJob(jobId);
    const records = await resultsByJob(jobId);
    const plan = planReprocess(job, metas, records, resultIds);
    const transitioned = transitionJob(plan.job, plan.nextStatus, Date.now());
    await commitReprocessPlan(transitioned, plan.changedChunks);
    await setActiveJobId(jobId);
    const next = await getJob(jobId);
    if (next) await this.pump(next.id);
  }


  async onRateLimited(connectionId: string, detail: string, retryAfterMs?: number, continuationRetryAfterMs?: number, accountKey?: string, accountLabel?: string): Promise<void> {
    const job = await this.activeJob();
    if (!job || job.providerConnectionId !== connectionId) return;
    const synced = await this.syncProviderAccount(job, connectionId, accountKey, accountLabel);
    await this.noteRateLimit(synced, detail, retryAfterMs, continuationRetryAfterMs, accountKey, accountLabel);
  }

  async onAdapterError(connectionId: string, detail: string): Promise<void> {
    const job = await this.activeJob();
    if (!job || job.providerConnectionId !== connectionId) return;
    await saveJob(appendJobEvent({ ...job, lastError: detail }, 'provider-error', detail));
    this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + RETRY_DELAY_MS);
  }

  async onRemoteRefChanged(connectionId: string, remoteRef: string): Promise<void> {
    const job = await this.activeJob();
    if (!job?.current || job.providerConnectionId !== connectionId || !remoteRef) return;
    const refs = Array.isArray(job.providerSessionRefs) ? job.providerSessionRefs : [];
    await saveJob({
      ...job,
      providerSessionRefs: refs.includes(remoteRef) ? refs : [...refs, remoteRef],
      current: { ...job.current, remoteRef },
    });
  }

  async onConnectionGone(jobId: string, connectionId: string): Promise<void> {
    const job = await getJob(jobId);
    if (!job || job.providerConnectionId !== connectionId) return;
    await saveJob({ ...job, providerConnectionId: null });
    if (job.current && isActive(job.status)) this.host.scheduleAlarm(RESUME_ALARM(jobId), Date.now() + 3_000);
  }

  private async mustGet(jobId: string): Promise<Job> {
    const job = await getJob(jobId);
    if (!job) throw new Error('任务不存在');
    return job;
  }

  private async activeJob(): Promise<Job | null> {
    const id = await getActiveJobId();
    return id ? (await getJob(id)) ?? null : null;
  }

  private async to(job: Job, status: JobStatus): Promise<Job> {
    const next = transitionJob(job, status, Date.now());
    await saveJob(next);
    return next;
  }

  private async dispatchNextChunkStage(job: Job): Promise<void> {
    if (job.config.taskKind === 'knowledge' && job.config.pipelineMode === 'staged' && !job.formatPlanResultId) {
      return this.dispatchInitialFormat(job);
    }
    const metas = (await chunkMetasByJob(job.id)).sort(compareChunkOrder);
    // 多阶段流程有全局屏障：必须先为所有分块建立索引，才允许进入目标处理阶段。
    // 否则模型会在索引尚未完整时开始深炼，导致跨块事件无法对齐。
    const meta = job.config.pipelineMode === 'staged'
      ? (metas.find((candidate) => candidate.status === 'pending' && !candidate.indexResultId)
        ?? metas.find((candidate) => candidate.status === 'pending' && candidate.indexResultId))
      : await nextPendingChunk(job.id);
    if (!meta) {
      const progress = await jobProgress(job.id);
      if (progress.sent > 0) return;
      if (progress.failed > 0) {
        const reason = job.lastError ? `；最近原因：${job.lastError}` : '';
        return this.failJob(job, `有 ${progress.failed} 个分块失败，请重试后再归并${reason}`);
      }
      return this.beginReduce(job);
    }
    const text = await getChunkTextById(meta.id);
    if (text == null) return this.failUnit(job, `chunk ${meta.index} 内容缺失`);
    const shouldIndex = job.config.pipelineMode === 'staged' && !meta.indexResultId && meta.stage !== 'process';
    if (shouldIndex) {
      return this.dispatchUnit(job, { kind: 'index', ref: String(meta.index), prevAttempt: meta.attempts },
        async (marker) => buildIndexPrompt(marker, `chunk-${meta.index}`, text, await this.promptOptions(job)), meta);
    }
    const indexResult = meta.indexResultId ? await getResult(meta.indexResultId) : undefined;
    if (job.config.pipelineMode === 'staged' && !indexResult) {
      return this.failUnit(job, `chunk ${meta.index} 索引结果缺失`);
    }
    return this.dispatchUnit(job, { kind: 'extract', ref: String(meta.index), prevAttempt: meta.attempts },
      async (marker) => indexResult
        ? buildDistillationPrompt(marker, text, indexResult.raw, await this.promptOptions(job))
        : buildExtractionPrompt(marker, text, await this.promptOptions(job)), meta);
  }

  /** 在首次索引/提炼前，先让 Provider 根据任务目标和少量原文样本给出格式规范。 */
  private async dispatchInitialFormat(job: Job): Promise<void> {
    const samples = await this.loadChunkSamples(job.id);
    if (samples.length === 0) return this.failJob(job, '没有可用于生成格式规范的原文分块');
    const matched = job.current?.kind === 'format' && job.current.ref === 'preflight' ? job.current : null;
    const prevAttempt = Math.max(0, (matched?.attempt ?? 0) - (matched?.rateLimited ? 1 : 0));
    return this.dispatchUnit(job, { kind: 'format', ref: 'preflight', prevAttempt },
      async (marker) => buildFormatPlanPrompt(marker, samples, await this.promptOptions(job)));
  }

  private async loadChunkSamples(jobId: string): Promise<string[]> {
    const metas = (await chunkMetasByJob(jobId)).sort(compareChunkOrder).slice(0, 3);
    const samples: string[] = [];
    for (const meta of metas) {
      const text = await getChunkTextById(meta.id);
      if (text != null && text.trim()) samples.push(text.slice(0, 4_000));
    }
    return samples;
  }

  private async promptOptions(job: Job) {
    const planId = job.formatState?.planResultId ?? job.formatPlanResultId;
    const plan = planId ? await getResult(planId) : undefined;
    return { ...job.config, formatPlan: plan?.raw };
  }

  private async parseTaskResult(job: Job, raw: string): Promise<ResultPayload | null> {
    if (job.config.taskKind === 'custom') return raw.trim() || null;
    const planId = job.formatState?.planResultId ?? job.formatPlanResultId;
    if (planId) {
      const planResult = await getResult(planId);
      if (planResult && isFormatPlan(planResult.parsed) && planResult.parsed.output?.mode === 'json') {
        const parsed = parseJsonResult(raw);
        return parsed ? sanitizeJsonResult(parsed) : null;
      }
    }
    return sanitizeExtraction(raw);
  }

  private async dispatchNextReduce(job: Job): Promise<void> {
    if (job.formatState) {
      if (job.formatState.phase === 'planning') {
        const matched = job.current?.kind === 'format' && job.current.ref === 'plan' ? job.current : null;
        const prevAttempt = Math.max(0, (matched?.attempt ?? 0) - (matched?.rateLimited ? 1 : 0));
        const samples = await this.loadFormatSamples(job.formatState.inputIds);
        return this.dispatchUnit(job, { kind: 'format', ref: 'plan', prevAttempt },
          async (marker) => buildFormatPlanPrompt(marker, samples, await this.promptOptions(job)));
      }
      if (job.formatState.phase === 'normalizing') {
        const state = job.formatState;
        if (!state.planResultId) return this.failJob(job, '动态格式规范缺失');
        if (state.nextGroup >= state.groups.length) return this.finishFormatNormalization(job);
        const reused = state.reusedOutputIds?.[state.nextGroup];
        if (reused) {
          const advanced: FormatState = {
            ...state,
            nextGroup: state.nextGroup + 1,
            outputIds: [...state.outputIds, reused],
          };
          await saveJob({ ...job, formatState: advanced });
          return this.dispatchNextReduce({ ...job, formatState: advanced });
        }
        const group = state.groups[state.nextGroup];
        if (!group) return this.failJob(job, `格式统一分组缺失: ${state.nextGroup}`);
        const plan = await getResult(state.planResultId);
        const results = await this.loadResults(state.inputIds.slice(group.start, group.end));
        if (!plan || results.length !== group.end - group.start) return this.failJob(job, '格式统一输入缺失');
        const ref = `batch-${state.nextGroup}`;
        const matched = job.current?.kind === 'normalize' && job.current.ref === ref ? job.current : null;
        const prevAttempt = Math.max(0, (matched?.attempt ?? 0) - (matched?.rateLimited ? 1 : 0));
        return this.dispatchUnit(job, { kind: 'normalize', ref, prevAttempt },
          async (marker) => buildNormalizePrompt(
            marker,
            plan.raw,
            results.map((result) => JSON.stringify(result.parsed)),
            await this.promptOptions(job),
          ));
      }
    }
    let state = job.reduceState;
    if (!state) return this.beginReduce(job);
    if (state.nextGroup >= state.groups.length) {
      if (state.outputIds.length === 0) return this.failJob(job, '归并未产出任何结果');
      if (state.outputIds.length === 1) return this.finalize(job, state.outputIds[0]!);
      const results = await this.loadResults(state.outputIds);
      if (results.length !== state.outputIds.length) return this.failJob(job, '归并结果记录缺失');
      const groups = planGroups(results.map((r) => r.raw.length),
        { fanIn: job.config.fanIn, maxChars: Math.min(job.config.maxChunkChars, job.contextInputBudget ?? Infinity) });
      if (groups.length >= state.outputIds.length) {
        return this.failJob(job, '归并输入超过预算且无法继续收敛；请提高归并预算或缩小提炼结果');
      }
      state = { level: state.level + 1, inputIds: state.outputIds, groups, nextGroup: 0, outputIds: [] };
      job = { ...job, reduceState: state };
      await saveJob(job);
    }
    const groupIndex = state.nextGroup;
    const group = state.groups[groupIndex];
    if (!group) return this.failJob(job, `归并分组缺失: ${groupIndex}`);
    const reused = state.reusedOutputIds?.[groupIndex];
    if (reused) {
      const advanced = { ...state, nextGroup: state.nextGroup + 1, outputIds: [...state.outputIds, reused] };
      await saveJob({ ...job, reduceState: advanced });
      return this.dispatchNextReduce({ ...job, reduceState: advanced });
    }
    const ids = state.inputIds.slice(group.start, group.end);
    const results = await this.loadResults(ids);
    if (results.length !== ids.length) return this.failJob(job, `归并输入缺失: level ${state.level} group ${groupIndex}`);
    const ref = `${state.level}-${groupIndex}`;
    const matched = job.current?.kind === 'reduce' && job.current.ref === ref ? job.current : null;
    const prevAttempt = Math.max(0, (matched?.attempt ?? 0) - (matched?.rateLimited ? 1 : 0));
    return this.dispatchUnit(job, { kind: 'reduce', ref, prevAttempt },
      async (marker) => buildReducePrompt(marker, results.map((r) => r.raw), await this.promptOptions(job), state.groups.length === 1));
  }

  private async loadFormatSamples(inputIds: string[]): Promise<string[]> {
    const results = await this.loadResults(inputIds);
    const maxTotalChars = 48_000;
    let totalChars = 0;
    return results.map((result) => {
      if (totalChars >= maxTotalChars) return '';
      if (isJsonResult(result.parsed)) {
        const sample = JSON.stringify(isExtractionResult(result.parsed)
          ? {
              knowledge: result.parsed.knowledge.slice(0, 4),
              ...(result.parsed.people ? { people: result.parsed.people.slice(0, 4) } : {}),
            }
          : result.parsed);
        const bounded = sample.slice(0, Math.min(4_000, maxTotalChars - totalChars));
        totalChars += bounded.length;
        return bounded;
      }
      const bounded = result.raw.slice(0, Math.min(4_000, maxTotalChars - totalChars));
      totalChars += bounded.length;
      return bounded;
    }).filter(Boolean);
  }

  private async finishFormatNormalization(job: Job): Promise<void> {
    const state = job.formatState;
    if (!state || state.outputIds.length === 0) return this.failJob(job, '格式统一未产出结果');
    if (state.outputIds.length === 1) {
      const next = { ...job, formatState: null, reduceState: {
        level: 1,
        inputIds: state.outputIds,
        groups: [{ start: 0, end: 1 }],
        nextGroup: 0,
        outputIds: [],
      } };
      await saveJob(next);
      return this.dispatchNextReduce(next);
    }
    const results = await this.loadResults(state.outputIds);
    if (results.length !== state.outputIds.length) return this.failJob(job, '格式统一结果缺失');
    const groups = planGroups(results.map((result) => result.raw.length), {
      fanIn: job.config.fanIn,
      maxChars: Math.min(job.config.maxChunkChars, job.contextInputBudget ?? Infinity),
    });
    if (groups.length >= state.outputIds.length) return this.failJob(job, '格式统一结果超过归并预算且无法收敛');
    const next = {
      ...job,
      formatState: null,
      reduceState: { level: 1, inputIds: state.outputIds, groups, nextGroup: 0, outputIds: [] },
    };
    await saveJob(next);
    return this.dispatchNextReduce(next);
  }

  private async dispatchUnit(
    job: Job,
    unit: UnitRef,
    makePrompt: (marker: string) => string | Promise<string>,
    meta?: ChunkMeta,
  ): Promise<void> {
    const attempt = Math.max(
      unit.prevAttempt + 1,
      (job.reprocessAttemptBases?.[`${unit.kind}:${unit.ref}`] ?? -1) + 1,
    );
    const marker = formatMarker({ jobShort: job.shortId, kind: unit.kind, ref: unit.ref, attempt });
    const current: CurrentUnit = {
      kind: unit.kind,
      ref: unit.ref,
      attempt,
      marker,
      phase: 'prepared',
      outputFormat: unit.kind === 'index' || job.config.taskKind !== 'custom' ? 'knowledge-json' : 'text',
      deepThinking: job.config.deepThinking,
      smartSearch: job.config.smartSearch,
      remoteRef: null,
    };
    job = { ...job, current };
    await saveJob(job);
    await sleep(job.config.sendDelayMs);
    let fresh = await getJob(job.id);
    if (!fresh || fresh.status === 'paused' || fresh.status === 'canceled' || fresh.current?.marker !== marker) return;
    const basePrompt = await makePrompt(marker);
    const prompt = attempt > 1
      ? `${basePrompt}\n\n【重试纠偏】\n上一次回复被程序判定为无实际内容或不可用。请重新核对原始输入和用户目标，提取确实存在的依据；不要再次返回空对象、空数组或仅包含空数组的结果。除非原文确实没有任何相关信息，否则至少输出一条有具体内容的结果。`
      : basePrompt;
    await this.submitPrepared(fresh, prompt, meta);
  }

  private async submitPrepared(job: Job, prompt: string, meta?: ChunkMeta): Promise<void> {
    const current = job.current;
    if (!current || current.phase !== 'prepared') return;
    const marker = current.marker;
    try {
      const connectionId = await this.ensureConnection(job);
      job = await this.syncProviderAccount(job, connectionId);
      if (await this.deferForProviderAccountLimit(job)) return;
      const pacedJob = { ...job, current: { ...job.current!, inputChars: prompt.length } };
      if (await this.deferForProviderCooldown(pacedJob, prompt.length)) return;
      const preparation = await this.host.prepare(connectionId, job.current!);
      if (preparation?.status === 'retry_current') {
        return this.retryUnavailableUnit(job, preparation);
      }
      const fresh = await getJob(job.id);
      if (!fresh || fresh.status === 'paused' || fresh.status === 'canceled' || fresh.current?.marker !== marker) return;
      job = { ...fresh, current: { ...fresh.current!, phase: 'submitting', inputChars: prompt.length,
        submissionAccountKey: fresh.providerAccountKey }, providerConnectionId: connectionId };
      await saveJob(job);
      const outcome = await this.host.submit(connectionId, marker, prompt);
      if (outcome.status === 'accepted') {
        const acknowledged = await markUnitSubmitted(job.id, marker, connectionId, outcome.remoteRef, current.kind, meta?.index);
        if (!acknowledged || acknowledged.status === 'paused' || acknowledged.status === 'canceled') return;
        job = acknowledged.status === 'waiting' ? acknowledged : await this.to(acknowledged, 'waiting');
        // 不只依赖 content script 的 generationEnd：它可能在短回答或 SW 唤醒竞态中丢失。
        this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + this.reconcileDelay(job, FIRST_RECONCILE_MS));
        this.host.scheduleAlarm(TIMEOUT_ALARM(job.id), Date.now() + job.config.generationTimeoutMs);
      } else if (outcome.status === 'rate_limited') {
        await this.noteRateLimit(job, outcome.detail, outcome.retryAfterMs, outcome.continuationRetryAfterMs);
      } else if (outcome.status === 'retry_current') {
        await this.retryUnavailableUnit(job, outcome);
      } else if (outcome.status === 'retryable') {
        await this.scheduleSafeRetry(job, outcome.detail, outcome.retryAfterMs);
      } else if (outcome.status === 'rejected') {
        await this.resend(job, `Provider 明确拒绝提交: ${outcome.detail}`);
      } else {
        await this.failJob(job, `提交结果不明确，已停止自动重发以避免重复发送: ${outcome.detail}`, true);
      }
    } catch (error) {
      await this.failJob(job, `提交过程失联，已停止自动重发以避免重复发送: ${errMsg(error)}`, true);
    }
  }

  private async scheduleSafeRetry(job: Job, detail: string, retryAfterMs: number): Promise<void> {
    if (!job.current) return;
    job = { ...job, current: { ...job.current, phase: 'prepared' }, lastError: detail };
    await saveJob(job);
    if (job.status !== 'waiting' && job.status !== 'paused') job = await this.to(job, 'waiting');
    this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + Math.max(RETRY_DELAY_MS, retryAfterMs));
  }

  /** Provider 在已生成提示、尚未创建网页会话前要求主动冷却。 */
  private async deferForProviderCooldown(job: Job, inputChars: number): Promise<boolean> {
    const now = Date.now();
    const advice = await this.host.getDispatchCooldown?.(job, inputChars, now);
    if (!advice || advice.until <= now || !job.current) return false;
    const existingLimit = job.providerAccountKey && (job.providerRateLimits ?? []).find((entry) =>
      entry.providerId === job.providerId && entry.accountKey === job.providerAccountKey && entry.limitedUntil > now,
    );
    if (existingLimit && existingLimit.kind !== 'proactive') return false;
    const until = Math.max(now + RETRY_DELAY_MS, advice.until);
    const providerRateLimits = job.providerAccountKey
      ? [
        ...(job.providerRateLimits ?? []).filter((entry) =>
          !(entry.providerId === job.providerId && entry.accountKey === job.providerAccountKey),
        ),
        {
          providerId: job.providerId,
          accountKey: job.providerAccountKey,
          accountLabel: job.providerAccountLabel,
          kind: 'proactive' as const,
          limitedUntil: until,
          occurredAt: now,
          reason: advice.detail,
        },
      ]
      : job.providerRateLimits;
    let waiting: Job = {
      ...job,
      current: { ...job.current, inputChars },
      sessionCooldownUntil: until,
      sessionCooldownStartedAt: now,
      sessionCooldownReason: advice.detail,
      sessionCooldownAccountKey: job.providerAccountKey,
      providerRateLimits,
      lastError: null,
    };
    await saveJob(waiting);
    this.host.log('Provider 主动冷却', {
      jobId: waiting.shortId,
      at: new Date(now).toISOString(),
      until: new Date(until).toISOString(),
      inputChars,
      reason: advice.detail,
    });
    if (waiting.status !== 'waiting' && waiting.status !== 'paused') waiting = await this.to(waiting, 'waiting');
    this.host.clearAlarm(TIMEOUT_ALARM(waiting.id));
    this.host.scheduleAlarm(RESUME_ALARM(waiting.id), until);
    return true;
  }

  private async ensureConnection(job: Job): Promise<string> {
    // 持久化的连接 ID 可能指向已关闭的标签页。交由 Provider 验证并重新绑定，
    // 避免对账一直使用失效 ID 反复报错。
    const id = await this.host.connect(job);
    if (id !== job.providerConnectionId) await saveJob({ ...job, providerConnectionId: id });
    return id;
  }

  /** 同步当前 Provider 账号，并在切换账号后解除旧账号留下的在途限流阻塞。 */
  private async syncProviderAccount(job: Job, connectionId: string, accountKey?: string, accountLabel?: string): Promise<Job> {
    const identity = accountKey
      ? { key: accountKey, label: accountLabel }
      : await this.host.getAccountIdentity?.(connectionId);
    const observed = identity?.key;
    if (!observed) {
      if (job.providerConnectionId === connectionId) return job;
      const rebound = { ...job, providerConnectionId: connectionId };
      await saveJob(rebound);
      return rebound;
    }
    const accountCooldownSwitched = !!job.sessionCooldownAccountKey &&
      job.sessionCooldownAccountKey !== observed;
    const accountSwitched = !!job.providerAccountKey && job.providerAccountKey !== observed;
    const legacyCooldown = !accountSwitched && !accountCooldownSwitched &&
      (job.sessionCooldownUntil ?? 0) > Date.now() &&
      !(job.providerRateLimits ?? []).some((entry) => entry.providerId === job.providerId && entry.accountKey === observed);
    if (
      observed === job.providerAccountKey &&
      !legacyCooldown &&
      job.providerConnectionId === connectionId &&
      (identity?.label === undefined || identity.label === job.providerAccountLabel)
    ) return job;
    const switched = job.current?.rateLimited === true &&
      (accountSwitched || (!!job.current.rateLimitAccountKey && job.current.rateLimitAccountKey !== observed));
    const providerRateLimits = legacyCooldown ? [...(job.providerRateLimits ?? []), {
      providerId: job.providerId, accountKey: observed, accountLabel: identity?.label,
      kind: job.sessionCooldownReason?.startsWith('Provider 官方限流') ? 'official' as const : 'proactive' as const,
      occurredAt: job.sessionCooldownStartedAt ?? Date.now(), limitedUntil: job.sessionCooldownUntil!,
      reason: job.sessionCooldownReason,
    }] : job.providerRateLimits;
    const next: Job = {
      ...job,
      providerConnectionId: connectionId,
      providerAccountKey: observed,
      providerAccountLabel: identity?.label ?? (accountSwitched ? undefined : job.providerAccountLabel),
      providerAccountChangedAt: accountSwitched ? Date.now() : job.providerAccountChangedAt,
      providerRateLimits,
      sessionCooldownUntil: accountCooldownSwitched || accountSwitched ? undefined : job.sessionCooldownUntil,
      sessionCooldownStartedAt: accountCooldownSwitched || accountSwitched ? undefined : job.sessionCooldownStartedAt,
      sessionCooldownReason: accountCooldownSwitched || accountSwitched ? undefined : job.sessionCooldownReason,
      sessionCooldownAccountKey: accountCooldownSwitched || accountSwitched ? undefined : legacyCooldown ? observed : job.sessionCooldownAccountKey,
      current: switched && job.current ? {
        ...job.current,
        rateLimited: undefined,
        rateLimitAccountKey: undefined,
        retryAfterAt: undefined,
        continuationProbeAt: undefined,
        manualIntervention: undefined,
      } : job.current,
      lastError: switched ? null : job.lastError,
    };
    await saveJob(next);
    return next;
  }

  /** 发送准备前统一检查当前账号的限流列表。 */
  private async deferForProviderAccountLimit(job: Job): Promise<boolean> {
    const current = job;
    const accountKey = current.providerAccountKey;
    if (!accountKey) return false;
    const now = Date.now();
    const active = (current.providerRateLimits ?? []).find((entry) =>
      entry.providerId === current.providerId && entry.accountKey === accountKey && entry.limitedUntil > now,
    );
    if (!active || !current.current) return false;
    const waiting = appendJobEvent({ ...current, sessionCooldownUntil: active.limitedUntil,
      sessionCooldownStartedAt: active.occurredAt, sessionCooldownReason: active.reason,
      sessionCooldownAccountKey: active.accountKey,
      lastError: active.reason ?? '当前 Provider 账号仍在限流冷却中' }, 'rate-limit-wait',
      `当前账号限流至 ${new Date(active.limitedUntil).toLocaleTimeString()}`);
    await saveJob(waiting);
    if (waiting.status !== 'waiting' && waiting.status !== 'paused') await this.to(waiting, 'waiting');
    this.host.clearAlarm(TIMEOUT_ALARM(waiting.id));
    this.host.scheduleAlarm(RESUME_ALARM(waiting.id), active.limitedUntil);
    return true;
  }

  private async reconcile(job: Job, why: string): Promise<void> {
    if (job.status === 'paused' || !job.current) return;
    let unit: CurrentUnit | null = job.current;
    if (!unit) return;
    if (unit.phase === 'prepared') return this.resumePrepared(job);
    try {
      const connectionId = await this.ensureConnection(job);
      job = await this.syncProviderAccount(job, connectionId);
      unit = job.current;
      if (!unit) return;
      const rateLimited = job.current?.rateLimited === true &&
        (!job.current.rateLimitAccountKey || !job.providerAccountKey || job.current.rateLimitAccountKey === job.providerAccountKey);
      const retryAfterAt = job.current?.retryAfterAt ?? Date.now() + LEGACY_RATE_LIMIT_GRACE_MS;
      if (rateLimited && !job.current?.retryAfterAt) {
        job = { ...job, current: { ...job.current!, retryAfterAt } };
        await saveJob(job);
      }
      if (rateLimited && retryAfterAt <= Date.now()) return this.resend(job, 'Provider 限流退避结束');
      const preparation = await this.host.prepare(connectionId, unit);
      if (preparation?.status === 'retry_current') {
        if (rateLimited && retryAfterAt > Date.now()) {
          await saveJob({ ...job, lastError: preparation.detail });
          this.host.scheduleAlarm(RESUME_ALARM(job.id), retryAfterAt);
          return;
        }
        return this.retryUnavailableUnit(job, preparation);
      }
      await this.handleInspection(job, await this.host.inspect(connectionId, unit), why);
    } catch (error) {
      await saveJob({ ...job, lastError: `Provider 暂不可用: ${errMsg(error)}` });
      this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + RETRY_DELAY_MS);
    }
  }

  private async resumePrepared(job: Job): Promise<void> {
    const unit = job.current;
    if (!unit || unit.phase !== 'prepared') return;
    if (unit.kind === 'index' || unit.kind === 'extract') {
      const meta = await getChunkMeta(job.id, Number(unit.ref));
      if (!meta) return this.failUnit(job, `chunk ${unit.ref} 元数据缺失`);
      const text = await getChunkTextById(meta.id);
      if (text == null) return this.failUnit(job, `chunk ${unit.ref} 内容缺失`);
      return this.submitPrepared(job, await this.buildChunkPrompt(job, unit, meta, text), meta);
    }
    if (unit.kind === 'format') {
      if (unit.ref === 'preflight') {
        return this.submitPrepared(job, buildFormatPlanPrompt(
          unit.marker,
          await this.loadChunkSamples(job.id),
          await this.promptOptions(job),
        ));
      }
      if (!job.formatState) return this.failJob(job, '动态格式规范状态缺失');
      return this.submitPrepared(job, buildFormatPlanPrompt(
        unit.marker,
        await this.loadFormatSamples(job.formatState.inputIds),
        await this.promptOptions(job),
      ));
    }
    if (unit.kind === 'normalize') {
      const state = job.formatState;
      const groupIndex = Number(unit.ref.replace(/^batch-/, ''));
      const group = state?.groups[groupIndex];
      const plan = state?.planResultId ? await getResult(state.planResultId) : undefined;
      if (!state || !group || !plan) return this.failJob(job, '格式统一输入缺失');
      const results = await this.loadResults(state.inputIds.slice(group.start, group.end));
      if (results.length !== group.end - group.start) return this.failJob(job, '格式统一分组输入缺失');
      return this.submitPrepared(job, buildNormalizePrompt(
        unit.marker,
        plan.raw,
        results.map((result) => JSON.stringify(result.parsed)),
        await this.promptOptions(job),
      ));
    }
    const state = job.reduceState;
    const group = state?.groups[state.nextGroup];
    if (!state || !group) return this.failJob(job, '归并状态缺失');
    const results = await this.loadResults(state.inputIds.slice(group.start, group.end));
    if (results.length !== group.end - group.start) return this.failJob(job, '归并输入缺失');
    return this.submitPrepared(job, buildReducePrompt(
      unit.marker,
      results.map((result) => result.raw),
      await this.promptOptions(job),
      state.groups.length === 1,
    ));
  }

  private async handleInspection(job: Job, inspection: ProviderInspection, why: string): Promise<void> {
    if (!job.current) return;
    if (inspection.remoteRef && inspection.remoteRef !== job.current.remoteRef) {
      job = { ...job, current: { ...job.current, remoteRef: inspection.remoteRef } };
      await saveJob(job);
    }
    const current = job.current;
    if (!current) return;
    if (inspection.status === 'complete') {
      if (job.config.deepThinking) {
        const observedAt = current.completionObservedAt;
        if (!observedAt) {
          await saveJob({ ...job, current: { ...current, completionObservedAt: Date.now() } });
          this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + DEEP_THINKING_SETTLE_MS);
          return;
        }
        const remaining = DEEP_THINKING_SETTLE_MS - (Date.now() - observedAt);
        if (remaining > 0) {
          this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + remaining);
          return;
        }
      }
      job = appendJobEvent(job, 'inspection-complete', `${current.kind}/${current.ref} 已检测到完整回复${why ? `（${why}）` : ''}`);
      const collecting = job.status === 'waiting' ? await this.to(job, 'collecting') : job;
      await this.collectCurrent(collecting, inspection.reply);
    } else if (inspection.status === 'retry_current') {
      if (current.rateLimited && (current.retryAfterAt ?? 0) > Date.now()) {
        await saveJob({ ...job, lastError: inspection.detail });
        this.host.scheduleAlarm(RESUME_ALARM(job.id), current.retryAfterAt!);
        return;
      }
      await this.retryUnavailableUnit(job, inspection);
    } else if (inspection.status === 'generating') {
      if (current.completionObservedAt || job.lastError) {
        job = { ...job, lastError: null, current: { ...current, completionObservedAt: undefined } };
        await saveJob(job);
      }
      this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + this.reconcileDelay(job, REGEN_CHECK_MS));
    } else if (inspection.status === 'rate_limited') {
      if (current.rateLimited) {
        this.host.scheduleAlarm(RESUME_ALARM(job.id), current.retryAfterAt ?? Date.now() + RETRY_DELAY_MS);
        return;
      }
      await this.noteRateLimit(job, inspection.detail, inspection.retryAfterMs, inspection.continuationRetryAfterMs);
    } else if (inspection.status === 'unavailable') {
      if (current.rateLimited) {
        // 官方限流期间只做一次自动续写探测。探测失败后不能按 5 秒临时错误间隔
        // 反复点击“继续生成”，否则会把冷却期变成高频操作并触发更严厉风控。
        const retryAt = current.retryAfterAt ?? Date.now() + LEGACY_RATE_LIMIT_GRACE_MS;
        await saveJob({
          ...job,
          current: { ...current, continuationProbeAt: undefined },
          lastError: inspection.detail,
        });
        this.host.scheduleAlarm(RESUME_ALARM(job.id), Math.max(Date.now() + RETRY_DELAY_MS, retryAt));
        return;
      }
      await saveJob({ ...job, lastError: inspection.detail });
      this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + inspection.retryAfterMs);
    } else if (inspection.status === 'missing') {
      if (current.rateLimited && current.manualIntervention) {
        const retryAt = current.retryAfterAt ?? Date.now() + LEGACY_RATE_LIMIT_GRACE_MS;
        await saveJob({ ...job, lastError: inspection.detail });
        this.host.scheduleAlarm(RESUME_ALARM(job.id), Math.max(Date.now() + RETRY_DELAY_MS, retryAt));
        return;
      }
      // 回复节点可能比生成状态晚挂载，不能把一次短暂 missing 当成失败或触发重发。
      if (why === 'manual recovery') {
        return this.failJob(job, `无法对账(${why})，已停止自动重发以避免重复发送: ${inspection.detail}`, true);
      }
      // missing 是 Provider 对账过程中的中间态，不是用户可见错误；否则生成尚未结束时
      // 页面会显示“最近错误”，并掩盖任务仍在正常等待回复的事实。
      await saveJob({ ...job, lastError: null });
      this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + this.reconcileDelay(job, REGEN_CHECK_MS));
    }
  }

  private retryDelay(retryAfterMs?: number): number {
    return Number.isFinite(retryAfterMs) && (retryAfterMs ?? 0) > 0
      ? Math.max(RETRY_DELAY_MS, retryAfterMs!)
      : RETRY_DELAY_MS;
  }

  private reconcileDelay(job: Job, normalDelayMs: number): number {
    return job.config.deepThinking ? Math.max(normalDelayMs, DEEP_THINKING_RECONCILE_MS) : normalDelayMs;
  }

  private async noteRateLimit(job: Job, detail: string, retryAfterMs?: number, _continuationRetryAfterMs?: number, accountKey?: string, accountLabel?: string): Promise<void> {
    const now = Date.now();
    const limitedAccountKey = accountKey ?? job.providerAccountKey;
    if (job.current?.rateLimited && (!limitedAccountKey || job.current.rateLimitAccountKey === limitedAccountKey)) return;
    if (!limitedAccountKey && job.sessionCooldownUntil != null && job.sessionCooldownUntil > now &&
      job.sessionCooldownReason?.startsWith('Provider 官方限流')) return;
    const retryDelay = this.retryDelay(retryAfterMs);
    const previousAt = job.rateLimitEvents?.at(-1)?.occurredAt ?? 0;
    const previousAccountAt = limitedAccountKey
      ? job.rateLimitEvents?.filter((event) => event.accountKey === limitedAccountKey).at(-1)?.occurredAt ?? 0
      : previousAt;
    const history = job.trafficHistory ?? [];
    const accountMatches = (sample: { accountKey?: string }): boolean =>
      !limitedAccountKey || sample.accountKey === limitedAccountKey;
    const submittedSamples = history.filter((sample) => accountMatches(sample) && sample.submittedAt > previousAccountAt && sample.submittedAt <= now);
    const allSubmittedSamples = history.filter((sample) => sample.submittedAt > previousAt && sample.submittedAt <= now);
    const completedSamples = history.filter((sample) => {
      const completedAt = sample.completedAt ?? sample.submittedAt;
      return accountMatches(sample) && completedAt > previousAccountAt && completedAt <= now;
    });
    const allCompletedSamples = history.filter((sample) => {
      const completedAt = sample.completedAt ?? sample.submittedAt;
      return completedAt > previousAt && completedAt <= now;
    });
    const unrecordedCurrent = job.current && job.current.phase !== 'prepared' &&
      !history.some((sample) => sample.marker === job.current?.marker) ? job.current : undefined;
    const countedCurrent = unrecordedCurrent && accountMatches({ accountKey: unrecordedCurrent.submissionAccountKey ?? job.providerAccountKey })
      ? [unrecordedCurrent] : [];
    const intervalInputChars = submittedSamples.reduce((total, sample) => total + Math.max(0, sample.inputChars), 0)
      + countedCurrent.reduce((total, unit) => total + Math.max(0, unit.inputChars ?? 0), 0);
    const intervalOutputChars = completedSamples.reduce((total, sample) => total + Math.max(0, sample.outputChars ?? 0), 0);
    const totalIntervalInputChars = allSubmittedSamples.reduce((total, sample) => total + Math.max(0, sample.inputChars), 0)
      + Math.max(0, unrecordedCurrent?.inputChars ?? 0);
    const totalIntervalOutputChars = allCompletedSamples.reduce((total, sample) => total + Math.max(0, sample.outputChars ?? 0), 0);
    const previous = job.rateLimitEvents?.at(-1);
    const cumulativeInputChars = (previous?.cumulativeInputChars ?? previous?.inputChars ?? 0) + totalIntervalInputChars;
    const cumulativeOutputChars = (previous?.cumulativeOutputChars ?? previous?.outputChars ?? 0) + totalIntervalOutputChars;
    const event: RateLimitEvent = {
      accountKey: limitedAccountKey,
      occurredAt: now,
      sentCount: job.stats.sent,
      providerSessionCount: Array.isArray(job.providerSessionRefs) ? job.providerSessionRefs.length : 0,
      // inputChars/outputChars 保留为兼容字段，语义等同本次事件之间的新增量。
      inputChars: intervalInputChars,
      outputChars: intervalOutputChars,
      intervalInputChars,
      intervalOutputChars,
      cumulativeInputChars,
      cumulativeOutputChars,
      retryAfterMs: retryDelay,
      detail,
    };
    const rateLimitEvents = [...(job.rateLimitEvents ?? []), event].slice(-RATE_LIMIT_EVENT_HISTORY_LIMIT);
    const retryAfterAt = now + retryDelay;
    const providerRateLimits = [...(job.providerRateLimits ?? [])];
    if (limitedAccountKey) {
      const existing = providerRateLimits.find((entry) => entry.providerId === job.providerId &&
        entry.accountKey === limitedAccountKey && entry.limitedUntil > now);
      if (existing && existing.kind !== 'proactive' && !job.current?.rateLimited) return;
      const withoutCurrent = providerRateLimits.filter((entry) =>
        !(entry.providerId === job.providerId && entry.accountKey === limitedAccountKey),
      );
      withoutCurrent.push({
        providerId: job.providerId,
        accountKey: limitedAccountKey,
        accountLabel: accountLabel ?? job.providerAccountLabel,
        kind: 'official',
        limitedUntil: retryAfterAt,
        occurredAt: now,
        reason: detail,
      });
      providerRateLimits.splice(0, providerRateLimits.length, ...withoutCurrent);
    }
    job = appendJobEvent({
      ...job,
      current: job.current ? {
        ...job.current,
        rateLimited: true,
        rateLimitAccountKey: limitedAccountKey,
        retryAfterAt,
        continuationProbeAt: undefined,
      } : null,
      // 兼容旧版工作台和恢复逻辑保留摘要字段；实际是否阻塞由 providerRateLimits + accountKey 决定。
      sessionCooldownUntil: retryAfterAt,
      sessionCooldownStartedAt: now,
      sessionCooldownReason: `Provider 官方限流，${Math.ceil(retryDelay / 60_000)} 分钟后重试`,
      sessionCooldownAccountKey: limitedAccountKey,
      providerRateLimits,
      rateLimitEvents,
      lastError: detail,
      stats: { ...job.stats, rateLimitHits: job.stats.rateLimitHits + 1 },
    }, 'rate-limit', detail);
    this.host.log('Provider 官方限流', {
      jobId: job.shortId,
      at: new Date(now).toISOString(),
      sentCount: event.sentCount,
      providerSessionCount: event.providerSessionCount,
      intervalInputChars: event.intervalInputChars,
      intervalOutputChars: event.intervalOutputChars,
      cumulativeInputChars: event.cumulativeInputChars,
      cumulativeOutputChars: event.cumulativeOutputChars,
      accountKey: event.accountKey,
      retryAfterMs: event.retryAfterMs,
    });
    await saveJob(job);
    if (job.status !== 'waiting' && job.status !== 'paused') job = await this.to(job, 'waiting');
    this.host.clearAlarm(TIMEOUT_ALARM(job.id));
    this.host.scheduleAlarm(RESUME_ALARM(job.id), retryAfterAt);
  }

  /** Provider 已确认原远端会话被删除或不可恢复；递增 attempt 后在新会话重发。 */
  private async retryUnavailableUnit(job: Job, preparation: Extract<ProviderInspection, { status: 'retry_current' }>): Promise<void> {
    if (!job.current) return;
    if (preparation.strategy === 'split_input' && await this.splitCurrentForContextLimit(job, preparation.detail)) return;
    const recovered: Job = {
      ...job,
      current: {
        ...job.current,
        phase: 'prepared',
        remoteRef: null,
        rateLimited: undefined,
        retryAfterAt: undefined,
      },
      lastError: preparation.detail,
    };
    await saveJob(recovered);
    await this.resend(recovered, preparation.detail);
  }

  /** 上下文超限时分割原文或当前归并组，再由后续阶段继续合并结果。 */
  private async splitCurrentForContextLimit(job: Job, detail: string): Promise<boolean> {
    const unit = job.current;
    if (!unit) return false;
    if (unit.kind === 'index' || unit.kind === 'extract') {
      const meta = await getChunkMeta(job.id, Number(unit.ref));
      const text = meta ? await getChunkTextById(meta.id) : undefined;
      if (!meta || text == null || text.length < 2_000) return false;
      // 每次严格缩小输入，保留所有字符；优先在中间附近的行边界分割。
      let middle = Math.ceil(text.length / 2);
      const newline = text.lastIndexOf('\n', middle);
      if (newline >= middle * 0.75) middle = newline + 1;
      // 不拆开 UTF-16 代理对。
      if (/[\uD800-\uDBFF]/.test(text[middle - 1]!)) middle++;
      const parts = [text.slice(0, middle), text.slice(middle)];
      if (!(await splitChunkForContextLimit(job.id, unit.marker, parts, detail))) return true;
      return this.pump(job.id).then(() => true);
    }
    const state = unit.kind === 'normalize' ? job.formatState : unit.kind === 'reduce' ? job.reduceState : null;
    if (state && state.groups.length > 0) {
      const groupIndex = state.nextGroup;
      const group = state.groups[groupIndex];
      if (group && group.end - group.start >= 2) {
        const middle = group.start + Math.ceil((group.end - group.start) / 2);
        const groups = [...state.groups.slice(0, groupIndex),
          { start: group.start, end: middle }, { start: middle, end: group.end },
          ...state.groups.slice(groupIndex + 1)];
        const inputs = await this.loadResults(state.inputIds.slice(group.start, group.end));
        const inputChars = inputs.reduce((sum, result) => sum + Math.max(result.raw.length, JSON.stringify(result.parsed).length), 0);
        const budget = Math.max(1, Math.floor(inputChars / 2));
        const reusedOutputIds: Record<number, string> = {};
        for (const [key, value] of Object.entries(state.reusedOutputIds ?? {})) {
          const index = Number(key);
          if (index !== groupIndex) reusedOutputIds[index > groupIndex ? index + 1 : index] = value;
        }
        const reprocessAttemptBases = { ...job.reprocessAttemptBases };
        reprocessAttemptBases[`${unit.kind}:${unit.ref}`] = unit.attempt;
        // 插入后组编号移动，所有尚未处理的编号都必须避开历史请求标识。
        for (let i = groupIndex + 1; i < groups.length; i++) {
          const ref = unit.kind === 'normalize' ? `batch-${i}` : `${job.reduceState!.level}-${i}`;
          reprocessAttemptBases[`${unit.kind}:${ref}`] = Math.max(unit.attempt,
            job.reprocessAttemptBases?.[`${unit.kind}:${ref}`] ?? 0,
            job.reprocessAttemptBases?.[`${unit.kind}:${unit.kind === 'normalize' ? `batch-${i - 1}` : `${job.reduceState!.level}-${i - 1}`}`] ?? 0);
        }
        const nextJob: Job = unit.kind === 'normalize'
          ? { ...job, formatState: { ...job.formatState!, groups, reusedOutputIds }, current: null, lastError: detail }
          : { ...job, reduceState: { ...job.reduceState!, groups, reusedOutputIds }, current: null, lastError: detail };
        await saveJob(appendJobEvent({ ...nextJob, reprocessAttemptBases,
          contextInputBudget: Math.min(job.contextInputBudget ?? Infinity, budget),
        }, 'context-split',
          `${unit.kind}/${unit.ref} 达到对话长度上限，已拆分当前归并组后继续`));
        await this.pump(job.id);
        return true;
      }
    }
    return false;
  }

  private async resend(job: Job, reason: string, force = false): Promise<void> {
    const unit = job.current;
    if (!unit) return this.pump(job.id);
    const attemptBase = job.reprocessAttemptBases?.[`${unit.kind}:${unit.ref}`] ?? 0;
    if (!force && unit.attempt - attemptBase >= job.config.maxAttempts && !unit.rateLimited) return this.failUnit(job, reason);
    const prevAttempt = Math.max(0, unit.attempt - (unit.rateLimited ? 1 : 0));
    if (unit.kind === 'index' || unit.kind === 'extract') {
      const meta = await getChunkMeta(job.id, Number(unit.ref));
      if (!meta) return this.failUnit(job, `chunk ${unit.ref} 元数据缺失`);
      const text = await getChunkTextById(meta.id);
      if (text == null) return this.failUnit(job, `chunk ${unit.ref} 内容缺失`);
      return this.dispatchUnit(job, { kind: unit.kind, ref: unit.ref, prevAttempt },
        (marker) => this.buildChunkPrompt(job, { ...unit, marker }, meta, text), meta);
    }
    if (unit.kind === 'format') {
      if (unit.ref === 'preflight') {
        const samples = await this.loadChunkSamples(job.id);
        return this.dispatchUnit(job, { kind: 'format', ref: 'preflight', prevAttempt },
          async (marker) => buildFormatPlanPrompt(marker, samples, await this.promptOptions(job)));
      }
      if (!job.formatState) return this.failJob(job, '动态格式规范状态缺失');
      const samples = await this.loadFormatSamples(job.formatState.inputIds);
      return this.dispatchUnit(job, { kind: 'format', ref: 'plan', prevAttempt },
        async (marker) => buildFormatPlanPrompt(marker, samples, await this.promptOptions(job)));
    }
    if (unit.kind === 'normalize') {
      const state = job.formatState;
      if (!state?.planResultId) return this.failJob(job, '格式统一状态缺失');
      const groupIndex = Number(unit.ref.replace(/^batch-/, ''));
      const group = state.groups[groupIndex];
      const plan = await getResult(state.planResultId);
      if (!group || !plan) return this.failJob(job, '格式统一输入缺失');
      const results = await this.loadResults(state.inputIds.slice(group.start, group.end));
      if (results.length !== group.end - group.start) return this.failJob(job, '格式统一分组输入缺失');
      return this.dispatchUnit(job, { kind: 'normalize', ref: unit.ref, prevAttempt },
        async (marker) => buildNormalizePrompt(marker, plan.raw, results.map((r) => JSON.stringify(r.parsed)), await this.promptOptions(job)));
    }
    const state = job.reduceState;
    const group = state?.groups[state.nextGroup];
    if (!state || !group) return this.failJob(job, '归并状态缺失');
    const results = await this.loadResults(state.inputIds.slice(group.start, group.end));
    return this.dispatchUnit(job, { kind: 'reduce', ref: unit.ref, prevAttempt },
      async (marker) => buildReducePrompt(marker, results.map((r) => r.raw), await this.promptOptions(job), state.groups.length === 1));
  }

  private async buildChunkPrompt(job: Job, unit: CurrentUnit, meta: ChunkMeta, text: string): Promise<string> {
    const options = await this.promptOptions(job);
    if (unit.kind === 'index') return buildIndexPrompt(unit.marker, `chunk-${meta.index}`, text, options);
    if (job.config.pipelineMode !== 'staged') return buildExtractionPrompt(unit.marker, text, options);
    if (!meta.indexResultId) throw new Error(`chunk ${meta.index} 索引结果缺失`);
    const indexResult = await getResult(meta.indexResultId);
    if (!indexResult) throw new Error(`chunk ${meta.index} 索引结果记录缺失`);
    return buildDistillationPrompt(unit.marker, text, indexResult.raw, options);
  }

  private async collectCurrent(job: Job, raw: string): Promise<void> {
    const unit = job.current;
    if (!unit) return;
    const parsed: ResultPayload | null = unit.kind === 'index'
      ? parseIndexResult(raw)
      : unit.kind === 'format'
        ? parseFormatPlan(raw)
        : await this.parseTaskResult(job, raw);
    if (!parsed || (
      unit.kind !== 'index'
      && unit.kind !== 'format'
      && !hasMeaningfulPayload(parsed)
    )) {
      const reason = parsed ? '回复为空或没有实际内容，自动重新生成' : '回复结构异常，自动重新生成';
      return this.resend(appendJobEvent(job, 'provider-error', `${unit.kind}/${unit.ref} ${reason}（回复 ${raw.trim().length} 字符）`), reason);
    }
    if (unit.kind === 'index') {
      const index = Number(unit.ref);
      const id = `${job.id}:i${index}:a${unit.attempt}`;
      const result: ResultRecord = { id, jobId: job.id, kind: 'index', level: 0, ref: unit.ref,
        sourceIds: [`${job.id}:${index}`], raw, parsed, createdAt: Date.now() };
      const next = await commitIndexed(job.id, unit.marker, result, index);
      if (next?.status !== 'paused') await this.pump(job.id);
      return;
    }
    if (unit.kind === 'extract') {
      const index = Number(unit.ref);
      const id = `${job.id}:c${index}:a${unit.attempt}`;
      const result: ResultRecord = { id, jobId: job.id, kind: 'extract', level: 0, ref: unit.ref,
        sourceIds: [`${job.id}:${index}`], raw, parsed, createdAt: Date.now() };
      const next = await commitCollected(job.id, unit.marker, result, 'processing', index);
      if (next?.status !== 'paused') await this.pump(job.id);
      return;
    }
    if (unit.kind === 'format') {
      if (unit.ref === 'preflight') {
        const id = `${job.id}:fpreflight:a${unit.attempt}`;
        const result: ResultRecord = {
          id,
          jobId: job.id,
          kind: 'format',
          level: 0,
          ref: unit.ref,
          sourceIds: [],
          raw,
          parsed,
          createdAt: Date.now(),
        };
        const next = await commitCollected(job.id, unit.marker, result, 'processing', undefined, undefined, undefined, id);
        if (next) {
          await this.pump(job.id);
        }
        return;
      }
      const id = `${job.id}:fplan:a${unit.attempt}`;
      const result: ResultRecord = { id, jobId: job.id, kind: 'format', level: 0, ref: unit.ref,
        sourceIds: job.formatState?.inputIds ?? [], raw, parsed, createdAt: Date.now() };
      const formatState = job.formatState
        ? { ...job.formatState, phase: 'normalizing' as const, planResultId: id, nextGroup: 0, outputIds: [] }
        : null;
      const next = await commitCollected(job.id, unit.marker, result, 'reducing', undefined, undefined, formatState, id);
      if (next?.status !== 'paused') await this.pump(job.id);
      return;
    }
    if (unit.kind === 'normalize') {
      const state = job.formatState;
      if (!state) return this.failJob(job, '格式统一状态缺失');
      const groupIndex = Number(unit.ref.replace(/^batch-/, ''));
      if (!Number.isInteger(groupIndex) || groupIndex < 0 || !state.groups[groupIndex]) {
        return this.failJob(job, `非法格式统一引用: ${unit.ref}`);
      }
      const id = `${job.id}:n${groupIndex}:a${unit.attempt}`;
      const nextFormatState: FormatState = {
        ...state,
        nextGroup: state.nextGroup + 1,
        outputIds: [...state.outputIds, id],
      };
      const result: ResultRecord = { id, jobId: job.id, kind: 'normalize', level: 0, ref: unit.ref,
        sourceIds: state.inputIds.slice(state.groups[groupIndex].start, state.groups[groupIndex].end), raw, parsed, createdAt: Date.now() };
      const next = await commitCollected(job.id, unit.marker, result, 'reducing', undefined, undefined, nextFormatState);
      if (next?.status !== 'paused') await this.pump(job.id);
      return;
    }
    const state = job.reduceState;
    if (!state) return this.failJob(job, '归并状态缺失');
    const groupIndex = Number(unit.ref.split('-')[1]);
    const group = state.groups[groupIndex];
    if (!Number.isInteger(groupIndex) || !group) return this.failJob(job, `非法归并引用: ${unit.ref}`);
    const id = `${job.id}:r${state.level}g${groupIndex}:a${unit.attempt}`;
    const result: ResultRecord = { id, jobId: job.id, kind: 'reduce', level: state.level, ref: unit.ref,
      sourceIds: state.inputIds.slice(group.start, group.end), raw, parsed, createdAt: Date.now() };
    const reduceState = { ...state, nextGroup: state.nextGroup + 1, outputIds: [...state.outputIds, id] };
    const next = await commitCollected(job.id, unit.marker, result, 'reducing', undefined, reduceState);
    if (next?.status !== 'paused') await this.pump(job.id);
  }

  private async beginReduce(job: Job): Promise<void> {
    const metas = (await chunkMetasByJob(job.id)).sort(compareChunkOrder);
    const ids = metas.filter((meta) => meta.status === 'done' && meta.resultId).map((meta) => meta.resultId!);
    if (ids.length === 0) return this.failJob(job, '没有任何提炼结果，无法归并');
    if (ids.length === 1) return this.finalize(job, ids[0]!);
    const results = await this.loadResults(ids);
    if (results.length !== ids.length) return this.failJob(job, '提炼结果记录缺失');
    const hasStructuredResults = results.some((result) => isExtractionResult(result.parsed)
      ? result.parsed.knowledge.length > 0
      : isJsonResult(result.parsed));
    if (job.config.taskKind === 'knowledge' && hasStructuredResults) {
      const groups = planGroups(results.map((result) => JSON.stringify(result.parsed).length), {
        fanIn: job.config.fanIn,
        maxChars: Math.min(job.config.maxChunkChars, job.contextInputBudget ?? Infinity),
      });
      job = {
        ...job,
        formatState: {
          phase: 'planning',
          inputIds: ids,
          planResultId: null,
          groups,
          nextGroup: 0,
          outputIds: [],
        },
        reduceState: null,
      };
      await saveJob(job);
      job = await this.to(job, 'reducing');
      return this.dispatchNextReduce(job);
    }
    const groups = planGroups(results.map((result) => result.raw.length),
      { fanIn: job.config.fanIn, maxChars: Math.min(job.config.maxChunkChars, job.contextInputBudget ?? Infinity) });
    if (groups.length >= ids.length) return this.failJob(job, '提炼结果超过归并预算且无法收敛；请提高归并预算或缩小分块');
    job = { ...job, reduceState: { level: 1, inputIds: ids, groups, nextGroup: 0, outputIds: [] } };
    await saveJob(job);
    job = await this.to(job, 'reducing');
    await this.dispatchNextReduce(job);
  }

  private async finalize(job: Job, resultId: string): Promise<void> {
    job = { ...job, finalResultId: resultId, current: null, lastError: null };
    await saveJob(job);
    if (job.status !== 'completed') job = await this.to(job, 'completed');
    this.host.clearAlarm(TIMEOUT_ALARM(job.id));
    this.host.clearAlarm(RESUME_ALARM(job.id));
    if ((await getActiveJobId()) === job.id) await setActiveJobId(null);
    if (job.config.deleteProviderSessionsOnComplete) {
      try {
        await this.cleanupSessions(job.id);
      } catch (error) {
        await saveJob({ ...job, lastError: `网页会话清理失败：${errMsg(error)}` });
      }
    }
  }

  private async failUnit(job: Job, reason: string): Promise<void> {
    const unit = job.current;
    if (unit?.kind === 'index' || unit?.kind === 'extract') {
      const next = await commitUnitFailure(job.id, unit.marker, reason, Number(unit.ref));
      if (!next || next.status === 'paused') return;
      const processing = next.status === 'processing' ? next : await this.to(next, 'processing');
      await this.pump(processing.id);
      return;
    }
    await this.failJob(job, reason);
  }

  private async failJob(job: Job, reason: string, preserveCurrent = false): Promise<void> {
    job = { ...job, lastError: reason, current: preserveCurrent ? job.current : null };
    await saveJob(job);
    if (job.status !== 'failed') await this.to(job, 'failed');
    this.host.clearAlarm(TIMEOUT_ALARM(job.id));
    this.host.clearAlarm(RESUME_ALARM(job.id));
  }

  private async loadResults(ids: string[]): Promise<ResultRecord[]> {
    const values = await Promise.all(ids.map((id) => getResult(id)));
    return values.filter((value): value is ResultRecord => value != null);
  }
}

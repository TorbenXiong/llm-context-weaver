/** Provider 无关的持久化编排引擎。 */
import {
  buildDistillationPrompt,
  buildExtractionPrompt,
  buildIndexPrompt,
  buildReducePrompt,
  formatMarker,
} from '../protocol/prompts';
import { parseIndexResult, parseJsonResult, sanitizeExtraction } from '../protocol/schema';
import type { ProviderHost, ProviderInspection } from '../provider';
import { planGroups } from '../reduce/reducePlanner';
import {
  chunkMetasByJob,
  commitCollected,
  commitIndexed,
  commitUnitFailure,
  getActiveJobId,
  getChunkMeta,
  getChunkTextById,
  getJob,
  getResult,
  jobProgress,
  listJobs,
  markUnitSubmitted,
  nextPendingChunk,
  saveChunkMeta,
  saveJob,
  setActiveJobId,
} from '../storage/jobStore';
import type { ChunkMeta, CurrentUnit, Job, JobStatus, ResultPayload, ResultRecord, UnitKind } from '../types';
import { sleep } from '../util/sleep';
import { isActive, isTerminal, transitionJob } from './stateMachine';

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
const LEGACY_RATE_LIMIT_GRACE_MS = 30 * 60_000;
const SESSION_COOLDOWN_BATCH_SIZE = 100;
const SESSION_COOLDOWN_MS = 10 * 60_000;
const errMsg = (error: unknown): string => error instanceof Error ? error.message : String(error);

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
      job = await this.to(job, job.current ? 'waiting' : job.reduceState ? 'reducing' : 'processing');
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
    if (job.status === 'waiting') job = await this.to(job, job.reduceState ? 'reducing' : 'processing');
    if (await this.deferForSessionCooldown(job)) return;
    if (job.status === 'processing') return this.dispatchNextChunkStage(job);
    if (job.status === 'reducing') return this.dispatchNextReduce(job);
  }

  /** 每 100 个 Provider 网页会话主动冷却 10 分钟，降低触发风控的概率。 */
  private async deferForSessionCooldown(job: Job): Promise<boolean> {
    const now = Date.now();
    const existing = job.sessionCooldownUntil;
    if (existing != null) {
      if (existing > now) {
        this.host.scheduleAlarm(RESUME_ALARM(job.id), existing);
        return true;
      }
      job = { ...job, sessionCooldownUntil: undefined };
      await saveJob(job);
      return false;
    }
    const sessionCount = Array.isArray(job.providerSessionRefs) ? job.providerSessionRefs.length : 0;
    if (sessionCount === 0 || sessionCount % SESSION_COOLDOWN_BATCH_SIZE !== 0) return false;
    const cooldownUntil = now + SESSION_COOLDOWN_MS;
    await saveJob({ ...job, sessionCooldownUntil: cooldownUntil });
    this.host.scheduleAlarm(RESUME_ALARM(job.id), cooldownUntil);
    return true;
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
    job = await this.to(job, job.prevStatus ?? (job.reduceState ? 'reducing' : 'processing'));
    if (job.current) await this.reconcile(job, 'resume');
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
    await saveChunkMeta({ ...meta, status: 'pending', attempts: 0, resultId: null, error: null });
    job = { ...job, failedChunks: job.failedChunks.filter((value) => value !== index), reduceState: null,
      finalResultId: null, lastError: null };
    await saveJob(job);
    if (job.status === 'failed' || job.status === 'completed') job = await this.to(job, 'processing');
    if (isActive(job.status)) await this.pump(job.id);
  }

  async retryFailed(jobId: string): Promise<void> {
    let job = await getJob(jobId);
    if (!job) return;
    if (job.status === 'paused' && job.failedChunks.length > 0) {
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
        finalResultId: null,
        lastError: null,
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
    job = { ...job, failedChunks: [], reduceState: null, finalResultId: null, lastError: null };
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
    const job = await getJob(match[2]);
    if (!job || !isActive(job.status)) return;
    if (job.current?.rateLimited) {
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

  async onAdapterReady(connectionId: string): Promise<void> {
    const job = await this.activeJob();
    if (!job || (job.providerConnectionId && job.providerConnectionId !== connectionId)) return;
    if (job.current) this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + 1_500);
  }

  async onGenerationStart(_connectionId: string): Promise<void> {}

  async onGenerationEnd(connectionId: string): Promise<void> {
    const job = await this.activeJob();
    if (!job || !job.current || job.providerConnectionId !== connectionId) return;
    if (job.status !== 'waiting' && job.status !== 'paused') return;
    if (job.config.deepThinking) {
      this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + DEEP_THINKING_SETTLE_MS);
    } else {
      await this.reconcile(job, 'generation end');
    }
  }

  async onRateLimited(connectionId: string, detail: string, retryAfterMs?: number): Promise<void> {
    let job = await this.activeJob();
    if (!job || !job.current || job.providerConnectionId !== connectionId) return;
    if (job.current.rateLimited) return;
    const retryDelay = this.retryDelay(retryAfterMs);
    job = { ...job, current: { ...job.current, rateLimited: true, retryAfterAt: Date.now() + retryDelay },
      stats: { ...job.stats, rateLimitHits: job.stats.rateLimitHits + 1 }, lastError: detail };
    await saveJob(job);
    this.host.clearAlarm(TIMEOUT_ALARM(job.id));
    this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + retryDelay);
  }

  async onAdapterError(connectionId: string, detail: string): Promise<void> {
    const job = await this.activeJob();
    if (!job || job.providerConnectionId !== connectionId) return;
    await saveJob({ ...job, lastError: detail });
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
    const metas = (await chunkMetasByJob(job.id)).sort((a, b) => a.index - b.index);
    // 多阶段流程有全局屏障：必须先为所有分块建立索引，才允许进入目标处理阶段。
    // 否则模型会在索引尚未完整时开始深炼，导致跨块事件无法对齐。
    const meta = job.config.pipelineMode === 'staged'
      ? (metas.find((candidate) => candidate.status === 'pending' && !candidate.indexResultId)
        ?? metas.find((candidate) => candidate.status === 'pending' && candidate.indexResultId))
      : await nextPendingChunk(job.id);
    if (!meta) {
      const progress = await jobProgress(job.id);
      if (progress.sent > 0) return;
      if (progress.failed > 0) return this.failJob(job, `有 ${progress.failed} 个分块失败，请重试后再归并`);
      return this.beginReduce(job);
    }
    const text = await getChunkTextById(meta.id);
    if (text == null) return this.failUnit(job, `chunk ${meta.index} 内容缺失`);
    const shouldIndex = job.config.pipelineMode === 'staged' && !meta.indexResultId && meta.stage !== 'process';
    if (shouldIndex) {
      return this.dispatchUnit(job, { kind: 'index', ref: String(meta.index), prevAttempt: meta.attempts },
        (marker) => buildIndexPrompt(marker, `chunk-${meta.index}`, text, job.config), meta);
    }
    const indexResult = meta.indexResultId ? await getResult(meta.indexResultId) : undefined;
    if (job.config.pipelineMode === 'staged' && !indexResult) {
      return this.failUnit(job, `chunk ${meta.index} 索引结果缺失`);
    }
    return this.dispatchUnit(job, { kind: 'extract', ref: String(meta.index), prevAttempt: meta.attempts },
      (marker) => indexResult
        ? buildDistillationPrompt(marker, text, indexResult.raw, job.config)
        : buildExtractionPrompt(marker, text, job.config), meta);
  }

  private async dispatchNextReduce(job: Job): Promise<void> {
    let state = job.reduceState;
    if (!state) return this.beginReduce(job);
    if (state.nextGroup >= state.groups.length) {
      if (state.outputIds.length === 0) return this.failJob(job, '归并未产出任何结果');
      if (state.outputIds.length === 1) return this.finalize(job, state.outputIds[0]!);
      const results = await this.loadResults(state.outputIds);
      if (results.length !== state.outputIds.length) return this.failJob(job, '归并结果记录缺失');
      const groups = planGroups(results.map((r) => r.raw.length),
        { fanIn: job.config.fanIn, maxChars: job.config.maxChunkChars });
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
    const ids = state.inputIds.slice(group.start, group.end);
    const results = await this.loadResults(ids);
    if (results.length !== ids.length) return this.failJob(job, `归并输入缺失: level ${state.level} group ${groupIndex}`);
    const ref = `${state.level}-${groupIndex}`;
    const matched = job.current?.kind === 'reduce' && job.current.ref === ref ? job.current : null;
    const prevAttempt = Math.max(0, (matched?.attempt ?? 0) - (matched?.rateLimited ? 1 : 0));
    return this.dispatchUnit(job, { kind: 'reduce', ref, prevAttempt },
      (marker) => buildReducePrompt(marker, results.map((r) => r.raw), job.config, state.groups.length === 1));
  }

  private async dispatchUnit(
    job: Job,
    unit: UnitRef,
    makePrompt: (marker: string) => string | Promise<string>,
    meta?: ChunkMeta,
  ): Promise<void> {
    const attempt = unit.prevAttempt + 1;
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
    await this.submitPrepared(fresh, await makePrompt(marker), meta);
  }

  private async submitPrepared(job: Job, prompt: string, meta?: ChunkMeta): Promise<void> {
    const current = job.current;
    if (!current || current.phase !== 'prepared') return;
    const marker = current.marker;
    try {
      const connectionId = await this.ensureConnection(job);
      await this.host.prepare(connectionId, current);
      const fresh = await getJob(job.id);
      if (!fresh || fresh.status === 'paused' || fresh.status === 'canceled' || fresh.current?.marker !== marker) return;
      job = { ...fresh, current: { ...current, phase: 'submitting' }, providerConnectionId: connectionId };
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
        await this.noteRateLimit(job, outcome.detail, outcome.retryAfterMs);
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

  private async ensureConnection(job: Job): Promise<string> {
    if (job.providerConnectionId) return job.providerConnectionId;
    const id = await this.host.connect(job);
    await saveJob({ ...job, providerConnectionId: id });
    return id;
  }

  private async reconcile(job: Job, why: string): Promise<void> {
    if (job.status === 'paused' || !job.current) return;
    if (job.current.phase === 'prepared') return this.resumePrepared(job);
    const unit = job.current;
    try {
      const connectionId = await this.ensureConnection(job);
      if (connectionId !== job.providerConnectionId) {
        job = { ...job, providerConnectionId: connectionId };
        await saveJob(job);
      }
      await this.host.prepare(connectionId, unit);
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
    const state = job.reduceState;
    const group = state?.groups[state.nextGroup];
    if (!state || !group) return this.failJob(job, '归并状态缺失');
    const results = await this.loadResults(state.inputIds.slice(group.start, group.end));
    if (results.length !== group.end - group.start) return this.failJob(job, '归并输入缺失');
    return this.submitPrepared(job, buildReducePrompt(
      unit.marker,
      results.map((result) => result.raw),
      job.config,
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
      const collecting = job.status === 'waiting' ? await this.to(job, 'collecting') : job;
      await this.collectCurrent(collecting, inspection.reply);
    } else if (inspection.status === 'generating') {
      if (current.completionObservedAt || job.lastError) {
        job = { ...job, lastError: null, current: { ...current, completionObservedAt: undefined } };
        await saveJob(job);
      }
      this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + this.reconcileDelay(job, REGEN_CHECK_MS));
    } else if (inspection.status === 'rate_limited') {
      await this.noteRateLimit(job, inspection.detail, inspection.retryAfterMs);
    } else if (inspection.status === 'unavailable') {
      await saveJob({ ...job, lastError: inspection.detail });
      this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + inspection.retryAfterMs);
    } else if (inspection.status === 'missing') {
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

  private async noteRateLimit(job: Job, detail: string, retryAfterMs?: number): Promise<void> {
    if (job.current?.rateLimited) return;
    const retryDelay = this.retryDelay(retryAfterMs);
    job = { ...job, current: job.current ? { ...job.current, rateLimited: true, retryAfterAt: Date.now() + retryDelay } : null, lastError: detail,
      stats: { ...job.stats, rateLimitHits: job.stats.rateLimitHits + 1 } };
    await saveJob(job);
    if (job.status !== 'waiting' && job.status !== 'paused') job = await this.to(job, 'waiting');
    this.host.clearAlarm(TIMEOUT_ALARM(job.id));
    this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + retryDelay);
  }

  private async resend(job: Job, reason: string, force = false): Promise<void> {
    const unit = job.current;
    if (!unit) return this.pump(job.id);
    if (!force && unit.attempt >= job.config.maxAttempts && !unit.rateLimited) return this.failUnit(job, reason);
    const prevAttempt = Math.max(0, unit.attempt - (unit.rateLimited ? 1 : 0));
    if (unit.kind === 'index' || unit.kind === 'extract') {
      const meta = await getChunkMeta(job.id, Number(unit.ref));
      if (!meta) return this.failUnit(job, `chunk ${unit.ref} 元数据缺失`);
      const text = await getChunkTextById(meta.id);
      if (text == null) return this.failUnit(job, `chunk ${unit.ref} 内容缺失`);
      return this.dispatchUnit(job, { kind: unit.kind, ref: unit.ref, prevAttempt },
        (marker) => this.buildChunkPrompt(job, { ...unit, marker }, meta, text), meta);
    }
    const state = job.reduceState;
    const group = state?.groups[state.nextGroup];
    if (!state || !group) return this.failJob(job, '归并状态缺失');
    const results = await this.loadResults(state.inputIds.slice(group.start, group.end));
    return this.dispatchUnit(job, { kind: 'reduce', ref: unit.ref, prevAttempt },
      (marker) => buildReducePrompt(marker, results.map((r) => r.raw), job.config, state.groups.length === 1));
  }

  private async buildChunkPrompt(job: Job, unit: CurrentUnit, meta: ChunkMeta, text: string): Promise<string> {
    if (unit.kind === 'index') return buildIndexPrompt(unit.marker, `chunk-${meta.index}`, text, job.config);
    if (job.config.pipelineMode !== 'staged') return buildExtractionPrompt(unit.marker, text, job.config);
    if (!meta.indexResultId) throw new Error(`chunk ${meta.index} 索引结果缺失`);
    const indexResult = await getResult(meta.indexResultId);
    if (!indexResult) throw new Error(`chunk ${meta.index} 索引结果记录缺失`);
    return buildDistillationPrompt(unit.marker, text, indexResult.raw, job.config);
  }

  private async collectCurrent(job: Job, raw: string): Promise<void> {
    const unit = job.current;
    if (!unit) return;
    const parsed: ResultPayload | null = unit.kind === 'index'
      ? parseIndexResult(raw)
      : job.config.taskKind === 'custom' ? (raw.trim() || null) : sanitizeExtraction(raw);
    if (!parsed) return this.resend(job, '回复结构异常，自动重新生成');
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
    const metas = (await chunkMetasByJob(job.id)).sort((a, b) => a.index - b.index);
    const ids = metas.filter((meta) => meta.status === 'done' && meta.resultId).map((meta) => meta.resultId!);
    if (ids.length === 0) return this.failJob(job, '没有任何提炼结果，无法归并');
    if (ids.length === 1) return this.finalize(job, ids[0]!);
    const results = await this.loadResults(ids);
    if (results.length !== ids.length) return this.failJob(job, '提炼结果记录缺失');
    const groups = planGroups(results.map((result) => result.raw.length),
      { fanIn: job.config.fanIn, maxChars: job.config.maxChunkChars });
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

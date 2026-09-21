import type { Job, JobStatus } from '../types';

/** 静态迁移表；paused 的恢复目标是动态的（prevStatus），在 transitionJob 中单独处理 */
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  split: ['processing', 'canceled', 'failed'],
  processing: ['waiting', 'collecting', 'reducing', 'paused', 'completed', 'canceled', 'failed'],
  waiting: ['processing', 'collecting', 'reducing', 'paused', 'canceled', 'failed'],
  collecting: ['waiting', 'processing', 'reducing', 'paused', 'completed', 'canceled', 'failed'],
  reducing: ['waiting', 'collecting', 'paused', 'completed', 'canceled', 'failed'],
  paused: ['canceled'],
  completed: ['processing'], // 完成后补跑失败分块，重新归并覆盖最终结果
  canceled: [],
  // 失败任务可能已持久化到归并/格式归档阶段，恢复时需要继续从 reducing 调度。
  failed: ['processing', 'waiting', 'reducing', 'canceled'],
};

export const ACTIVE_STATUSES: readonly JobStatus[] = ['split', 'processing', 'waiting', 'collecting', 'reducing'];
export const TERMINAL_STATUSES: readonly JobStatus[] = ['completed', 'canceled', 'failed'];

export const isActive = (s: JobStatus): boolean => ACTIVE_STATUSES.includes(s);
export const isTerminal = (s: JobStatus): boolean => TERMINAL_STATUSES.includes(s);

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  if (from === to) return true;
  if (from === 'paused') return to === 'canceled';
  return TRANSITIONS[from].includes(to);
}

/**
 * 唯一允许的状态迁移入口（纯函数，返回新对象）。
 * 暂停时记录 prevStatus，恢复时只能回到 prevStatus，杜绝绕过状态机的隐式跳转。
 */
export function transitionJob(job: Job, to: JobStatus, now: number): Job {
  if (to === job.status) return { ...job, updatedAt: now };
  if (job.status === 'paused') {
    if (to === 'canceled') return { ...job, status: 'canceled', prevStatus: null, updatedAt: now };
    if (job.prevStatus != null && to === job.prevStatus) {
      return { ...job, status: to, prevStatus: null, updatedAt: now };
    }
    throw new Error(`非法状态迁移: paused -> ${to}`);
  }
  if (!TRANSITIONS[job.status].includes(to)) throw new Error(`非法状态迁移: ${job.status} -> ${to}`);
  return { ...job, status: to, prevStatus: to === 'paused' ? job.status : job.prevStatus, updatedAt: now };
}

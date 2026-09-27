import type { ProviderDispatchCooldown } from '../../core/provider';
import type { Job } from '../../core/types';

/** DeepSeek 官方限流后等待 65 分钟再尝试，给官方窗口留出额外缓冲。 */
export const DEEPSEEK_RATE_LIMIT_RETRY_MS = 65 * 60_000;
/** 已存在的 DeepSeek 会话有时可在较短等待后继续生成，不代表可以发送新消息。 */
export const DEEPSEEK_CONTINUATION_PROBE_MS = 35 * 60_000;

/** 主动节流用于在官方限流前停住；官方限流事件仍会记录并按 65 分钟退避。 */
export const DEEPSEEK_PROACTIVE_COOLDOWN_ENABLED = true;

/**
 * 网页端没有公开可依赖的输入/输出配额。根据本次约 17.6M 输入字符时触发限流的记录，
 * 采用偏保守的一小时滚动窗口保护：输入无历史限流时先控制在约 6.5M 字符；
 * 有可信的限流样本后，以历史最低输入量的 75% 作为输入预算。
 * 输出单独按 22 万字符保护；发送前无法预知下一次输出，因此以前一小时已收集输出量为准。
 * 4M 以上的限流样本也纳入学习，避免把近期较低的真实上限完全忽略。
 */
export const DEEPSEEK_PROACTIVE_WINDOW_MS = 60 * 60_000;
export const DEEPSEEK_PROACTIVE_MAX_INPUT_CHARS = 6_500_000;
export const DEEPSEEK_PROACTIVE_MAX_OUTPUT_CHARS = 220_000;
/** 连续创建网页会话/提交消息之间留出人工操作级别的间隔。 */
export const DEEPSEEK_MIN_DISPATCH_INTERVAL_MS = 8_000;
/** 兼容旧测试和旧调用方：旧名称表示默认输入预算。 */
export const DEEPSEEK_PROACTIVE_MAX_TRAFFIC_CHARS = DEEPSEEK_PROACTIVE_MAX_INPUT_CHARS;
export const DEEPSEEK_PROACTIVE_MIN_LEARNABLE_CHARS = 4_000_000;
export const DEEPSEEK_PROACTIVE_SAFETY_RATIO = 0.75;

export function getDeepSeekDispatchCooldown(
  job: Pick<Job, 'trafficHistory' | 'rateLimitEvents'>,
  inputChars: number,
  now: number,
): ProviderDispatchCooldown | null {
  if (!DEEPSEEK_PROACTIVE_COOLDOWN_ENABLED) return null;
  const history = (job.trafficHistory ?? [])
    .filter((sample) => sample.submittedAt > now - DEEPSEEK_PROACTIVE_WINDOW_MS && sample.submittedAt <= now)
    .sort((left, right) => left.submittedAt - right.submittedAt);
  // 输入额度从提交时开始消耗；输出额度从完整回复收集时开始消耗。
  // 长回复可能跨越数分钟，不能用提交时间把刚产生的输出排除在窗口外。
  const outputHistory = (job.trafficHistory ?? [])
    .filter((sample) => {
      const completedAt = sample.completedAt ?? sample.submittedAt;
      return completedAt > now - DEEPSEEK_PROACTIVE_WINDOW_MS && completedAt <= now;
    });
  const latestSubmittedAt = history.at(-1)?.submittedAt;
  const pacedUntil = latestSubmittedAt == null
    ? null
    : latestSubmittedAt + DEEPSEEK_MIN_DISPATCH_INTERVAL_MS;
  const currentInput = Math.max(0, inputChars);
  const priorInput = history.reduce((total, sample) => total + Math.max(0, sample.inputChars), 0);
  const priorOutput = outputHistory.reduce((total, sample) => total + Math.max(0, sample.outputChars ?? 0), 0);
  const observedBudgets = (job.rateLimitEvents ?? [])
    .map((event) => event.intervalInputChars ?? event.inputChars ?? 0)
    .filter((total) => total >= DEEPSEEK_PROACTIVE_MIN_LEARNABLE_CHARS);
  const learnedBudget = observedBudgets.length > 0
    ? Math.floor(Math.min(...observedBudgets) * DEEPSEEK_PROACTIVE_SAFETY_RATIO)
    : DEEPSEEK_PROACTIVE_MAX_INPUT_CHARS;
  const inputReached = priorInput + currentInput >= learnedBudget;
  const outputReached = priorOutput >= DEEPSEEK_PROACTIVE_MAX_OUTPUT_CHARS;
  if (!inputReached && !outputReached) {
    return pacedUntil != null && pacedUntil > now
      ? { until: pacedUntil, detail: `DeepSeek 主动节流：连续发送间隔不足 ${DEEPSEEK_MIN_DISPATCH_INTERVAL_MS / 1_000} 秒` }
      : null;
  }

  const oldestInput = history[0]?.submittedAt;
  const oldestOutput = outputHistory
    .map((sample) => sample.completedAt ?? sample.submittedAt)
    .sort((left, right) => left - right)[0];
  const oldest = inputReached && outputReached
    ? Math.min(oldestInput ?? Number.POSITIVE_INFINITY, oldestOutput ?? Number.POSITIVE_INFINITY)
    : inputReached ? oldestInput : oldestOutput;
  if (oldest == null) return null;
  const until = Math.max(oldest + DEEPSEEK_PROACTIVE_WINDOW_MS, pacedUntil ?? 0);
  if (until <= now) return null;
  return {
    until,
    detail: outputReached
      ? `DeepSeek 主动节流：近 1 小时输出量达到 ${DEEPSEEK_PROACTIVE_MAX_OUTPUT_CHARS.toLocaleString()} 字符（输入预算 ${learnedBudget.toLocaleString()}），等待窗口恢复`
      : `DeepSeek 主动节流：近 1 小时输入量达到 ${learnedBudget.toLocaleString()} 字符（输出预算 ${DEEPSEEK_PROACTIVE_MAX_OUTPUT_CHARS.toLocaleString()}），等待窗口恢复`,
  };
}

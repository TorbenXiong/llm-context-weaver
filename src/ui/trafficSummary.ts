import type { Job } from '../core/types';

export interface TrafficSummary {
  inputChars: number;
  outputChars: number;
  cumulativeInputChars: number;
  cumulativeOutputChars: number;
}

/** 本轮按账号切换/官方限流重置；累计始终覆盖整个任务的所有账号。 */
export function summarizeTraffic(job: Pick<Job, 'providerAccountKey' | 'providerAccountChangedAt' | 'trafficHistory' | 'rateLimitEvents'>): TrafficSummary {
  const accountKey = job.providerAccountKey;
  const since = job.providerAccountChangedAt ?? 0;
  const samples = (job.trafficHistory ?? []).filter((sample) =>
    (!accountKey || sample.accountKey === accountKey) && sample.submittedAt >= since,
  );
  const latest = (job.rateLimitEvents ?? []).filter((event) =>
    !accountKey || event.accountKey === accountKey,
  ).at(-1);
  const afterLatestInput = latest ? samples.filter((sample) => sample.submittedAt > latest.occurredAt) : samples;
  const afterLatestOutput = latest ? samples.filter((sample) =>
    (sample.completedAt ?? sample.submittedAt) > latest.occurredAt,
  ) : samples;
  const inputChars = afterLatestInput.reduce((total, sample) => total + Math.max(0, sample.inputChars), 0);
  const outputChars = afterLatestOutput.reduce((total, sample) => total + Math.max(0, sample.outputChars ?? 0), 0);
  const latestGlobal = job.rateLimitEvents?.at(-1);
  const globalSamples = job.trafficHistory ?? [];
  const cumulativeInputChars = (latestGlobal?.cumulativeInputChars ?? latestGlobal?.inputChars ?? 0)
    + globalSamples.filter((sample) => !latestGlobal || sample.submittedAt > latestGlobal.occurredAt)
      .reduce((total, sample) => total + Math.max(0, sample.inputChars), 0);
  const cumulativeOutputChars = (latestGlobal?.cumulativeOutputChars ?? latestGlobal?.outputChars ?? 0)
    + globalSamples.filter((sample) => !latestGlobal || (sample.completedAt ?? sample.submittedAt) > latestGlobal.occurredAt)
      .reduce((total, sample) => total + Math.max(0, sample.outputChars ?? 0), 0);
  return {
    inputChars,
    outputChars,
    cumulativeInputChars,
    cumulativeOutputChars,
  };
}

import type { ChunkMeta, FormatState, Job, ReduceGroup, ReduceState, ResultRecord } from '../types';

export interface ReprocessPlan {
  job: Job;
  changedChunks: ChunkMeta[];
  nextStatus: 'processing' | 'reducing';
}

const unitKey = (result: Pick<ResultRecord, 'kind' | 'ref'>): string => `${result.kind}:${result.ref}`;

/** 当前任务实际引用的结果。历史结果保留供追溯，但不能作为重跑入口。 */
export function activeResultIds(job: Job, metas: ChunkMeta[], records: ResultRecord[]): Set<string> {
  const byId = new Map(records.map((result) => [result.id, result]));
  const ids = new Set<string>();
  const pending = [
    ...metas.flatMap((meta) => [meta.indexResultId, meta.resultId]),
    job.formatPlanResultId,
    job.finalResultId,
    job.formatState?.planResultId,
    ...(job.formatState?.inputIds ?? []),
    ...(job.formatState?.outputIds ?? []),
    ...Object.values(job.formatState?.reusedOutputIds ?? {}),
    ...(job.reduceState?.inputIds ?? []),
    ...(job.reduceState?.outputIds ?? []),
    ...Object.values(job.reduceState?.reusedOutputIds ?? {}),
  ];
  const preflight = records
    .filter((result) => result.kind === 'format' && result.ref === 'preflight')
    .sort((left, right) => right.createdAt - left.createdAt)[0];
  if (preflight && job.config.pipelineMode === 'staged' && job.config.taskKind === 'knowledge') pending.push(preflight.id);
  while (pending.length > 0) {
    const id = pending.pop();
    if (!id || ids.has(id)) continue;
    const result = byId.get(id);
    if (!result) continue;
    ids.add(id);
    pending.push(...result.sourceIds);
  }
  return ids;
}

function groupsFromResults(results: ResultRecord[], inputIds: string[]): ReduceGroup[] {
  const groups: ReduceGroup[] = [];
  let start = 0;
  for (const result of results) {
    const end = start + result.sourceIds.length;
    if (result.sourceIds.length === 0 ||
      result.sourceIds.some((id, offset) => id !== inputIds[start + offset])) {
      throw new Error('历史分组与当前输入不一致，无法安全复用同阶段结果');
    }
    groups.push({ start, end });
    start = end;
  }
  if (start !== inputIds.length) throw new Error('历史分组不完整，无法安全重跑');
  return groups;
}

function attemptBases(records: ResultRecord[]): Record<string, number> {
  const bases: Record<string, number> = {};
  for (const result of records) {
    const match = /:a(\d+)$/.exec(result.id);
    if (!match) continue;
    const key = unitKey(result);
    bases[key] = Math.max(bases[key] ?? 0, Number(match[1]));
  }
  return bases;
}

export function planReprocess(job: Job, metas: ChunkMeta[], records: ResultRecord[], selectedIds: string[]): ReprocessPlan {
  if (selectedIds.length === 0) throw new Error('请先选择要重新发起的会话');
  if (job.status !== 'completed' && job.status !== 'failed') throw new Error('请先等待任务结束，或暂停后处理当前会话');
  if (job.current) throw new Error('当前会话尚未对账，不能从历史结果重跑');
  const byId = new Map(records.map((result) => [result.id, result]));
  const active = activeResultIds(job, metas, records);
  const selected = [...new Set(selectedIds)].map((id) => {
    const result = byId.get(id);
    if (!result || !active.has(id)) throw new Error('所选会话已不是当前有效结果，请刷新任务后重选');
    return result;
  });
  const first = selected[0]!;
  const isChunkStage = (result: ResultRecord): boolean => result.kind === 'index' || result.kind === 'extract';
  if (!selected.every((result) => isChunkStage(first)
    ? isChunkStage(result)
    : result.kind === first.kind && (result.kind !== 'format' || result.ref === first.ref)
      && (result.kind !== 'reduce' || result.level === first.level))) {
    throw new Error('一次只能重跑同一阶段的会话；索引与提炼分块可一起选择');
  }
  const bases = attemptBases(records);
  const preflight = records
    .filter((result) => result.kind === 'format' && result.ref === 'preflight')
    .sort((left, right) => right.createdAt - left.createdAt)[0];
  const common: Job = {
    ...job,
    current: null,
    finalResultId: null,
    lastError: null,
    failedChunks: [],
    reprocessAttemptBases: bases,
  };
  if (first.kind === 'index' || first.kind === 'extract') {
    const selectedIndex = new Set(selected.filter((result) => result.kind === 'index').map((result) => Number(result.ref)));
    const selectedExtract = new Set(selected.filter((result) => result.kind === 'extract').map((result) => Number(result.ref)));
    if ([...selectedIndex].some((index) => selectedExtract.has(index))) {
      throw new Error('同一分块不能同时选择索引和提炼会话，请只选择其中一个阶段');
    }
    const changedChunks = metas.filter((meta) => selectedIndex.has(meta.index) || selectedExtract.has(meta.index)).map((meta) => {
      if (selectedIndex.has(meta.index)) {
        if (!selected.some((result) => result.kind === 'index' && result.id === meta.indexResultId)) {
          throw new Error(`分块 ${meta.index} 的索引已失效`);
        }
        return { ...meta, status: 'pending' as const, stage: 'index' as const, indexResultId: null, resultId: null,
          attempts: bases[`index:${meta.index}`] ?? meta.attempts, error: null };
      }
      if (!selected.some((result) => result.kind === 'extract' && result.id === meta.resultId)) {
        throw new Error(`分块 ${meta.index} 的提炼结果已失效`);
      }
      return { ...meta, status: 'pending' as const, stage: 'process' as const, resultId: null,
        attempts: bases[`extract:${meta.index}`] ?? meta.attempts, error: null };
    });
    // 重跑分块提炼时沿用当前已生效的动态格式规范；不能退回到最初的样本预检结果。
    return { job: { ...common, formatState: null, reduceState: null, formatPlanResultId: job.formatPlanResultId ?? null },
      changedChunks, nextStatus: 'processing' };
  }
  if (first.kind === 'format' && first.ref === 'preflight') {
    const changedChunks = metas.map((meta) => ({ ...meta, status: 'pending' as const, stage: 'index' as const,
      indexResultId: null, resultId: null, attempts: bases[`index:${meta.index}`] ?? meta.attempts, error: null }));
    return { job: { ...common, formatPlanResultId: null, formatState: null, reduceState: null },
      changedChunks, nextStatus: 'processing' };
  }
  if (first.kind === 'format' && first.ref === 'plan') {
    if (job.formatPlanResultId !== first.id) throw new Error('所选格式规范已不是当前版本');
    return { job: { ...common, formatPlanResultId: preflight?.id ?? null, formatState: null, reduceState: null },
      changedChunks: [], nextStatus: 'processing' };
  }
  if (first.kind === 'normalize') {
    const plan = job.formatPlanResultId ? byId.get(job.formatPlanResultId) : undefined;
    if (!plan || plan.kind !== 'format' || plan.ref !== 'plan') throw new Error('当前格式规范缺失，无法单独重跑格式统一');
    const siblings = records.filter((result) => result.kind === 'normalize' && active.has(result.id))
      .sort((left, right) => Number(left.ref.replace('batch-', '')) - Number(right.ref.replace('batch-', '')));
    if (siblings.some((result, index) => result.ref !== `batch-${index}`)) throw new Error('格式统一分组记录不完整');
    const selectedSet = new Set(selectedIds);
    const reusedOutputIds = Object.fromEntries(siblings
      .filter((result) => !selectedSet.has(result.id))
      .map((result) => [Number(result.ref.replace('batch-', '')), result.id]));
    const formatState: FormatState = { phase: 'normalizing', inputIds: plan.sourceIds,
      planResultId: plan.id, groups: groupsFromResults(siblings, plan.sourceIds), nextGroup: 0,
      outputIds: [], reusedOutputIds };
    return { job: { ...common, formatState, reduceState: null }, changedChunks: [], nextStatus: 'reducing' };
  }
  if (first.kind === 'reduce') {
    const siblings = records.filter((result) => result.kind === 'reduce' && result.level === first.level && active.has(result.id))
      .sort((left, right) => Number(left.ref.split('-')[1]) - Number(right.ref.split('-')[1]));
    if (siblings.some((result, index) => result.ref !== `${first.level}-${index}`)) throw new Error('归并分组记录不完整');
    const inputIds = siblings.flatMap((result) => result.sourceIds);
    const selectedSet = new Set(selectedIds);
    const reusedOutputIds = Object.fromEntries(siblings
      .filter((result) => !selectedSet.has(result.id))
      .map((result) => [Number(result.ref.split('-')[1]), result.id]));
    const reduceState: ReduceState = { level: first.level, inputIds,
      groups: groupsFromResults(siblings, inputIds), nextGroup: 0, outputIds: [], reusedOutputIds };
    return { job: { ...common, formatState: null, reduceState }, changedChunks: [], nextStatus: 'reducing' };
  }
  throw new Error('暂不支持重跑该会话类型');
}

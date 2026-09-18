export interface ReplyCandidate {
  followsMarker: boolean;
  isThinking: boolean;
  text: string;
}

/** DeepSeek 会依次渲染思考过程和最终答案；思考节点不得作为可收集回复。 */
export function selectLastReplyText(candidates: readonly ReplyCandidate[]): string | null {
  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index];
    if (candidate?.followsMarker && !candidate.isThinking && candidate.text.trim()) return candidate.text.trim();
  }
  return null;
}

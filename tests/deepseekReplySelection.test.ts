import { describe, expect, it } from 'vitest';
import { selectLastReplyText } from '../src/providers/deepseek/replySelection';

describe('selectLastReplyText', () => {
  it('跳过思考过程并选择 marker 后最后一个最终答案', () => {
    expect(selectLastReplyText([
      { followsMarker: false, isThinking: false, text: '旧回复' },
      { followsMarker: true, isThinking: true, text: '思考过程，不是 JSON' },
      { followsMarker: true, isThinking: false, text: '```json\n{"knowledge":[]}\n```' },
    ])).toBe('```json\n{"knowledge":[]}\n```');
  });

  it('忽略末尾空节点', () => {
    expect(selectLastReplyText([
      { followsMarker: true, isThinking: false, text: '最终答案' },
      { followsMarker: true, isThinking: false, text: '   ' },
    ])).toBe('最终答案');
  });

  it('只有思考过程时返回 null，等待最终答案挂载', () => {
    expect(selectLastReplyText([
      { followsMarker: true, isThinking: true, text: '仍在思考' },
    ])).toBeNull();
  });
});

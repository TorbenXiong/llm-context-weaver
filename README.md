# LLM Context Weaver

Manifest V3 浏览器扩展：把大型文本或聊天记录分块交给网页 LLM 处理，递归归并结果，导出 JSON、Markdown 或公司 AI 助手使用的 `SKILL.md`。

## 架构

- `src/core/`：Provider 无关的任务状态机、持久化、分块、归并和输出协议。
- `src/providers/deepseek/`：DeepSeek 网页 Adapter，负责标签页、DOM、提交确认、续写和会话清理。
- `src/background/`：MV3 Service Worker 消息与告警接线。
- `src/ui/`：任务创建、控制、进度和结果导出。

核心层只依赖 Provider 抽象；网页 URL、DOM 选择器和限流细节只能存在于 Adapter。

## 任务流程

默认流程为：

1. 建立与用户目标相关的索引；
2. 回到原文完成目标处理；
3. 按预算递归归并，直到得到最终结果。

翻译、改写等线性任务可以选择直接流程，跳过索引。所有阶段都持久化状态，支持暂停、恢复、失败重试和扩展重载后继续。

知识任务使用 schema v2：

```json
{
  "knowledge": [
    {
      "time": "原文明确的时间（可选）",
      "category": "分类",
      "topic": "主题",
      "content": "核心知识",
      "details": { "参数或步骤": "仅必要时填写" }
    }
  ]
}
```

`category`、`topic`、`content` 是必填字段；`time` 和 `details` 按需填写。归并按主题合并重复内容，保留必要差异，不补写原文没有的信息。

新建任务还可以限制测试范围：按输入百分比，或最多处理若干个原文分块。这个限制只影响知识提炼，归并不计入；多阶段流程每个分块会先索引再处理。例如设置为 3，就是先完成前 3 个分块的知识提炼，再归并这 3 个结果。

## 可靠性

每个工作单元按 `prepared → submitting → acknowledged` 持久化 claim。提交结果不明确时停止自动重发，等待对账；只有确认网页未收到请求后，才允许强制重试。结果、分块状态和任务状态写入 IndexedDB，Service Worker 被终止或页面刷新后可恢复。

## 开发

```bash
npm test
npm run typecheck
npm run build
```

构建产物在 `dist/`，在 Chromium 扩展管理页选择“加载已解压的扩展程序”载入。真实 DeepSeek DOM 属于外部边界，发布前应执行一次人工 smoke test。

# LLM Context Weaver

LLM Context Weaver 是一个 Manifest V3 浏览器扩展：把大型文本或聊天记录流式分块，通过网页 LLM 做结构化知识提炼，再动态执行多层归并，最终导出统一的 JSON / Markdown 知识。

当前 MVP 只提供 DeepSeek Web Adapter，但核心引擎不依赖 DeepSeek、网页 DOM、URL 或 Chrome tab。

## 架构

- `src/core/`：Provider 无关的任务状态机、持久化编排、分块、归并与知识 schema。
- `src/providers/deepseek/`：DeepSeek 的 tab 生命周期、DOM Adapter、选择器、提交确认与远端对账。
- `src/background/`：MV3 事件接线和 mutation 串行化。
- `src/ui/`：任务导入、控制、进度和结果导出。

核心与 Provider 之间只传递 `providerId`、不透明 `connectionId` / `remoteRef` 以及 `submit` / `inspect` 的标准结果。新增 Provider 不应修改核心引擎。

## 可靠性模型

每个工作单元使用持久化 claim，并经历 `prepared → submitting → acknowledged`：

1. 在操作网页前先保存 claim。
2. Adapter 只有观察到输入框清空、生成开始或会话 URL 变化后，才返回 `accepted`。
3. 提交后失联属于模糊结果：任务 fail closed，保留 claim 供恢复对账，不自动重发。
4. 结果记录、Chunk 完成和 Job 推进在同一 IndexedDB 事务中提交。
5. 归并计划必须减少结果数量；无法收敛时明确失败，不无限增加层数。

MV3 Service Worker 可随时终止，内存只用于当前事件的串行化；可恢复状态全部在 IndexedDB 中。

模糊投递时，工作台提供“再次对账”；只有用户确认网页未收到请求后，才能选择“强制重试”。后者可能重复发送，因此不会自动触发。

## 大文件

文件导入通过 `Blob.stream()` 增量解码、分块并分批写入 IndexedDB。推荐 50MB 级输入使用文件选择器；粘贴输入仍适合较小文本。

## 开发

仓库已有依赖可用时：

```bash
npm test
npm run typecheck
npm run build
```

构建产物位于 `dist/`，可在 Chromium 扩展管理页通过“加载已解压的扩展程序”载入。真实网页 DOM 是外部不稳定边界，发布前仍需针对当时的 DeepSeek 页面执行人工 smoke test。

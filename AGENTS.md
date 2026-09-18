# llm-context-weaver 项目开发规范

> 本文件是 Codex 在本项目中的项目级规范，与全局约定互补；不得放宽全局安全限制。

## 项目概述

LLMContextWeaver 是一个浏览器扩展（Manifest V3 + TypeScript + React）：将超大文本/聊天记录自动分块，通过网页版 LLM 分批做结构化知识提炼，收集结果后多层递归归并，最终产出结构化知识。

## 最高架构原则：提供商无关（Provider-Agnostic）

**不要为 DeepSeek 优化 LLMContextWeaver。DeepSeek 只是第一个提供商（Provider）实现。编排引擎、任务模型、分块系统、归约管道和存储层必须保持与提供商无关。**

> 原文：Do not optimize LLMContextWeaver for DeepSeek. DeepSeek is just the first provider implementation. The orchestration engine, job model, chunking system, reduction pipeline, and storage layer must remain provider-agnostic.

具体要求：

- 核心层（编排引擎 / 任务模型 / 分块系统 / 归约管道 / 存储层）不得 import、引用或依赖任何 DeepSeek 专有代码、DOM 结构、CSS 选择器、URL、请求格式或限流参数。
- 所有与具体模型网页相关的差异，只能通过 Provider Adapter 接口接入；DeepSeek 只是 `providers/deepseek` 下的一个实现，与未来的 ChatGPT / Claude / Gemini 适配器地位平等。
- 设计或修改任何功能时，先判断它属于核心层还是 Adapter 层：凡是“换一个提供商就需要改动”的逻辑，一律归入 Adapter 接口，不得渗漏进核心层。
- 核心层之间、核心层与 Adapter 之间的交互只依赖抽象接口与数据契约（Chunk、Job、JobState、ExtractionResult 等），不依赖任何提供商的运行时行为。
- 代码审查时本原则是否决项：核心层出现提供商专有耦合的实现，必须退回修改，不得以“先跑通 MVP”为理由合入。

## 架构分层与目录约定

- 技术栈：Manifest V3 + TypeScript + React；React 只用于 UI（popup / options / 面板），不得进入核心层依赖。
- 目录约定：
  - `src/core/`：编排引擎、任务模型、分块系统、归约管道、存储层、提炼协议 schema。禁止依赖 DOM、chrome.tabs 以外的网页环境，以及任何 providers 代码。
  - `src/providers/<name>/`：Provider Adapter 实现（首个为 `deepseek`），只允许依赖 `src/core/` 的抽象接口。
  - `src/ui/`：React 界面，通过消息/API 与核心层交互，不直接操作网页 DOM。
- 核心 Engine 与网页 DOM Adapter 完全解耦：核心层应可以在无浏览器 DOM 的环境（如单元测试）中独立运行。

## Provider Adapter 契约

每个 Adapter 至少实现以下能力，DeepSeek 为第一个实现：

- 输入与发送：将 Chunk 内容填入网页输入框并触发发送。
- 状态检测：判断模型“生成中 / 生成完成”。
- 结果获取：完整读取最新一条回复文本。
- 异常恢复：页面刷新、超时、发送失败后的恢复与重试。
- 限流等待：识别提供商的限流/频率限制并等待恢复，限流参数属于 Adapter 内部实现细节。

## 任务状态机

- 状态：`Split → Processing → Waiting → Collecting → Reducing → Completed`。
- 控制操作：`Pause / Resume / Retry / Cancel`，可在非终态下触发。
- 状态迁移必须显式定义、可持久化；不允许出现绕过状态机的隐式流程跳转。
- 每个 Chunk 有独立处理状态，支持按 Chunk 粒度的 Retry，失败不阻塞整体 Pause/Resume。

## 可靠性要求

- 浏览器刷新、DeepSeek 页面刷新、插件关闭/重启后，任务必须能从持久化状态恢复并继续。
- 避免重复发送 Chunk：发送与结果收集必须幂等，恢复时通过 Chunk 状态与结果记录去重，而不是依赖内存标记。
- 任务与中间结果的持久化发生在状态变更时，而不是等整批完成后一次性写入。

## 知识提炼协议

- 提炼目标不是“摘要”，而是结构化提取，至少覆盖：事实、项目、决策、解决方案、偏好、时间线、待办、未解决问题。
- 提炼结果使用统一的结构化数据契约（schema），schema 定义在核心层并带版本号；Adapter 只负责搬运文本，不自定义结果格式。
- 提炼 prompt 模板属于核心层资产，可按 Provider 做措辞适配，但输出结构必须一致。

## Hierarchical Reduce

- 中间提炼结果过大时，自动继续分组归并，逐层收敛，直到可以生成最终知识。
- 归并层数由输入规模动态决定，不得硬编码固定层数；每层归并可复用同一套 Adapter 发送/收集机制。
- 每层中间结果同样持久化，支持从任意归并层恢复。

## MVP 范围与验收标准

- MVP 只实现 DeepSeek Web 一个 Provider，目标是跑通 50MB 级聊天记录的完整流程（分块 → 分批提炼 → 收集 → 递归归并 → 最终知识）。
- 验收标准：使用真实的大型聊天记录测试，无人值守完成多批处理与最终归并；中途模拟页面刷新/插件重启后任务可恢复，且无 Chunk 重复发送。
- MVP 阶段不为 DeepSeek 之外的 Provider 写实现代码，但接口设计必须满足“新增 Provider 不改动核心层”。
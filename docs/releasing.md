# 发布流程

1. 在独立分支完成修改与审查，同步 `package.json`、`package-lock.json` 根版本和 `public/manifest.json`。只改版本字段，不重新解析依赖。
2. 使用现有依赖执行 `npm test`、`npm run typecheck`、`npm run build` 和 `git diff --check`。真实网页验收需另行记录，不能用模拟 Provider 测试替代。
3. 按项目工作约定展示文件范围及完整提交信息，获得针对本次 `git commit` 的确认后提交、推送并创建 PR。
4. 审查最终 PR 差异、检查结果和合并状态；合并后从确认的合并提交重新构建。
5. 将 `dist/` 的内容打包为 `LLMContextWeaver-<版本>.zip`，ZIP 根目录应直接包含 `manifest.json`。核对文件清单、版本和 SHA-256；不要打包本地数据库、日志、凭据或 `node_modules`。
6. 在合并提交上创建版本标签与 GitHub Release，上传 ZIP。发布说明包含实际改动、验证范围、已知限制、升级方式及 SHA-256。
7. 确认分支已合并、工作区干净且发布成功后，删除相应远端和本地功能分支。不得删除仍有未合并工作的分支。

`dist/` 为构建产物，不提交到 Git。测试失败、版本不同步或审查尚有阻塞项时，不进入发布步骤。

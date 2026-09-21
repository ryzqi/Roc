# Idea Canvas 与项目语言

构思阶段把研究想法写成结构化 Idea Canvas。项目语言是项目级中英设置，阶段 Agent 按该语言输出；界面仍为中文。成熟且已批准的 Canvas 可以晋升为新研究项目，并保留来源版本。

## 项目语言

创建项目时 `language` 为 `zh` 或 `en`。省略时默认为中文。`updateProject` 可在之后修改。旧项目升级后为中文，没有来源记录。导出模板语言仍由导出请求单独指定。

```typescript
await research.createProject({
  title: '证据图研究',
  description: '把可晋升想法变成可追溯项目。',
  workspacePath: null,
  language: 'zh'
});
```

## 保存 Canvas

工件类型必须是 `idea_canvas`。七个字段都要填写：问题、假设、新颖性、支持证据、反证、实验、风险。支持性内容必须引用本项目真实 `evidenceIds`；假设和待验证字段不得标成 supported。空的反证可以保留，但字段本身不能缺。写入使用 `expectedVersion`：首次为 `null`，之后必须匹配当前版本。

```typescript
await research.saveIdeaCanvas({
  artifactId,
  expectedVersion: null,
  problem: '如何保持证据图可检查？',
  hypothesis: '结构化 Canvas 能减少无依据晋升。',
  novelty: '晋升保留已批准 Canvas 版本。',
  supportingEvidence: '既有方法缺少晋升记录。',
  counterevidence: '',
  experiment: '批准后晋升并核对来源。',
  risks: '过期 Canvas 可能重复创建项目。',
  priority: 'high',
  rationale: '新颖性最高，且有可检验路径。',
  fields
});
```

`getIdeaCanvas` 与 `getIdeaCanvasHistory` 读取当前版本和历史快照。构思阶段 complete/approve 会重新校验当前快照、证据归属和内容哈希。

## 晋升

仅已批准且当前版本的 Canvas 可以晋升：

```typescript
await research.promoteIdeaCanvas({
  artifactId,
  expectedVersion: 1,
  title: '证据图项目'
});
```

新项目从 discovery 开始，复制来源项目语言，并记录 `origin.projectId/artifactId/version`。同一 Canvas 版本重复晋升返回原项目，不另建副本。来源项目的产物、证据和流程保持不变。

## 阶段 Agent

构思角色输出必须包含 `ideaCanvas`。系统把它写入本次运行创建的 `idea_canvas` 工件；缺少结构、证据或字段一致性时运行失败，不打开审核闸门。

科研页构思面板保存 Canvas、查看历史，并在已批准版本上晋升为新项目。

## 验证

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research/idea-canvas.test.ts
```

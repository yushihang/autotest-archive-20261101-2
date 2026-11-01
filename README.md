# autotest

DevTool GitHub 流水线的演练仓库。

## 触发一次 agent 任务

1. 新建 issue，正文写清任务与验收标准（每个验收命令单独一行：`验证：<命令>`）。
2. 有前后依赖时加一行 `Depends on #<编号>`。
3. 最后给 issue 加上 `agent` 标签——加标签即启动一次 develop run。

## 跑一个多 issue 计划

- 所有任务和一条追踪 issue 共用 `plan:<slug>` 标签；追踪 issue 标题以 `[plan] ` 开头。
- 单个任务可用 `预算：$2`（美元）、`Budget: 200k`（tokens）、`时限：30m`（时长）限制成本。
- 全部任务合并后，supervisor 会自动关闭追踪 issue。

## 本地开发

技术栈：Next.js(App Router) + TypeScript + Tailwind CSS v4 + pnpm，测试用 Vitest。

```bash
pnpm install
cp .env.example .env.local
pnpm dev      # http://localhost:3000
```

完整步骤见 [`docs/dev-setup.md`](docs/dev-setup.md)；REST 契约见 [`docs/api-contract.md`](docs/api-contract.md)；
领域类型在 `src/lib/domain/types.ts`。

## CI

`.github/workflows/ci.yml` 在 push 和 pull request 时运行；仓库还没有 `package.json` 时只打印占位信息。

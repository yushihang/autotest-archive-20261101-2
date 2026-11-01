# 本地开发

## 1. 前置条件

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20.9（推荐 22 LTS） | Next.js 15 的最低要求 |
| pnpm | 9.x（`packageManager` 已锁定 9.15.9） | 用 `corepack enable` 可直接获得 |

```bash
node -v      # v20.9+ / v22.x
corepack enable
pnpm -v      # 9.15.9
```

如果打不开 corepack，`npm i -g pnpm@9` 也可以。

## 2. 安装依赖

```bash
pnpm install
```

## 3. 配置环境变量

```bash
cp .env.example .env.local
```

`.env.local` 已被 `.gitignore` 忽略，不要提交真实密钥。各变量的含义：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | `file:./.data/autotest.db` | SQLite 文件路径；`.data/` 不入库 |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容的 base URL（可指向自建网关） |
| `LLM_API_KEY` | 空 | 模型密钥；为空时“只给 intent”的建 run 请求会返回 `422` |
| `LLM_MODEL` | `gpt-4o-mini` | 生成测试计划所用模型 |
| `ARTIFACT_DIR` | `./artifacts` | 截图/日志/报告的落盘根目录 |
| `RUN_TIMEOUT_MS` | `600000` | 单次 run 总超时（10 分钟） |
| `MAX_RUNS_PER_PROJECT` | `1` | 单项目允许的并发 run 数 |

> 本期（骨架）不会读写数据库、不会调用模型；这些变量先固化下来，供后续 issue 使用。

## 4. 启动

```bash
pnpm dev
```

打开 <http://localhost:3000>，落地页的「进入项目列表」指向 `/projects`（当前是占位页）。

生产构建：

```bash
pnpm build
pnpm start
```

## 5. 脚本

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 开发服务器（热更新） |
| `pnpm build` | 生产构建，同时跑类型检查与 ESLint |
| `pnpm start` | 运行已构建产物 |
| `pnpm lint` | ESLint（`next lint`） |
| `pnpm typecheck` | 仅类型检查（`tsc --noEmit`） |
| `pnpm test` | Vitest 单次运行 |
| `pnpm test:watch` | Vitest watch 模式 |

## 6. 测试

- 框架：Vitest + jsdom + Testing Library，配置见 `vitest.config.ts`；
- 用例位置：`src/**/*.test.ts(x)` 或 `tests/**/*.test.ts(x)`；
- 全局 API 已开启（`describe`/`it`/`expect` 无需 import），路径别名 `@/*` 可用；
- 骨架阶段只有一个领域模型的单元测试，`passWithNoTests` 打开，后续模块加用例即可。

```bash
pnpm test
```

## 7. 目录约定

```
src/
  app/                 # App Router 页面与路由处理器（/api/*）
  lib/domain/          # 领域类型（唯一数据契约来源）
  test/                # 测试 setup
docs/                  # 契约与开发文档
artifacts/             # 运行时产物（不入库）
.data/                 # 本地数据库文件（不入库）
```

后续模块请勿在 `src/lib/domain/types.ts` 之外重复定义领域类型；改契约要同时更新 `docs/api-contract.md`。

## 8. 常见问题

**端口被占用**

```bash
pnpm dev --port 3001
```

**`pnpm lint` 报 ESLint 配置错误**：确认 `eslint.config.mjs` 存在且 `eslint-config-next` 与 `next` 版本一致（都是 15.x）。

**CI 用 npm**：`.github/workflows/ci.yml` 在没有 `pnpm-lock.yaml` 时走 `npm install`，行为一致；本地推荐 pnpm。

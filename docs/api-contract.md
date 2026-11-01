# autotest REST 契约

本文是前后端、执行器与后续模块之间唯一的接口约定。**实现必须遵守本文**；要改就改这份文档，并在 PR 里说明影响面。

类型定义的唯一来源是 [`src/lib/domain/types.ts`](../src/lib/domain/types.ts)，本文中的字段语义以该文件为准。

## 1. 通用约定

| 项 | 约定 |
| --- | --- |
| Base path | `/api` |
| 请求/响应体 | `application/json; charset=utf-8` |
| 字段命名 | `camelCase` |
| id | 不透明字符串，调用方不得解析其中含义 |
| 时间 | ISO 8601 UTC 字符串，如 `2026-11-01T08:30:00.000Z` |
| 缺失值 | 用 `null` 表示“明确没有”，不省略字段 |
| 未知字段 | 服务端忽略；客户端也要容忍新增字段 |
| 认证 | 当前为单租户本地工具，未实现认证；后续如需接入再扩展，不改现有路径 |

### 1.1 分页

列表接口统一支持 `page`（从 1 开始，默认 1）与 `pageSize`（默认 20，最大 100）两个查询参数，响应统一为：

```json
{
  "items": [],
  "total": 0,
  "page": 1,
  "pageSize": 20
}
```

`total` 是过滤后的总条数，不是当前页条数。

### 1.2 错误体

所有非 2xx 响应使用同一个外壳：

```json
{
  "error": {
    "code": "validation_error",
    "message": "name 不能为空",
    "details": {
      "name": ["不能为空"]
    }
  }
}
```

`details` 只承载字段级错误，没有时为 `null`。错误码：

| `code` | HTTP | 含义 |
| --- | --- | --- |
| `bad_request` | 400 | 请求本身不合法：JSON 解析失败、缺少必填路径/查询参数、查询参数类型错误 |
| `validation_error` | 422 | 结构正确但语义不合法：字段缺失/越界、URL 不是合法 http(s) 地址等，详见 `details` |
| `not_found` | 404 | 资源不存在（项目、run、计划） |
| `conflict` | 409 | 与现有状态冲突：项目名重复、同一项目并发 run 超过 `MAX_RUNS_PER_PROJECT` |
| `run_not_cancellable` | 409 | run 已处于终态，无法取消 |
| `payload_too_large` | 413 | 请求体超过限制（默认 1 MiB） |
| `internal_error` | 500 | 服务端未预期错误，`message` 不包含堆栈 |

错误响应不返回 `200`+`{ok:false}` 这种“软失败”，一律用 HTTP 状态码。

### 1.3 状态码速查

| 场景 | 状态码 |
| --- | --- |
| 读取成功 | 200 |
| 创建成功 | 201，带 `Location` 头 |
| 取消等幂等动作成功 | 200 |
| 校验失败 | 422 |
| 资源不存在 | 404 |

---

## 2. 项目 `/api/projects`

### GET /api/projects

列出项目。查询参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `page` / `pageSize` | number | 见 1.1 |
| `q` | string | 可选，按 `name` 模糊匹配（大小写不敏感） |

响应 `200`：

```json
{
  "items": [
    {
      "id": "prj_7f3c1a",
      "name": "官网",
      "description": "公司官网的登录与下单流程",
      "baseUrl": "https://staging.example.com",
      "defaultStepTimeoutMs": 15000,
      "createdAt": "2026-10-20T02:11:00.000Z",
      "updatedAt": "2026-10-31T09:02:13.000Z"
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

错误：`400`（`page`/`pageSize` 不是正整数）、`500`。

### POST /api/projects

创建项目。

请求体：

```json
{
  "name": "官网",
  "description": "公司官网的登录与下单流程",
  "baseUrl": "https://staging.example.com",
  "defaultStepTimeoutMs": 15000
}
```

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `name` | 是 | 1–64 字符，去重（不区分大小写） |
| `description` | 否 | ≤ 500 字符，缺省为 `null` |
| `baseUrl` | 是 | 合法 `http(s)` URL，≤ 2048 字符 |
| `defaultStepTimeoutMs` | 否 | 1000–120000，缺省 15000 |

响应 `201`，`Location: /api/projects/prj_7f3c1a`：

```json
{
  "id": "prj_7f3c1a",
  "name": "官网",
  "description": "公司官网的登录与下单流程",
  "baseUrl": "https://staging.example.com",
  "defaultStepTimeoutMs": 15000,
  "createdAt": "2026-10-20T02:11:00.000Z",
  "updatedAt": "2026-10-20T02:11:00.000Z"
}
```

错误：

```json
{
  "error": {
    "code": "validation_error",
    "message": "baseUrl 不是合法的 URL",
    "details": {
      "baseUrl": ["必须是 http(s) URL"]
    }
  }
}
```

- `422`：`name` 为空/超长、`baseUrl` 非法、`defaultStepTimeoutMs` 越界。
- `409`：`name` 已存在。

---

## 3. 执行 `/api/runs`

### POST /api/runs

发起一次执行。返回 `201` 时 run 通常已处于 `queued` 或 `running`，调用方需轮询 `GET /api/runs/:id` 或订阅事件流。

请求体（三选一）：

**A. 用已保存的计划启动**

```json
{
  "projectId": "prj_7f3c1a",
  "planId": "plan_9b2d17",
  "trigger": "ui"
}
```

**B. 用内联计划启动（不落库为可复用计划）**

```json
{
  "projectId": "prj_7f3c1a",
  "trigger": "api",
  "plan": {
    "title": "登录并进入控制台",
    "summary": "验证账号密码登录后能跳到控制台首页",
    "baseUrl": "https://staging.example.com",
    "steps": [
      {
        "id": "step_1",
        "order": 0,
        "description": "打开登录页",
        "action": "goto",
        "target": "/login",
        "value": null,
        "expected": null,
        "timeoutMs": null
      },
      {
        "id": "step_2",
        "order": 1,
        "description": "填入用户名",
        "action": "fill",
        "target": "input[name=username]",
        "value": "demo",
        "expected": null,
        "timeoutMs": null
      },
      {
        "id": "step_3",
        "order": 2,
        "description": "点击登录",
        "action": "click",
        "target": "button[type=submit]",
        "value": null,
        "expected": null,
        "timeoutMs": 5000
      },
      {
        "id": "step_4",
        "order": 3,
        "description": "看到控制台标题",
        "action": "assert_text",
        "target": "h1",
        "value": null,
        "expected": "控制台",
        "timeoutMs": null
      }
    ]
  }
}
```

**C. 只给自然语言意图（由 LLM 生成计划）**

```json
{
  "projectId": "prj_7f3c1a",
  "intent": "用自己的账号登录后能进入控制台，并且侧边栏有“项目”入口",
  "trigger": "ui"
}
```

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `projectId` | 是 | 必须存在，否则 `404` |
| `planId` / `plan` / `intent` | 是（且只能给一个） | 同时给多个 → `400` |
| `trigger` | 否 | `api`(默认) / `ui` / `schedule` |

响应 `201`，`Location: /api/runs/run_4c8e02`：

```json
{
  "id": "run_4c8e02",
  "projectId": "prj_7f3c1a",
  "status": "queued",
  "planId": "plan_9b2d17",
  "planSnapshot": {
    "id": "plan_9b2d17",
    "projectId": "prj_7f3c1a",
    "title": "登录并进入控制台",
    "summary": "验证账号密码登录后能跳到控制台首页",
    "baseUrl": null,
    "steps": [
      {
        "id": "step_1",
        "order": 0,
        "description": "打开登录页",
        "action": "goto",
        "target": "/login",
        "value": null,
        "expected": null,
        "timeoutMs": null
      }
    ],
    "createdAt": "2026-10-28T06:00:00.000Z",
    "updatedAt": "2026-10-28T06:00:00.000Z"
  },
  "trigger": "api",
  "createdAt": "2026-11-01T08:30:00.000Z",
  "startedAt": null,
  "finishedAt": null,
  "durationMs": null,
  "failureKind": null,
  "error": null,
  "cases": []
}
```

错误：

- `404` `not_found`：`projectId` 或 `planId` 不存在。
- `422` `validation_error`：`plan.steps` 为空、`order` 不连续、`action` 不在枚举内。
- `400` `bad_request`：同时提供了多个计划来源，或请求体不是合法 JSON。
- `409` `conflict`：该项目正在运行的 run 已达 `MAX_RUNS_PER_PROJECT`，响应 `details` 给出当前数量。
- `413` `payload_too_large`：请求体超限。

### GET /api/runs

列出执行记录（轻量视图 `RunSummary`，不含 `cases`/`steps` 详情）。

查询参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `projectId` | string | 可选，按项目过滤 |
| `status` | string | 可选，逗号分隔多值，如 `status=running,failed` |
| `page` / `pageSize` | number | 见 1.1 |

响应 `200`（按 `createdAt` 倒序）：

```json
{
  "items": [
    {
      "id": "run_4c8e02",
      "projectId": "prj_7f3c1a",
      "status": "failed",
      "planId": "plan_9b2d17",
      "planTitle": "登录并进入控制台",
      "trigger": "api",
      "createdAt": "2026-11-01T08:30:00.000Z",
      "startedAt": "2026-11-01T08:30:01.000Z",
      "finishedAt": "2026-11-01T08:30:42.000Z",
      "durationMs": 41000,
      "failureKind": "element_not_found",
      "totals": {
        "cases": 1,
        "passed": 0,
        "failed": 1,
        "skipped": 0
      }
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

错误：`400`（`status` 含未知枚举值、分页参数非法）、`500`。

### GET /api/runs/:id

run 的完整详情，包含 `planSnapshot`、所有 `cases` 与嵌套 `steps`、`artifacts`。

响应 `200`：

```json
{
  "id": "run_4c8e02",
  "projectId": "prj_7f3c1a",
  "status": "failed",
  "planId": "plan_9b2d17",
  "planSnapshot": {
    "id": "plan_9b2d17",
    "projectId": "prj_7f3c1a",
    "title": "登录并进入控制台",
    "summary": "验证账号密码登录后能跳到控制台首页",
    "baseUrl": null,
    "steps": [],
    "createdAt": "2026-10-28T06:00:00.000Z",
    "updatedAt": "2026-10-28T06:00:00.000Z"
  },
  "trigger": "api",
  "createdAt": "2026-11-01T08:30:00.000Z",
  "startedAt": "2026-11-01T08:30:01.000Z",
  "finishedAt": "2026-11-01T08:30:42.000Z",
  "durationMs": 41000,
  "failureKind": "element_not_found",
  "error": null,
  "cases": [
    {
      "caseId": "case_login",
      "planId": "plan_9b2d17",
      "title": "登录并进入控制台",
      "status": "failed",
      "startedAt": "2026-11-01T08:30:01.000Z",
      "finishedAt": "2026-11-01T08:30:42.000Z",
      "durationMs": 41000,
      "failureKind": "element_not_found",
      "error": "第 3 步未找到元素 button[type=submit]",
      "steps": [
        {
          "stepId": "step_1",
          "order": 0,
          "description": "打开登录页",
          "action": "goto",
          "status": "passed",
          "startedAt": "2026-11-01T08:30:01.000Z",
          "finishedAt": "2026-11-01T08:30:02.500Z",
          "durationMs": 1500,
          "failureKind": null,
          "error": null,
          "artifacts": []
        },
        {
          "stepId": "step_3",
          "order": 2,
          "description": "点击登录",
          "action": "click",
          "status": "failed",
          "startedAt": "2026-11-01T08:30:03.000Z",
          "finishedAt": "2026-11-01T08:30:41.000Z",
          "durationMs": 38000,
          "failureKind": "element_not_found",
          "error": "等待 38000ms 后仍未出现 button[type=submit]",
          "artifacts": [
            {
              "id": "art_1f0b93",
              "runId": "run_4c8e02",
              "caseId": "case_login",
              "stepId": "step_3",
              "kind": "screenshot",
              "path": "run_4c8e02/case_login/step_3.png",
              "url": "/api/runs/run_4c8e02/artifacts/art_1f0b93",
              "contentType": "image/png",
              "bytes": 184320,
              "createdAt": "2026-11-01T08:30:41.000Z"
            }
          ]
        }
      ],
      "artifacts": []
    }
  ]
}
```

错误：`404`（run 不存在）、`500`。

### GET /api/runs/:id/events

run 的事件流，`text/event-stream`（SSE）。

- 连接后先补发历史事件（`id` 单调递增），再持续推送新事件；
- `Last-Event-ID` 请求头用于断线重连，从该 id 之后续传；
- 每 15 秒发一次 `heartbeat`，避免代理超时；
- run 进入终态后服务端发送 `run.finished` 并关闭连接；
- 客户端可带 `Accept: text/event-stream`；不支持 SSE 的客户端可退化为轮询 `GET /api/runs/:id`。

示例流：

```
id: 1
event: run.started
data: {"id":"1","runId":"run_4c8e02","type":"run.started","at":"2026-11-01T08:30:01.000Z","caseId":null,"stepId":null,"message":"开始执行 run_4c8e02","data":{}}

id: 2
event: case.started
data: {"id":"2","runId":"run_4c8e02","type":"case.started","at":"2026-11-01T08:30:01.100Z","caseId":"case_login","stepId":null,"message":"开始用例：登录并进入控制台","data":{}}

id: 3
event: step.finished
data: {"id":"3","runId":"run_4c8e02","type":"step.finished","at":"2026-11-01T08:30:02.500Z","caseId":"case_login","stepId":"step_1","message":"第 1 步通过：打开登录页","data":{"status":"passed","durationMs":1500}}

id: 4
event: run.finished
data: {"id":"4","runId":"run_4c8e02","type":"run.finished","at":"2026-11-01T08:30:42.000Z","caseId":null,"stepId":null,"message":"执行失败：element_not_found","data":{"status":"failed","failureKind":"element_not_found"}}

```

注释行 `: keep-alive` 用于心跳（`type: heartbeat` 的事件体同样会出现，客户端可忽略）。

错误：`404`（run 不存在，此时返回 JSON 错误体而不是事件流）、`500`。

### POST /api/runs/:id/cancel

请求取消一个进行中的 run。幂等：对已是 `cancelled` 的 run 再次调用返回 `200` 及当前状态。

请求体：无（空 body 或 `{}`）。

响应 `200`：

```json
{
  "id": "run_4c8e02",
  "status": "cancelled",
  "finishedAt": "2026-11-01T08:30:20.000Z",
  "cancelledAt": "2026-11-01T08:30:20.000Z"
}
```

> `cancelledAt` 是取消动作的时间；执行器可能在几百毫秒内把状态从 `running` 收敛到 `cancelled`，客户端应以随后 `GET /api/runs/:id` 的 `status` 为准。

错误：

- `404` `not_found`：run 不存在。
- `409` `run_not_cancellable`：run 已处于终态（如 `passed`/`failed`），响应体：

```json
{
  "error": {
    "code": "run_not_cancellable",
    "message": "run_4c8e02 已是终态 failed，无法取消",
    "details": null
  }
}
```

---

## 4. 后续预留（本期不实现）

以下路径在后续 issue 中补齐，先在此登记以免命名冲突：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/projects/:id` | 单个项目详情 |
| `PATCH` | `/api/projects/:id` | 更新项目 |
| `DELETE` | `/api/projects/:id` | 删除项目 |
| `GET` | `/api/projects/:id/plans` | 项目下的计划列表 |
| `POST` | `/api/projects/:id/plans` | 新建计划 |
| `GET` | `/api/runs/:id/artifacts/:artifactId` | 下载产物 |

## 5. 环境变量影响

| 变量 | 影响 |
| --- | --- |
| `RUN_TIMEOUT_MS` | 单次 run 的总超时，超时后状态置 `timed_out`，`failureKind=timeout` |
| `MAX_RUNS_PER_PROJECT` | 单项目并发 run 上限，超限 `POST /api/runs` 返回 `409` |
| `ARTIFACT_DIR` | `Artifact.path` 的根目录 |
| `LLM_*` | `POST /api/runs` 只给 `intent` 时生成计划所用的模型 |

取值范围与默认值见 [`.env.example`](../.env.example) 与 [`docs/dev-setup.md`](./dev-setup.md)。

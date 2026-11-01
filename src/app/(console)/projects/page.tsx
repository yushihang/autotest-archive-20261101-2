"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import type { Project } from "@/lib/domain";

import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { Pagination } from "@/components/pagination";
import { CardsSkeleton } from "@/components/skeleton";
import { createProject, errorMessage, isApiError, listProjects } from "@/lib/api-client";
import { formatDateTime } from "@/lib/format";

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-400 focus:border-slate-500 focus:ring-2 focus:ring-slate-200";
const LABEL_CLASS = "text-xs font-medium text-slate-700";

interface FormState {
  name: string;
  baseUrl: string;
  defaultStepTimeoutMs: string;
  scope: string;
  exclusions: string;
  credentials: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  baseUrl: "",
  defaultStepTimeoutMs: "15000",
  scope: "",
  exclusions: "",
  credentials: "",
  notes: "",
};

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 契约里项目只有 `description` 一个自由文本字段，
 * 所以把“范围 / 排除 / 凭据说明 / 备注”按固定前缀写进描述，列表里原样展示。
 */
function composeDescription(form: FormState): string | null {
  const lines: string[] = [];
  const add = (label: string, value: string) => {
    const trimmed = value.trim();
    if (trimmed) lines.push(`${label}：${trimmed}`);
  };

  add("范围", form.scope);
  add("排除", form.exclusions);
  add("凭据说明", form.credentials);
  add("备注", form.notes);

  return lines.length > 0 ? lines.join("\n") : null;
}

function FieldErrors({ id, messages }: { id: string; messages?: string[] }) {
  if (!messages || messages.length === 0) return null;
  return (
    <p id={id} className="mt-1 text-xs text-rose-600">
      {messages.join("；")}
    </p>
  );
}

function ProjectForm({ onCreated }: { onCreated: (project: Project) => void }) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const updateField = useCallback((field: keyof FormState, value: string) => {
    setForm((current) => {
      const next: FormState = { ...current };
      next[field] = value;
      return next;
    });
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setFormError(null);
      setSuccess(null);

      const name = form.name.trim();
      const baseUrl = form.baseUrl.trim();
      const description = composeDescription(form);
      const defaultStepTimeoutMs = Number(form.defaultStepTimeoutMs);
      const nextErrors: Record<string, string[]> = {};

      if (name.length === 0) {
        nextErrors.name = ["名称不能为空"];
      } else if (name.length > 64) {
        nextErrors.name = ["名称不能超过 64 个字符"];
      }

      if (baseUrl.length === 0) {
        nextErrors.baseUrl = ["目标 URL 不能为空"];
      } else if (baseUrl.length > 2048) {
        nextErrors.baseUrl = ["目标 URL 不能超过 2048 个字符"];
      } else if (!isValidHttpUrl(baseUrl)) {
        nextErrors.baseUrl = ["必须是合法的 http(s) URL"];
      }

      if (
        !Number.isFinite(defaultStepTimeoutMs) ||
        defaultStepTimeoutMs < 1000 ||
        defaultStepTimeoutMs > 120000
      ) {
        nextErrors.defaultStepTimeoutMs = ["单步超时需在 1000–120000 ms 之间"];
      }

      if (description && description.length > 500) {
        nextErrors.description = ["范围 / 排除 / 凭据说明 / 备注合计不能超过 500 个字符"];
      }

      if (Object.keys(nextErrors).length > 0) {
        setFieldErrors(nextErrors);
        return;
      }

      setFieldErrors({});
      setSubmitting(true);
      try {
        const project = await createProject({
          name,
          baseUrl,
          description,
          defaultStepTimeoutMs,
        });
        setForm(EMPTY_FORM);
        setSuccess(`已创建项目「${project.name}」`);
        onCreated(project);
      } catch (error) {
        if (isApiError(error)) {
          setFieldErrors(error.details ?? {});
          setFormError(error.message);
        } else {
          setFormError(errorMessage(error));
        }
      } finally {
        setSubmitting(false);
      }
    },
    [form, onCreated],
  );

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-3">
      <div>
        <label htmlFor="project-name" className={LABEL_CLASS}>
          名称 <span className="text-rose-500">*</span>
        </label>
        <input
          id="project-name"
          value={form.name}
          onChange={(event) => updateField("name", event.target.value)}
          placeholder="例如：官网"
          maxLength={64}
          autoComplete="off"
          aria-invalid={Boolean(fieldErrors.name)}
          aria-describedby={fieldErrors.name ? "project-name-error" : undefined}
          className={INPUT_CLASS}
        />
        <FieldErrors id="project-name-error" messages={fieldErrors.name} />
      </div>

      <div>
        <label htmlFor="project-base-url" className={LABEL_CLASS}>
          目标 URL <span className="text-rose-500">*</span>
        </label>
        <input
          id="project-base-url"
          value={form.baseUrl}
          onChange={(event) => updateField("baseUrl", event.target.value)}
          placeholder="https://staging.example.com"
          inputMode="url"
          maxLength={2048}
          autoComplete="off"
          aria-invalid={Boolean(fieldErrors.baseUrl)}
          aria-describedby={fieldErrors.baseUrl ? "project-base-url-error" : undefined}
          className={`${INPUT_CLASS} font-mono`}
        />
        <FieldErrors id="project-base-url-error" messages={fieldErrors.baseUrl} />
      </div>

      <div>
        <label htmlFor="project-timeout" className={LABEL_CLASS}>
          单步默认超时（ms）
        </label>
        <input
          id="project-timeout"
          type="number"
          min={1000}
          max={120000}
          step={500}
          value={form.defaultStepTimeoutMs}
          onChange={(event) => updateField("defaultStepTimeoutMs", event.target.value)}
          aria-invalid={Boolean(fieldErrors.defaultStepTimeoutMs)}
          aria-describedby={
            fieldErrors.defaultStepTimeoutMs ? "project-timeout-error" : "project-timeout-hint"
          }
          className={INPUT_CLASS}
        />
        <p id="project-timeout-hint" className="mt-1 text-[11px] text-slate-400">
          1000–120000，默认 15000。
        </p>
        <FieldErrors id="project-timeout-error" messages={fieldErrors.defaultStepTimeoutMs} />
      </div>

      <div>
        <label htmlFor="project-scope" className={LABEL_CLASS}>
          范围规则
        </label>
        <textarea
          id="project-scope"
          value={form.scope}
          onChange={(event) => updateField("scope", event.target.value)}
          placeholder="只测 /login 与 /console；使用 staging 数据"
          rows={2}
          className={INPUT_CLASS}
        />
      </div>

      <div>
        <label htmlFor="project-exclusions" className={LABEL_CLASS}>
          排除规则
        </label>
        <textarea
          id="project-exclusions"
          value={form.exclusions}
          onChange={(event) => updateField("exclusions", event.target.value)}
          placeholder="不触发真实支付；跳过第三方登录"
          rows={2}
          className={INPUT_CLASS}
        />
      </div>

      <div>
        <label htmlFor="project-credentials" className={LABEL_CLASS}>
          凭据说明
        </label>
        <textarea
          id="project-credentials"
          value={form.credentials}
          onChange={(event) => updateField("credentials", event.target.value)}
          placeholder="测试账号 demo / demo，仅限 staging；不要写真实密码"
          rows={2}
          className={INPUT_CLASS}
        />
      </div>

      <div>
        <label htmlFor="project-notes" className={LABEL_CLASS}>
          备注
        </label>
        <textarea
          id="project-notes"
          value={form.notes}
          onChange={(event) => updateField("notes", event.target.value)}
          placeholder="其他需要团队知道的信息"
          rows={2}
          className={INPUT_CLASS}
        />
        <p className="mt-1 text-[11px] text-slate-400">
          契约里项目只有 description 一个自由字段，以上内容会按「范围：/ 排除：/ 凭据说明：/ 备注：」写入项目描述。
        </p>
        <FieldErrors id="project-description-error" messages={fieldErrors.description} />
      </div>

      {formError ? (
        <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {formError}
        </p>
      ) : null}

      {success ? (
        <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          {success}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={submitting}
        className="mt-1 inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "创建中…" : "创建项目"}
      </button>
    </form>
  );
}

function ProjectCard({ project }: { project: Project }) {
  return (
    <li className="flex flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-slate-900">{project.name}</h3>
          <a
            href={project.baseUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-0.5 block truncate font-mono text-xs text-sky-700 hover:underline"
            title={project.baseUrl}
          >
            {project.baseUrl}
          </a>
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
          {project.defaultStepTimeoutMs} ms/步
        </span>
      </div>

      {project.description ? (
        <p className="mt-2 whitespace-pre-line break-words text-xs leading-relaxed text-slate-600">
          {project.description}
        </p>
      ) : (
        <p className="mt-2 text-xs text-slate-400">没有填写说明。</p>
      )}

      <dl className="mt-auto flex flex-wrap gap-x-4 gap-y-1 pt-3 text-[11px] text-slate-400">
        <div className="flex gap-1">
          <dt>创建</dt>
          <dd>{formatDateTime(project.createdAt)}</dd>
        </div>
        <div className="flex gap-1">
          <dt>更新</dt>
          <dd>{formatDateTime(project.updatedAt)}</dd>
        </div>
        <div className="flex gap-1">
          <dt>ID</dt>
          <dd className="font-mono">{project.id}</dd>
        </div>
      </dl>
    </li>
  );
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    setLoading(true);
    setError(null);

    listProjects({ page, pageSize: PAGE_SIZE, q: query || undefined, signal: controller.signal })
      .then((data) => {
        if (!active) return;
        setProjects(data.items);
        setTotal(data.total);
      })
      .catch((err: unknown) => {
        if (!active || controller.signal.aborted) return;
        setProjects([]);
        setTotal(0);
        setError(errorMessage(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [page, query, reloadKey]);

  const handleCreated = useCallback(() => {
    setPage(1);
    setReloadKey((key) => key + 1);
  }, []);

  const retry = useCallback(() => setReloadKey((key) => key + 1), []);

  const showEmpty = !loading && !error && projects.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">项目</h1>
          <p className="mt-1 text-sm text-slate-600">
            登记被测站点与默认超时，并写清测试范围、排除规则与凭据使用方式。
          </p>
        </div>
        <span className="text-xs text-slate-500">共 {total} 个项目</span>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:items-start">
        <section aria-labelledby="project-list-heading" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="project-list-heading" className="text-sm font-semibold text-slate-900">
              全部项目
            </h2>
            <div className="flex items-center gap-2">
              <label htmlFor="project-search" className="sr-only">
                按名称搜索
              </label>
              <input
                id="project-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="按名称搜索…"
                className="w-48 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 shadow-sm outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
              />
              <button
                type="button"
                onClick={retry}
                disabled={loading}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                刷新
              </button>
            </div>
          </div>

          {loading ? (
            <CardsSkeleton />
          ) : error ? (
            <ErrorState title="项目列表加载失败" message={error} onRetry={retry} />
          ) : showEmpty ? (
            <EmptyState
              title={query ? "没有匹配的项目" : "还没有项目"}
              description={
                query
                  ? "换个关键词，或者清空搜索条件。"
                  : "先在右侧创建一个项目，之后就可以在项目下发起运行。"
              }
              action={
                query ? (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
                  >
                    清空搜索
                  </button>
                ) : undefined
              }
            />
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2">
              {projects.map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
            </ul>
          )}

          {!loading && !error ? (
            <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
          ) : null}
        </section>

        <section
          aria-labelledby="new-project-heading"
          className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm lg:sticky lg:top-6"
        >
          <h2 id="new-project-heading" className="text-sm font-semibold text-slate-900">
            新建项目
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            名称与目标 URL 必填；范围、排除与凭据说明帮助后续生成计划时避开危险操作。
          </p>
          <div className="mt-4">
            <ProjectForm onCreated={handleCreated} />
          </div>
        </section>
      </div>
    </div>
  );
}

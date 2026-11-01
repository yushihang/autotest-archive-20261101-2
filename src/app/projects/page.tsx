import Link from "next/link";

/**
 * 占位页面：/projects 的真实列表在后续 issue 里实现。
 * 现在只保证落地页的入口不是死链，并明确告知数据层尚未接入。
 */
export default function ProjectsPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-16">
      <Link href="/" className="text-sm text-slate-500 hover:text-slate-900">
        ← 返回首页
      </Link>
      <h1 className="text-3xl font-semibold tracking-tight text-slate-900">项目</h1>
      <p className="text-slate-600">
        项目列表与创建表单尚未实现。数据模型见{" "}
        <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-xs">
          src/lib/domain/types.ts
        </code>
        ，接口契约见{" "}
        <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-xs">docs/api-contract.md</code>。
      </p>
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
        还没有项目
      </div>
    </main>
  );
}

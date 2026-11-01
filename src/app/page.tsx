import Link from "next/link";

const highlights = [
  {
    title: "描述需求，而不是写选择器",
    body: "用一句话说明要验证什么，autotest 把它拆成有序的测试步骤，每一步都有可读的动作与断言。",
  },
  {
    title: "真实浏览器里跑",
    body: "每一步都在被测站点上真实执行，截图、日志与失败信息随步骤一起落盘，失败即证据。",
  },
  {
    title: "结果可追溯、可复现",
    body: "每次执行都有稳定的 run id、状态流转与事件流，失败归类到具体原因，而不是一句“挂了”。",
  },
];

const flow = [
  { step: "01", label: "建项目", detail: "登记被测站点入口与默认超时。" },
  { step: "02", label: "跑计划", detail: "发起一次 run，等待执行，随时取消。" },
  { step: "03", label: "看报告", detail: "按用例与步骤展开失败原因与证据。" },
];

const upcoming = [
  "项目与测试计划的增删改查",
  "LLM 生成测试步骤",
  "Playwright 执行器与产物存储",
  "执行事件流与实时进度",
];

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-16 px-6 py-16 sm:py-24">
      <header className="flex flex-col gap-6">
        <span className="inline-flex w-fit items-center rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium tracking-wide text-slate-600">
          autotest · 端到端测试工作台
        </span>
        <h1 className="text-4xl font-semibold leading-tight tracking-tight text-slate-900 sm:text-5xl">
          把“这里应该能用”
          <br />
          变成一次可复现的执行。
        </h1>
        <p className="max-w-2xl text-lg leading-relaxed text-slate-600">
          autotest 接收一段自然语言的测试意图，生成结构化的测试计划，在真实浏览器里逐步执行，并把每一步的结果、失败归类与截图证据整理成报告。它替代的是“手动点一遍再看看”的那种验证。
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/projects"
            className="inline-flex items-center rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-700"
          >
            进入项目列表
          </Link>
          <span className="inline-flex items-center rounded-lg border border-slate-300 px-5 py-2.5 text-sm font-medium text-slate-500">
            执行器与报告：开发中
          </span>
        </div>
        <p className="text-sm text-slate-500">
          当前处于骨架阶段：只提供页面基座与 REST 契约，业务接口尚未实现。契约定稿见{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-xs">docs/api-contract.md</code>。
        </p>
      </header>

      <section aria-labelledby="highlights" className="flex flex-col gap-6">
        <h2 id="highlights" className="text-sm font-semibold uppercase tracking-widest text-slate-500">
          它解决什么
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {highlights.map((item) => (
            <article
              key={item.title}
              className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
            >
              <h3 className="text-base font-semibold text-slate-900">{item.title}</h3>
              <p className="text-sm leading-relaxed text-slate-600">{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="flow" className="flex flex-col gap-6">
        <h2 id="flow" className="text-sm font-semibold uppercase tracking-widest text-slate-500">
          一次使用的形状
        </h2>
        <ol className="grid gap-4 sm:grid-cols-3">
          {flow.map((item) => (
            <li
              key={item.step}
              className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-5"
            >
              <span className="text-xs font-mono text-slate-400">{item.step}</span>
              <span className="text-base font-semibold text-slate-900">{item.label}</span>
              <span className="text-sm leading-relaxed text-slate-600">{item.detail}</span>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="upcoming" className="flex flex-col gap-4">
        <h2 id="upcoming" className="text-sm font-semibold uppercase tracking-widest text-slate-500">
          接下来
        </h2>
        <ul className="grid gap-2 text-sm text-slate-600 sm:grid-cols-2">
          {upcoming.map((item) => (
            <li key={item} className="flex items-start gap-2">
              <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="border-t border-slate-200 pt-6 text-xs text-slate-500">
        autotest · 本地开发说明见 <code className="rounded bg-slate-200/70 px-1.5 py-0.5">docs/dev-setup.md</code>
      </footer>
    </main>
  );
}

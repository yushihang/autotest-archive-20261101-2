import type { Artifact } from "@/lib/domain";

import { formatBytes } from "@/lib/format";
import { artifactKindLabel } from "@/lib/labels";

/**
 * 证据链接列表。
 *
 * 契约里截图与 trace 都走 `Artifact.url`（当前为 `/api/runs/:id/artifacts/:artifactId`）；
 * `url` 为 `null` 时仍然显示产物类型与原始路径，避免“有证据但看不到”。
 */
export function ArtifactLinks({ artifacts }: { artifacts: Artifact[] }) {
  if (artifacts.length === 0) {
    return <span className="text-xs text-slate-400">无</span>;
  }

  return (
    <ul className="flex flex-wrap items-center gap-1.5">
      {artifacts.map((artifact) => {
        const label = artifactKindLabel(artifact.kind);
        const tooltip = `${artifact.path}（${formatBytes(artifact.bytes)}）`;

        return (
          <li key={artifact.id}>
            {artifact.url ? (
              <a
                href={artifact.url}
                target="_blank"
                rel="noreferrer"
                title={tooltip}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-sky-700 transition-colors hover:border-sky-300 hover:bg-sky-50"
              >
                {label}
                <span aria-hidden className="text-[10px] text-slate-400">
                  ↗
                </span>
              </a>
            ) : (
              <span
                title={tooltip}
                className="inline-flex max-w-[260px] items-center gap-1 rounded-md border border-dashed border-slate-200 px-2 py-1 text-xs text-slate-400"
              >
                <span className="truncate">
                  {label}（{artifact.path}）
                </span>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 控制台里的展示格式化工具。
 *
 * 时间统一按 Asia/Shanghai 渲染，服务端与浏览器输出的字符串一致，避免 hydration 不一致。
 */

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function toDate(value: string | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** ISO 时间 → `2026-11-01 16:30:00`；缺失或非法时返回 `—` / 原值。 */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = toDate(value);
  if (!date) return value;
  return DATE_TIME_FORMATTER.format(date).replace(/\//g, "-");
}

/** 只显示时分秒，用于“最后更新于”。 */
export function formatTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = toDate(value);
  if (!date) return typeof value === "string" ? value : "—";
  return TIME_FORMATTER.format(date);
}

/** 毫秒 → 人类可读耗时；缺失时为 `—`。 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;

  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;

  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const rest = totalSeconds % 60;
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}

/** 通过率整数百分比；没有用例时显示 `—`。 */
export function formatPassRate(passed: number, total: number): string {
  if (!Number.isFinite(passed) || !Number.isFinite(total) || total <= 0) return "—";
  return `${Math.round((passed / total) * 100)}%`;
}

/** 文件大小，产物列表里偶尔用得上。 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

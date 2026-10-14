const beijingDateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

const relativeFormatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });

const RELATIVE_UNITS: Array<{ limitSeconds: number; unit: Intl.RelativeTimeFormatUnit; seconds: number }> = [
  { limitSeconds: 60 * 60, unit: 'minute', seconds: 60 },
  { limitSeconds: 60 * 60 * 24, unit: 'hour', seconds: 60 * 60 },
  { limitSeconds: 60 * 60 * 24 * 30, unit: 'day', seconds: 60 * 60 * 24 }
];

/** Separator used by the formatters below; a plain character avoids escapes. */
const DASH = String.fromCharCode(45);

/** `YYYY-MM-DD HH:mm` in Asia/Shanghai. Ported from the legacy `format-time.ts`. */
export function formatBeijingDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const lookup = new Map<string, string>();
  for (const part of beijingDateTimeFormatter.formatToParts(date)) {
    lookup.set(part.type, part.value);
  }
  let hour = lookup.get('hour') ?? '';
  // Some ICU builds still return "24" for hour12: false.
  if (hour === '24') {
    hour = '00';
  }
  const day = [lookup.get('year') ?? '', lookup.get('month') ?? '', lookup.get('day') ?? ''].join(DASH);
  return `${day} ${hour}:${lookup.get('minute') ?? ''}`;
}

/** Compact relative label for list metadata ("3 天前"). Falls back to a date. */
export function formatRelativeBeijing(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const deltaSeconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const magnitude = Math.abs(deltaSeconds);
  if (magnitude < 60) {
    return '刚刚';
  }
  for (const entry of RELATIVE_UNITS) {
    if (magnitude < entry.limitSeconds) {
      return relativeFormatter.format(Math.round(deltaSeconds / entry.seconds), entry.unit);
    }
  }
  return formatBeijingDateTime(iso);
}

/** Groups digits for counts so list columns do not jitter. */
export function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = unitIndex === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex] ?? 'B'}`;
}

export function formatDurationMs(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return '—';
  }
  if (milliseconds < 1000) {
    return `${Math.round(milliseconds)} ms`;
  }
  const totalSeconds = Math.round(milliseconds / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

/** Middle-truncates paths so both the root and the leaf stay readable. */
export function truncateMiddle(value: string, maxLength = 48): string {
  if (value.length <= maxLength) {
    return value;
  }
  const head = Math.ceil((maxLength - 1) / 2);
  const tail = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

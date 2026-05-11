const beijingDateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

export function formatBeijingDateTime(iso: string): string {
  const date = new Date(iso);
  const parts = beijingDateTimeFormatter.formatToParts(date);
  const lookup = new Map<string, string>();
  for (const part of parts) {
    lookup.set(part.type, part.value);
  }
  const year = lookup.get('year') ?? '';
  const month = lookup.get('month') ?? '';
  const day = lookup.get('day') ?? '';
  let hour = lookup.get('hour') ?? '';
  const minute = lookup.get('minute') ?? '';
  // Intl 的 hour12: false 在部分 ICU 实现下仍可能返回 "24"，统一为 "00"
  if (hour === '24') {
    hour = '00';
  }
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

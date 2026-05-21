import { RocDomainError } from '../errors';

export type ParsedCronExpression = {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
};

type CronField = {
  name: string;
  min: number;
  max: number;
};

const fields: CronField[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day_of_month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day_of_week', min: 0, max: 7 }
];

export function parseCronExpression(expression: string): ParsedCronExpression {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw invalidCron();
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (
    minute === undefined ||
    hour === undefined ||
    dayOfMonth === undefined ||
    month === undefined ||
    dayOfWeek === undefined
  ) {
    throw invalidCron();
  }

  const parsedDayOfWeek = parseField(dayOfWeek, fields[4]!, true);
  return {
    minutes: parseField(minute, fields[0]!, false),
    hours: parseField(hour, fields[1]!, false),
    daysOfMonth: parseField(dayOfMonth, fields[2]!, false),
    months: parseField(month, fields[3]!, false),
    daysOfWeek: new Set([...parsedDayOfWeek].map((value) => (value === 7 ? 0 : value)))
  };
}

export function computeNextCronRunAt(expression: string, after: Date = new Date()): string {
  const parsed = parseCronExpression(expression);
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxMinutesToScan = 366 * 24 * 60;
  for (let offset = 0; offset < maxMinutesToScan; offset += 1) {
    if (matches(parsed, candidate)) {
      return candidate.toISOString();
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw invalidCron();
}

function parseField(raw: string, field: CronField, allowSevenForSunday: boolean): Set<number> {
  const values = new Set<number>();
  for (const segment of raw.split(',')) {
    addSegment(values, segment, field, allowSevenForSunday);
  }
  if (values.size === 0) {
    throw invalidCron();
  }
  return values;
}

function addSegment(values: Set<number>, segment: string, field: CronField, allowSevenForSunday: boolean): void {
  if (segment.length === 0) {
    throw invalidCron();
  }

  const [rangePart, stepPart] = segment.split('/');
  if (rangePart === undefined || segment.split('/').length > 2) {
    throw invalidCron();
  }
  const step = stepPart === undefined ? 1 : parseNumber(stepPart, field, allowSevenForSunday);
  if (step <= 0) {
    throw invalidCron();
  }

  const range = parseRange(rangePart, field, allowSevenForSunday);
  for (let value = range.start; value <= range.end; value += step) {
    values.add(value);
  }
}

function parseRange(raw: string, field: CronField, allowSevenForSunday: boolean): { start: number; end: number } {
  if (raw === '*') {
    return { start: field.min, end: field.max };
  }

  const pieces = raw.split('-');
  if (pieces.length === 1) {
    const value = parseNumber(raw, field, allowSevenForSunday);
    return { start: value, end: value };
  }
  if (pieces.length !== 2 || pieces[0] === undefined || pieces[1] === undefined) {
    throw invalidCron();
  }

  const start = parseNumber(pieces[0], field, allowSevenForSunday);
  const end = parseNumber(pieces[1], field, allowSevenForSunday);
  if (start > end) {
    throw invalidCron();
  }
  return { start, end };
}

function parseNumber(raw: string, field: CronField, allowSevenForSunday: boolean): number {
  if (!/^\d+$/.test(raw)) {
    throw invalidCron();
  }
  const value = Number.parseInt(raw, 10);
  const max = allowSevenForSunday ? 7 : field.max;
  if (value < field.min || value > max) {
    throw invalidCron();
  }
  return value;
}

function matches(parsed: ParsedCronExpression, date: Date): boolean {
  return (
    parsed.minutes.has(date.getMinutes()) &&
    parsed.hours.has(date.getHours()) &&
    parsed.daysOfMonth.has(date.getDate()) &&
    parsed.months.has(date.getMonth() + 1) &&
    parsed.daysOfWeek.has(date.getDay())
  );
}

function invalidCron(): RocDomainError {
  return new RocDomainError({
    code: 'background_task_cron_invalid',
    message: 'Cron 表达式无效。',
    category: 'validation',
    retryable: true,
    userAction: '请使用五段标准 cron 表达式，例如 0 9 * * *。'
  });
}


export function sanitizeTestId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, '-');
}

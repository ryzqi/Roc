export function gitErrorLabel(error: string | null): string {
  if (error === null) {
    return '未选择工作区';
  }
  return error;
}

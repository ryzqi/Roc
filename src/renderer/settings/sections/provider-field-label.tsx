import type React from 'react';

/** 字段标题：中文主标签 + 右侧英文 API 原名小字，便于对照供应商官方文档。 */
export function FieldLabel({ apiName, text }: { apiName?: string; text: string }): React.JSX.Element {
  return <span className="field-label">{text}{apiName === undefined ? null : <code className="field-api-name">{apiName}</code>}</span>;
}

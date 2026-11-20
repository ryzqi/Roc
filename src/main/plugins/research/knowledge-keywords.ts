/** Han tokenization: Han characters are positional tokens; a quoted sequence preserves substring order. */
export function keywordTextV1(text: string): string {
  return text.replace(/\p{Script=Han}+/gu, run=>` ${Array.from(run).join(' ')} `);
}
export function keywordQueryV1(query: string): string {
  return (query.match(/\p{Script=Han}+|[^\s\p{Script=Han}]+/gu) ?? [])
    .map(term=>keywordTextV1(term.replace(/"/gu,'')).trim()).filter(Boolean).map(term=>`"${term}"`).join(' OR ');
}

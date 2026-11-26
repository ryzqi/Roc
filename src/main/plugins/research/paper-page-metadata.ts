import { Parser } from 'htmlparser2';

export function readPaperPageMetadata(html: string): Map<string, string[]> {
  const metadata = new Map<string, string[]>();
  const parser = new Parser({
    onopentag(name, attrs) {
      if (name !== 'meta' || !attrs.content) return;
      const key = (attrs.name ?? attrs.property ?? '').toLowerCase();
      if (!key.startsWith('citation_') && key !== 'og:url') return;
      const values = metadata.get(key);
      if (values === undefined) metadata.set(key, [attrs.content]);
      else values.push(attrs.content);
    }
  }, {decodeEntities: true});
  parser.end(html);
  return metadata;
}

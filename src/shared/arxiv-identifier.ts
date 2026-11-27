export function normalizeResearchArxiv(value: string): {id: string; version: number | null} {
  let identifier = value.trim().replace(/^arxiv:\s*/iu, '');
  if (/^https?:\/\//iu.test(identifier)) {
    let url: URL;
    try { url = new URL(identifier); } catch (cause) { throw new Error('research_arxiv_identifier_invalid', {cause}); }
    if (!['arxiv.org', 'www.arxiv.org'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.search || url.hash ||
        !url.pathname.startsWith('/abs/')) throw new Error('research_arxiv_identifier_invalid');
    identifier = url.pathname.slice(5);
  }
  const match = /^(?<id>(?:\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}|[a-z][a-z-]*(?:\.[a-z]{2})?\/\d{2}(?:0[1-9]|1[0-2])\d{3}))(?:(?:v)(?<version>[1-9]\d*))?$/iu.exec(identifier);
  if (match?.groups === undefined) throw new Error('research_arxiv_identifier_invalid');
  const version = match.groups.version === undefined ? null : Number(match.groups.version);
  if (version !== null && !Number.isSafeInteger(version)) throw new Error('research_arxiv_identifier_invalid');
  const id = match.groups.id;
  if (id.includes('/')) {
    const [archive, number] = id.split('/');
    const [group, subject] = archive.split('.');
    const month = Number(number.slice(0, 4));
    if (!(month >= 9107 || month <= 703) || Number(number.slice(4)) === 0) throw new Error('research_arxiv_identifier_invalid');
    return {id: `${group.toLowerCase()}${subject === undefined ? '' : `.${subject.toUpperCase()}`}/${number}`, version};
  }
  const [monthText, sequence] = id.split('.');
  const month = Number(monthText);
  if (month < 704 || sequence.length !== (month <= 1412 ? 4 : 5) || Number(sequence) === 0) {
    throw new Error('research_arxiv_identifier_invalid');
  }
  return {id, version};
}

/** Resolve a pasted arXiv identifier or an official article link to an exact API lookup. */
export function arxivQueryFromInput(input: string): string | null {
  let candidate = input.trim().replace(/^id:\s*/iu, '');
  if (/^https?:\/\//iu.test(candidate)) {
    const url = URL.parse(candidate);
    if (url === null || !['arxiv.org', 'www.arxiv.org'].includes(url.hostname) || url.port || url.username || url.password) return null;
    const path = /^\/(abs|pdf|html)\/(.+)$/u.exec(url.pathname);
    if (path === null) return null;
    candidate = path[1] === 'pdf' ? path[2].replace(/\.pdf$/iu, '') : path[2];
  }
  try {
    const {id, version} = normalizeResearchArxiv(candidate);
    // Legacy subject suffixes belong to the category, while arXiv resolves the archive and number.
    const archiveId = id.replace(/\.[A-Z]{2}(?=\/)/u, '');
    return version === null ? archiveId : `${archiveId}v${version}`;
  } catch {
    return null;
  }
}

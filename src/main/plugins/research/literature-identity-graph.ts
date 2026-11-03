import { literatureIdentity, literatureSourceIdentity } from './literature-identity';

type IdentityRecord = {doi: string | null; source: string; externalId: string};
export type LiteratureIdentityGroup = {
  identity: string; indexes: number[]; aliases: string[];
  conflicts: Array<{alias: string; doiIdentities: string[]}>;
};
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export function literatureStrongIdentities(record: IdentityRecord): string[] {
  return [...new Set([literatureIdentity(record), literatureSourceIdentity(record)])].sort(compare);
}

/**
 * A DOI-free observation joins a DOI only when its declared source identity has
 * exactly one observed DOI. Competing DOIs stay separate and retain their conflict.
 * Titles and citation counts do not establish an identity edge.
 */
export function groupLiteratureIdentities(records: readonly IdentityRecord[]): LiteratureIdentityGroup[] {
  const anchors = new Map<string, Set<string>>();
  for (const record of records) {
    if (record.doi === null) continue;
    const alias = literatureSourceIdentity(record);
    let identities = anchors.get(alias);
    if (identities === undefined) { identities = new Set(); anchors.set(alias, identities); }
    identities.add(literatureIdentity(record));
  }
  const groups = new Map<string, LiteratureIdentityGroup>();
  records.forEach((record, index) => {
    const alias = literatureSourceIdentity(record);
    const observed = anchors.get(alias);
    const identity = record.doi === null && observed?.size === 1 ? [...observed][0] : literatureIdentity(record);
    let group = groups.get(identity);
    if (group === undefined) {
      group = {identity, indexes: [], aliases: [], conflicts: []};
      groups.set(identity, group);
    }
    group.indexes.push(index);
    group.aliases.push(...literatureStrongIdentities(record));
  });
  for (const group of groups.values()) {
    group.aliases = [...new Set([group.identity, ...group.aliases])].sort(compare);
    for (const alias of group.aliases) {
      const identities = anchors.get(alias);
      if (identities !== undefined && identities.size > 1) group.conflicts.push({alias, doiIdentities: [...identities].sort(compare)});
    }
  }
  return [...groups.values()];
}

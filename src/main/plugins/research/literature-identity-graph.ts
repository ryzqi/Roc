import { literatureIdentity, literatureIdentityAliases, literatureSourceIdentity } from './literature-identity';
import type {LiteratureIdentifierObservation} from '../../../shared/schemas/literature-identifiers';

type IdentityRecord = {doi: string | null; source: string; externalId: string};
type ObservedIdentity = {record: IdentityRecord; identifiers: readonly LiteratureIdentifierObservation[]};
export type LiteratureIdentityGroup = {
  identity: string; indexes: number[]; aliases: string[];
  conflicts: Array<{alias: string; doiIdentities: string[]}>;
};
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const priority = (key: string): number => key.startsWith('pmid:') ? 0 : key.startsWith('arxiv:') ? 1 : 2;

export function literatureStrongIdentities(record: IdentityRecord): string[] {
  return [...new Set([literatureIdentity(record), literatureSourceIdentity(record)])].sort(compare);
}

/** Only uniquely anchored DOI-free components join a DOI; competing DOIs remain separate. */
export function groupLiteratureIdentities(observations: readonly ObservedIdentity[]): LiteratureIdentityGroup[] {
  const states = observations.map(({record, identifiers}) => {
    const source = literatureSourceIdentity(record);
    const dois = new Set(identifiers.filter(value => value.kind === 'doi').map(value => value.identity));
    if (record.doi !== null) dois.add(literatureIdentity(record));
    const anchor = record.doi !== null ? literatureIdentity(record) : dois.size === 1 ? [...dois][0] : null;
    const aliases = [...new Set([source, ...(anchor === null ? [] : literatureIdentityAliases(anchor)),
      ...(dois.size > 1 ? [] : identifiers.filter(value => value.kind !== 'doi').map(value => value.identity))])].sort(compare);
    return {source, dois, anchor, aliases};
  });
  const anchors = new Map<string, Set<string>>();
  for (const state of states) {
    if (state.anchor === null) continue;
    for (const alias of state.aliases.filter(value => !value.startsWith('doi:'))) {
      let values = anchors.get(alias);
      if (values === undefined) {values = new Set(); anchors.set(alias, values);}
      for (const doi of state.dois) values.add(doi);
    }
  }
  const parent = states.map((_value, index) => index);
  const root = (index: number): number => {
    while (parent[index] !== index) {parent[index] = parent[parent[index]]; index = parent[index];}
    return index;
  };
  const first = new Map<string, number>();
  states.forEach((state, index) => {
    if (state.anchor !== null) return;
    for (const alias of state.aliases) {
      const previous = first.get(alias);
      if (previous === undefined) first.set(alias, index);
      else parent[root(index)] = root(previous);
    }
  });
  const components = new Map<number, number[]>();
  states.forEach((state, index) => {
    if (state.anchor !== null) return;
    const key = root(index);
    const indexes = components.get(key);
    if (indexes === undefined) components.set(key, [index]); else indexes.push(index);
  });
  const identities = states.map(state => state.anchor);
  const ambiguous = new Map<number, {alias: string; doiIdentities: string[]}>();
  for (const indexes of components.values()) {
    const aliases = [...new Set(indexes.flatMap(index => states[index].aliases))];
    const dois = [...new Set(aliases.flatMap(alias => [...(anchors.get(alias) ?? [])]))].sort(compare);
    const fallback = aliases.sort((left, right) => priority(left) - priority(right) || compare(left, right))[0];
    for (const index of indexes) {
      identities[index] = dois.length === 1 ? dois[0] : fallback;
      if (dois.length > 1) ambiguous.set(index, {alias: states[index].source, doiIdentities: dois});
    }
  }
  const groups = new Map<string, LiteratureIdentityGroup>();
  states.forEach((state, index) => {
    const identity = identities[index]!;
    let group = groups.get(identity);
    if (group === undefined) {group = {identity, indexes: [], aliases: [], conflicts: []}; groups.set(identity, group);}
    group.indexes.push(index);
    group.aliases.push(...state.aliases);
    const conflict = ambiguous.get(index);
    if (conflict !== undefined) group.conflicts.push(conflict);
  });
  for (const group of groups.values()) {
    group.aliases = [...new Set([group.identity, ...group.aliases])].sort(compare);
    for (const alias of group.aliases) {
      const dois = anchors.get(alias);
      if (dois !== undefined && dois.size > 1) group.conflicts.push({alias, doiIdentities: [...dois].sort(compare)});
    }
    group.conflicts = [...new Map(group.conflicts.map(conflict => [JSON.stringify(conflict), conflict])).values()]
      .sort((left, right) => compare(left.alias, right.alias));
  }
  return [...groups.values()];
}

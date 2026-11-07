import {z} from 'zod';

export const researchCitationStyleSchema = z.enum(['apa', 'ieee', 'gb-t-7714', 'nature', 'ama', 'chicago-author-date']);
export type ResearchCitationStyle = z.infer<typeof researchCitationStyleSchema>;
export const researchCitationStyles: Readonly<Record<ResearchCitationStyle, {file: string; label: string}>> = {
  apa: {file: 'apa.csl', label: 'APA'},
  ieee: {file: 'ieee.csl', label: 'IEEE'},
  'gb-t-7714': {file: 'china-national-standard-gb-t-7714-2015-numeric.csl', label: 'GB/T 7714-2015'},
  nature: {file: 'nature.csl', label: 'Nature'},
  ama: {file: 'american-medical-association.csl', label: 'AMA'},
  'chicago-author-date': {file: 'chicago-author-date.csl', label: 'Chicago author-date'}
};

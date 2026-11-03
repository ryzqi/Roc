import type {ResearchProductionInput} from '../../shared/schemas/research-production-inputs';

export type ProductionFileLocation = {
  area: ResearchProductionInput['files'][number]['area'];
  selected: ResearchProductionInput['files'][number] | null;
};

/** Window-local presentation state. Never stores source content or authorization. */
export type ArtifactReadingLocation = {
  version: string;
  scrollTop: number;
  openDetails: string[];
  focusKey: string | null;
  textScrollTop: number;
  productionOpen: boolean;
  productionFile: ProductionFileLocation | null;
};

export type ArtifactReadingLocations = Map<string, ArtifactReadingLocation>;

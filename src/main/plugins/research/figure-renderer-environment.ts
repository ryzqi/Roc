import { createHash } from 'node:crypto';
import {
  researchFigureRendererEnvironmentSchema,
  type ResearchFigureRendererEnvironment,
} from '../../../shared/schemas/research-figures';

const rendererVersions = {
  engine: 'vega-lite' as const,
  vegaVersion: '6.2.0',
  vegaLiteVersion: '6.4.1',
  renderer: '@napi-rs/canvas' as const,
  rendererVersion: '1.0.13',
  pipelineVersion: 'roc-vega-pipeline/1',
};

export function getResearchFigureRendererEnvironment(): ResearchFigureRendererEnvironment {
  const fingerprint = {
    ...rendererVersions,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  };
  const hash = createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
  return researchFigureRendererEnvironmentSchema.parse({ ...fingerprint, hash });
}

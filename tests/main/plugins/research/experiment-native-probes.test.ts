import { describe, expect, it } from 'vitest';
import { normalizeNativeEnvironmentReport } from '../../../../src/main/plugins/research/experiment-native-probes';

describe('native environment report normalization', () => {
  it('parses renv CSV runtime, packages and metadata paths', () => {
    const csv = [
      'type,name,value',
      'runtime,version,4.6.1',
      'runtime,platform,darwin25.0',
      'runtime,architecture,aarch64',
      'runtime,prefix,/tmp/library',
      'runtime,basePrefix,/tmp/R',
      'package,renv,1.2.4',
      'metadata,/tmp/library/renv/DESCRIPTION,',
      ''
    ].join('\n');
    expect(normalizeNativeEnvironmentReport('renv', csv)).toEqual({
      version: '4.6.1',
      platform: 'darwin25.0',
      architecture: 'aarch64',
      prefix: '/tmp/library',
      basePrefix: '/tmp/R',
      packages: [{ name: 'renv', versions: ['1.2.4'] }],
      metadataPaths: ['/tmp/library/renv/DESCRIPTION'],
      controls: []
    });
  });

  it('parses quoted CSV fields and Julia JSON reports', () => {
    const csv = 'type,name,value\nruntime,prefix,"/tmp/lib, with comma"\n';
    expect(normalizeNativeEnvironmentReport('renv', csv)).toMatchObject({
      prefix: '/tmp/lib, with comma',
      packages: [],
      metadataPaths: [],
      controls: []
    });
    expect(normalizeNativeEnvironmentReport('julia', '{"version":"1.13.0","packages":[]}')).toEqual({
      version: '1.13.0',
      packages: []
    });
  });

  it('rejects invalid renv CSV and Julia JSON', () => {
    expect(() => normalizeNativeEnvironmentReport('renv', 'not,csv')).toThrow('research_experiment_environment_report_invalid');
    expect(() => normalizeNativeEnvironmentReport('julia', '{')).toThrow('research_experiment_environment_report_invalid');
  });
});

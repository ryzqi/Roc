import type { EnabledCapabilities } from '../../shared/types';
import type { ConfigService } from './config-service';
import type { SkillService } from './skill-service';

export type RuntimeCapabilityResolver = {
  resolveCurrentEnabledCapabilities(): EnabledCapabilities;
};

export function createRuntimeCapabilityResolver(input: {
  configService: ConfigService;
  skillService: SkillService;
}): RuntimeCapabilityResolver {
  return {
    resolveCurrentEnabledCapabilities(): EnabledCapabilities {
      const mcpServers = input.configService
        .getMcpConfig()
        .servers.filter((server) => server.enabled)
        .map((server) => server.id);
      const skills = input.skillService
        .list()
        .filter((skill) => skill.enabled && skill.status === 'ready')
        .map((skill) => skill.id);
      return { mcpServers, skills };
    }
  };
}

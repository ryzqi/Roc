export interface SmokePaths {
  dataRoot: string;
  workspaceRoot: string;
  skillSourceRoot: string;
  remoteRoot: string;
}

export interface SmokeProviderRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: unknown;
}

export interface SmokeProvider {
  endpoint: string;
  requests: SmokeProviderRequest[];
  close: () => Promise<void>;
}

export interface StartSmokeProviderInput {
  taskProposalGoal?: string;
  now?: Date;
}

export function createSmokePaths(): Promise<SmokePaths>;

export function seedSmokeWorkspace(workspaceRoot: string, remoteRoot: string): void;

export function seedSmokeSkillSource(skillSourceRoot: string): void;

export function startSmokeProvider(input?: StartSmokeProviderInput): Promise<SmokeProvider>;

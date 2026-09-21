export const disabledChromiumFeatures = [
  'MediaRouter',
  'DialMediaRouteProvider',
  'TranslateUI',
  'HardwareMediaKeyHandling',
  'SpareRendererForSitePerProcess',
  'AutofillServerCommunication',
  'InterestFeedContentSuggestions',
  'CalculateNativeWinOcclusion'
] as const;

export function applyChromiumRuntimeFlags(commandLine: {
  appendSwitch(switchValue: string, value?: string): void;
}, env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): void {
  commandLine.appendSwitch('disable-features', disabledChromiumFeatures.join(','));
  commandLine.appendSwitch('disable-background-networking');
  commandLine.appendSwitch('disable-component-update');
  commandLine.appendSwitch('disable-domain-reliability');
  const remoteDebuggingPort = resolveRemoteDebuggingPort(argv) ?? (env.ROC_SMOKE === '1' ? '0' : null);
  if (remoteDebuggingPort !== null) {
    commandLine.appendSwitch('remote-debugging-port', remoteDebuggingPort);
  }
}

function resolveRemoteDebuggingPort(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--remote-debugging-port') {
      const value = argv[index + 1];
      return value === undefined || value.startsWith('-') ? '0' : value;
    }
    if (argument.startsWith('--remote-debugging-port=')) {
      const value = argument.slice('--remote-debugging-port='.length);
      return value === '' ? '0' : value;
    }
  }
  return null;
}

export const disabledChromiumFeatures = [
  'MediaRouter',
  'DialMediaRouteProvider',
  'TranslateUI',
  'HardwareMediaKeyHandling',
  'SpareRendererForSitePerProcess'
] as const;

export function applyChromiumRuntimeFlags(commandLine: {
  appendSwitch(switchValue: string, value?: string): void;
}): void {
  commandLine.appendSwitch('disable-features', disabledChromiumFeatures.join(','));
}

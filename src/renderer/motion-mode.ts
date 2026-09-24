type BatterySnapshot = {
  charging: boolean;
  level: number;
  addEventListener(type: 'levelchange' | 'chargingchange', listener: () => void): void;
  removeEventListener(type: 'levelchange' | 'chargingchange', listener: () => void): void;
};

type BatteryNavigator = Navigator & {
  getBattery?: () => Promise<BatterySnapshot>;
  deviceMemory?: number;
};

const LOW_BATTERY_LEVEL = 0.2;
const LOW_DEVICE_MEMORY_GB = 4;

function isLowPowerDevice(battery: BatterySnapshot | null): boolean {
  const nav = navigator as BatteryNavigator;
  const lowMemory = typeof nav.deviceMemory === 'number' && nav.deviceMemory <= LOW_DEVICE_MEMORY_GB;
  const onLowBattery = battery !== null && !battery.charging && battery.level <= LOW_BATTERY_LEVEL;
  return lowMemory || onLowBattery;
}

export function applyMotionMode(root: HTMLElement, reducedMotion: boolean, battery: BatterySnapshot | null): void {
  // 减弱动效走 CSS 媒体查询。这里不写 data-motion=reduce，避免没有选择器的属性。
  // macOS 低电量模式在渲染进程里看不到，不改 IPC。只在 Battery Status 可用时看电量。
  if (reducedMotion || !isLowPowerDevice(battery)) {
    delete root.dataset.motion;
    return;
  }
  root.dataset.motion = 'conserve';
}

export function bindMotionMode(root: HTMLElement = document.documentElement): () => void {
  const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let battery: BatterySnapshot | null = null;
  let cancelled = false;
  const batteryCleanups: Array<() => void> = [];

  const apply = (): void => {
    applyMotionMode(root, reducedQuery.matches, battery);
  };

  reducedQuery.addEventListener('change', apply);

  const nav = navigator as BatteryNavigator;
  if (typeof nav.getBattery === 'function') {
    void nav.getBattery()
      .then((snapshot) => {
        if (cancelled) {
          return;
        }
        battery = snapshot;
        const onChange = (): void => {
          apply();
        };
        snapshot.addEventListener('levelchange', onChange);
        snapshot.addEventListener('chargingchange', onChange);
        batteryCleanups.push(() => {
          snapshot.removeEventListener('levelchange', onChange);
          snapshot.removeEventListener('chargingchange', onChange);
        });
        apply();
      })
      .catch(() => {
        // Battery Status API 在部分 Electron 构建里不可用。没有它就只看核心数和内存。
      });
  }

  apply();

  return () => {
    cancelled = true;
    reducedQuery.removeEventListener('change', apply);
    for (const cleanup of batteryCleanups) {
      cleanup();
    }
    delete root.dataset.motion;
  };
}

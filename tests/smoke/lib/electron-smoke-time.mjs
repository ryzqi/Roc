import { existsSync, readFileSync } from 'node:fs';

export function createSafeDailySmokeClock(now = new Date()) {
  const candidate = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  return {
    hour: candidate.getHours(),
    minute: candidate.getMinutes()
  };
}

export function formatSmokeClock(clock) {
  return `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
}

export function nextDailyRunAtUtc(hour, minute, now = new Date()) {
  const candidate = new Date(now.getTime());
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.toISOString();
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function redactSmokeProviderRequest(request) {
  if (request === null) {
    return null;
  }
  return {
    ...request,
    authorization: typeof request.authorization === 'string' ? '<redacted>' : request.authorization
  };
}

export async function readWindowPlacementEvidence(filePath, expectedBounds) {
  const startedAt = Date.now();
  let lastSnapshot = null;
  while (Date.now() - startedAt < 2000) {
    if (existsSync(filePath)) {
      lastSnapshot = JSON.parse(readFileSync(filePath, 'utf8'));
      if (
        lastSnapshot.bounds?.x === expectedBounds.x &&
        lastSnapshot.bounds?.y === expectedBounds.y &&
        lastSnapshot.bounds?.width === expectedBounds.width &&
        lastSnapshot.bounds?.height === expectedBounds.height
      ) {
        return {
          filePath,
          persisted: true,
          expectedBounds,
          snapshot: lastSnapshot
        };
      }
    }
    await delay(50);
  }
  return {
    filePath,
    persisted: false,
    expectedBounds,
    snapshot: lastSnapshot
  };
}

export async function probeWindowMaterial(browserWindow, requestedMaterial) {
  return browserWindow.evaluate((window, material) => {
    if (typeof window.setBackgroundMaterial !== 'function') {
      return {
        requestedMaterial: material,
        apiAvailable: false,
        accepted: false,
        errorMessage: 'setBackgroundMaterial is unavailable'
      };
    }
    try {
      window.setBackgroundMaterial(material);
      return {
        requestedMaterial: material,
        apiAvailable: true,
        accepted: true,
        errorMessage: null
      };
    } catch (error) {
      return {
        requestedMaterial: material,
        apiAvailable: true,
        accepted: false,
        errorMessage: error instanceof Error ? error.message : String(error)
      };
    }
  }, requestedMaterial);
}

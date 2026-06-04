export type WindowMaterial = 'mica' | 'acrylic';

type MaterialWindow = {
  setBackgroundMaterial(material: WindowMaterial): void;
};

type MaterialFallbackWindow = MaterialWindow & {
  setBackgroundColor(color: string): void;
};

type MaterialLogService = {
  warn(
    message: string,
    context: {
      service: string;
      component: string;
      metadata: {
        material: WindowMaterial;
        error: string;
      };
    }
  ): void;
};

type MaterialFallbackLogService = MaterialLogService & {
  info(
    message: string,
    context: {
      service: string;
      component: string;
      metadata: {
        color: string;
      };
    }
  ): void;
};

export type MaterialFallbackStrategy = {
  primary: WindowMaterial;
  fallbacks: WindowMaterial[];
  staticBackground: string;
};

export type WindowMaterialResult =
  | {
      material: WindowMaterial;
      applied: true;
    }
  | {
      material: WindowMaterial;
      applied: false;
      errorMessage: string;
    };

export function applyWindowMaterial(
  window: MaterialWindow,
  material: WindowMaterial,
  logService: MaterialLogService
): WindowMaterialResult {
  try {
    window.setBackgroundMaterial(material);
    return {
      material,
      applied: true
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logService.warn('Roc window background material is unavailable; static background will be used.', {
      service: 'window-material',
      component: 'applyWindowMaterial',
      metadata: {
        material,
        error: errorMessage
      }
    });
    return {
      material,
      applied: false,
      errorMessage
    };
  }
}

export function applyWindowMaterialWithFallback(
  window: MaterialFallbackWindow,
  strategy: MaterialFallbackStrategy,
  logService: MaterialFallbackLogService
): WindowMaterialResult {
  const primaryResult = applyWindowMaterial(window, strategy.primary, logService);
  if (primaryResult.applied) {
    return primaryResult;
  }
  let lastResult: WindowMaterialResult = primaryResult;
  for (const fallback of strategy.fallbacks) {
    const fallbackResult = applyWindowMaterial(window, fallback, logService);
    if (fallbackResult.applied) {
      return fallbackResult;
    }
    lastResult = fallbackResult;
  }
  window.setBackgroundColor(strategy.staticBackground);
  logService.info('Roc window background material fallback applied.', {
    service: 'window-material',
    component: 'applyWindowMaterialWithFallback',
    metadata: {
      color: strategy.staticBackground
    }
  });
  return lastResult;
}

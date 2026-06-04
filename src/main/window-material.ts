type WindowMaterial = 'mica' | 'acrylic';

type MaterialWindow = {
  setBackgroundMaterial(material: WindowMaterial): void;
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

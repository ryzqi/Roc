import { describe, expect, it, vi } from 'vitest';
import { applyWindowMaterial, applyWindowMaterialWithFallback } from '../../src/main/window-material';

describe('window material fallback', () => {
  it('applies the requested Windows material when Electron accepts it', () => {
    const setBackgroundMaterial = vi.fn();
    const logService = { warn: vi.fn() };

    const result = applyWindowMaterial({ setBackgroundMaterial }, 'mica', logService);

    expect(result).toEqual({ material: 'mica', applied: true });
    expect(setBackgroundMaterial).toHaveBeenCalledWith('mica');
    expect(logService.warn).not.toHaveBeenCalled();
  });

  it('keeps the static background and logs when Windows material is unavailable', () => {
    const setBackgroundMaterial = vi.fn(() => {
      throw new Error('unsupported material');
    });
    const logService = { warn: vi.fn() };

    const result = applyWindowMaterial({ setBackgroundMaterial }, 'acrylic', logService);

    expect(result).toEqual({
      material: 'acrylic',
      applied: false,
      errorMessage: 'unsupported material'
    });
    expect(logService.warn).toHaveBeenCalledWith('Roc window background material is unavailable; static background will be used.', {
      service: 'window-material',
      component: 'applyWindowMaterial',
      metadata: {
        material: 'acrylic',
        error: 'unsupported material'
      }
    });
  });

  it('tries fallback materials when the primary material is unavailable', () => {
    const setBackgroundMaterial = vi.fn((material: 'mica' | 'acrylic') => {
      if (material === 'mica') {
        throw new Error('mica unavailable');
      }
    });
    const setBackgroundColor = vi.fn();
    const logService = { info: vi.fn(), warn: vi.fn() };

    const result = applyWindowMaterialWithFallback(
      { setBackgroundMaterial, setBackgroundColor },
      {
        primary: 'mica',
        fallbacks: ['acrylic'],
        staticBackground: '#f7f8f5'
      },
      logService
    );

    expect(result).toEqual({ material: 'acrylic', applied: true });
    expect(setBackgroundMaterial).toHaveBeenNthCalledWith(1, 'mica');
    expect(setBackgroundMaterial).toHaveBeenNthCalledWith(2, 'acrylic');
    expect(setBackgroundColor).not.toHaveBeenCalled();
  });

  it('uses the static background when every material fails', () => {
    const setBackgroundMaterial = vi.fn((material: 'mica' | 'acrylic') => {
      throw new Error(`${material} unavailable`);
    });
    const setBackgroundColor = vi.fn();
    const logService = { info: vi.fn(), warn: vi.fn() };

    const result = applyWindowMaterialWithFallback(
      { setBackgroundMaterial, setBackgroundColor },
      {
        primary: 'mica',
        fallbacks: ['acrylic'],
        staticBackground: '#f7f8f5'
      },
      logService
    );

    expect(result).toEqual({
      material: 'acrylic',
      applied: false,
      errorMessage: 'acrylic unavailable'
    });
    expect(setBackgroundMaterial).toHaveBeenCalledTimes(2);
    expect(setBackgroundColor).toHaveBeenCalledWith('#f7f8f5');
    expect(logService.info).toHaveBeenCalledWith('Roc window background material fallback applied.', {
      service: 'window-material',
      component: 'applyWindowMaterialWithFallback',
      metadata: {
        color: '#f7f8f5'
      }
    });
  });
});

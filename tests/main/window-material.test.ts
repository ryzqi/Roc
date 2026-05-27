import { describe, expect, it, vi } from 'vitest';
import { applyWindowMaterial } from '../../src/main/window-material';

describe('window material fallback', () => {
  it('applies the requested Windows material when Electron accepts it', () => {
    const setBackgroundMaterial = vi.fn();
    const logService = { append: vi.fn() };

    const result = applyWindowMaterial({ setBackgroundMaterial }, 'mica', logService);

    expect(result).toEqual({ material: 'mica', applied: true });
    expect(setBackgroundMaterial).toHaveBeenCalledWith('mica');
    expect(logService.append).not.toHaveBeenCalled();
  });

  it('keeps the static background and logs when Windows material is unavailable', () => {
    const setBackgroundMaterial = vi.fn(() => {
      throw new Error('unsupported material');
    });
    const logService = { append: vi.fn() };

    const result = applyWindowMaterial({ setBackgroundMaterial }, 'acrylic', logService);

    expect(result).toEqual({
      material: 'acrylic',
      applied: false,
      errorMessage: 'unsupported material'
    });
    expect(logService.append).toHaveBeenCalledWith({
      level: 'warn',
      message: 'Roc window background material is unavailable; static background will be used.',
      data: {
        material: 'acrylic',
        error: 'unsupported material'
      }
    });
  });
});

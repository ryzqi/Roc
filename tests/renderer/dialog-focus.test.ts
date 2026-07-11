// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { captureDialogOpener, restoreDialogFocus } from '../../src/renderer/dialog-focus';

afterEach(() => {
  document.body.replaceChildren();
});

describe('dialog focus helpers', () => {
  it('captures and restores a connected opener', () => {
    const opener = document.createElement('button');
    const other = document.createElement('button');
    document.body.append(opener, other);
    opener.focus();

    expect(captureDialogOpener()).toBe(opener);
    other.focus();
    expect(restoreDialogFocus(opener)).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it('does not guess a fallback for body or a disconnected opener', () => {
    expect(captureDialogOpener()).toBeNull();
    const opener = document.createElement('button');
    const other = document.createElement('button');
    document.body.append(opener, other);
    opener.focus();
    const captured = captureDialogOpener();
    opener.remove();
    other.focus();

    expect(restoreDialogFocus(captured)).toBe(false);
    expect(document.activeElement).toBe(other);
  });
});

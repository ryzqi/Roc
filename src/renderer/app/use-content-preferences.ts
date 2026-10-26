import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { CONTENT_PREFERENCES_CHANGED, readContentPreferences, writeContentPreferences, uiStateKeys, type ContentPreferences } from './ui-state';

export function useContentPreferences(): {
  preferences: ContentPreferences;
  update: (patch: Partial<ContentPreferences>) => void;
} {
  const [preferences, setPreferences] = useState(readContentPreferences);
  useEffect(() => {
    const sync = (): void => setPreferences(readContentPreferences());
    const storageChanged = (event: StorageEvent): void => {
      if (event.key === null || event.key === uiStateKeys.contentPreferences) sync();
    };
    window.addEventListener(CONTENT_PREFERENCES_CHANGED, sync);
    window.addEventListener('storage', storageChanged);
    return () => {
      window.removeEventListener(CONTENT_PREFERENCES_CHANGED, sync);
      window.removeEventListener('storage', storageChanged);
    };
  }, []);
  const update = useCallback((patch: Partial<ContentPreferences>) => {
    writeContentPreferences({ ...readContentPreferences(), ...patch });
  }, []);
  return { preferences, update };
}

/** Apply content size independently of 13px UI and 12px chrome typography. */
export function useContentPreferenceSync(): void {
  const { preferences } = useContentPreferences();
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.density = preferences.density;
    root.style.setProperty('--font-read-size', `${preferences.readSize}px`);
    root.style.setProperty('--font-read-large-size', `${preferences.readSize + 2}px`);
    root.style.setProperty('--font-code-size', `${preferences.codeSize}px`);
  }, [preferences]);
}

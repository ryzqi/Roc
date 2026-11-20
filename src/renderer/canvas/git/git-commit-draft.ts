import {useEffect} from 'react';

/** Unsubmitted commit messages stay in this window, keyed by the bound repository. */
export type GitCommitDrafts = Map<string, string>;

/** The shell owns the map so closing the drawer keeps both the draft and its quit guard. */
export function useGitCommitDraftGuard(drafts: GitCommitDrafts): void {
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent): void => {
      if (drafts.size === 0) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [drafts]);
}

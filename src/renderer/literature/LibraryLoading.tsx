import {useEffect, useState} from 'react';
import {motionDurationSeconds} from '../shared/motion';

/** Fast reads never flash a skeleton; each placeholder uses the real 64px row. */
export function LibraryLoading(): React.JSX.Element {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), motionDurationSeconds.fast * 1000);
    return () => clearTimeout(timer);
  }, []);
  return <div role="status" data-testid="literature-loading">
    <span className="sr-only">正在读取文献库…</span>
    {visible ? <div className="library-loading-rows ui-skeleton" data-motion="lockstep" aria-hidden="true">
      {Array.from({length: 8}, (_, index) => <div key={index}><span/></div>)}
    </div> : null}
  </div>;
}

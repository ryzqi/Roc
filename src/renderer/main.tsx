import React from 'react';
import { createRoot } from 'react-dom/client';
import { LazyMotion, MotionConfig } from 'motion/react';
import { App } from './App';
import './styles/index.css';

// Load animation and layout features after the first React commit. Keep the loader
// stable across renders; domMax preserves the shared tab indicator's layoutId.
const loadMotionFeatures = () => import('./shared/motion-features').then((module) => module.default);

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Renderer root element is missing.');
}

createRoot(rootElement).render(
  <React.StrictMode>
    {/* Reduced motion is honoured globally; components never opt out. */}
    <MotionConfig reducedMotion="user">
      <LazyMotion features={loadMotionFeatures} strict>
        <App />
      </LazyMotion>
    </MotionConfig>
  </React.StrictMode>
);

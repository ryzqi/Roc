import React from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import { App } from './App';
import { bindWindowVisibility } from './window-visibility';
import './styles/index.css';

bindWindowVisibility();

const root = document.getElementById('root');
if (root === null) {
  throw new Error('Renderer root element is missing.');
}

createRoot(root).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </React.StrictMode>
);

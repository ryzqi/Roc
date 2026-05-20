import React from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import { App } from './App';
import './styles/index.css';
import 'highlight.js/styles/github.css';

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

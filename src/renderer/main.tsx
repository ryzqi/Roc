import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import 'highlight.js/styles/github.css';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('Renderer root element is missing.');
}

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

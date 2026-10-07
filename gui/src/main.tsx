import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './app.css';

/**
 * G3 挂载点：App 自装配（无 props）——token 门面（URL ?token= / localStorage 持久）与
 * 连接装配（VITE_SERVE_URL 缺省 location.origin）都在 App 内单点；此处只挂 root。
 */
const root = document.getElementById('root');
if (root === null) throw new Error('gui: #root not found');
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { emptyBoard } from '../../src/taskboard/model';
import type { SnapshotResponse } from './connection';

/**
 * G2 挂载点：占位空态 snapshot（连接装配 G3——届时 snapshot 来自 createConnection().snapshot()，
 * baseUrl 收 VITE_SERVE_URL env 缺省 location.origin）。
 */
const placeholder: SnapshotResponse = { messages: [], board: emptyBoard(), delegations: [], status: 'idle' };

const root = document.getElementById('root');
if (root === null) throw new Error('gui: #root not found');
createRoot(root).render(
  <React.StrictMode>
    <App snapshot={placeholder} />
  </React.StrictMode>,
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { replayFromPath } from './net/session';
import { ReplayPage } from './replay/ReplayPage';
import './styles.css';

const replayRoom = replayFromPath(location.pathname);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {replayRoom ? <ReplayPage room={replayRoom} /> : <App />}
  </StrictMode>,
);

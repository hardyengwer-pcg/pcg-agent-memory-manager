import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Filter out benign Vite HMR websocket reconnection noise in development sandbox
window.addEventListener('unhandledrejection', (event) => {
  const reason = event?.reason;
  const message = typeof reason === 'string' ? reason : (reason?.message || '');
  if (message.includes('WebSocket') || message.includes('failed to connect to websocket') || message.includes('closed without opened')) {
    event.preventDefault();
  }
});

window.addEventListener('error', (event) => {
  const message = event?.message || '';
  if (message.includes('WebSocket') || message.includes('failed to connect to websocket') || message.includes('closed without opened')) {
    event.preventDefault();
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);


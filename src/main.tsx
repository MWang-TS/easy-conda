import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

export type Theme = 'light' | 'dark';

const THEME_KEY = 'easy-conda-theme';

export function getInitialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

export function persistTheme(theme: Theme) {
  localStorage.setItem(THEME_KEY, theme);
}

// 在渲染前同步应用主题，避免首屏闪烁。
applyTheme(getInitialTheme());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

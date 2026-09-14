import { createRoot } from 'react-dom/client';
import './index.css';
import { applyTheme } from './app/theme';
import { AppRouter } from './app/router';
applyTheme();
createRoot(document.getElementById('root')!).render(<AppRouter />);

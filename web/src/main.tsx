import { createRoot } from 'react-dom/client';
import './index.css';
import { AppRouter } from './app/router';
createRoot(document.getElementById('root')!).render(<AppRouter />);

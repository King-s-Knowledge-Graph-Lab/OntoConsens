import { createRoot } from 'react-dom/client';
import { setAuthTokenGetter } from '@workspace/api-client-react';

import App from './App';
import { getAuthToken } from './lib/authToken';

import './index.css';

// Auth uses a per-tab bearer token (see src/lib/authToken.ts) rather than a
// shared cookie, so multiple accounts can be logged in across tabs at once.
setAuthTokenGetter(() => getAuthToken());

createRoot(document.getElementById('root')!).render(<App />);

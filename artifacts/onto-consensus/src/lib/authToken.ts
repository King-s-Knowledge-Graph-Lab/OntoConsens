// Auth token storage.
//
// Deliberately uses `sessionStorage`, not `localStorage` or a cookie:
// sessionStorage is scoped to a single browser tab, so opening the app in
// a second tab and logging in as a different user never overwrites the
// first tab's session. `setAuthTokenGetter` (registered in main.tsx) reads
// from here on every API request.
const STORAGE_KEY = "onto-consensus-auth-token";

export function getAuthToken(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setAuthToken(token: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Ignore storage failures (e.g. private browsing restrictions).
  }
}

export function clearAuthToken(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export interface SessionState {
  verificationSessionId?: string;
  botSessionToken?: string;
  customerId?: string;
  customerName?: string;
  createdAt: number;
}

const MAX_SESSION_AGE_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute

let cleanupTimer: ReturnType<typeof setInterval> | undefined;
let cleanupCallback: (() => void) | undefined;

export function startSessionCleanup(onCleanup: (maxAge: number) => void): void {
  cleanupCallback = () => {
    try {
      onCleanup(MAX_SESSION_AGE_MS);
    } catch (error) {
      console.error('Session cleanup failed:', error);
    }
  };
  cleanupTimer = setInterval(cleanupCallback, CLEANUP_INTERVAL_MS);
}

export function stopSessionCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = undefined;
  }
}

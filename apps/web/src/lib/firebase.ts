import { getApps, initializeApp } from "firebase/app";
import {
  browserSessionPersistence,
  getAuth,
  setPersistence,
  type Auth,
} from "firebase/auth";

export const authConfigured = () =>
  Boolean(
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY &&
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN &&
    process.env.NEXT_PUBLIC_IDENTITY_PROJECT_ID &&
    process.env.NEXT_PUBLIC_API_BASE_URL,
  );
let authPromise: Promise<Auth> | undefined;
export function identityAuth(): Promise<Auth> {
  if (!authConfigured())
    return Promise.reject(
      new Error("Sign-in hasn’t been configured for this deployment yet."),
    );
  authPromise ??= (async () => {
    const app =
      getApps()[0] ??
      initializeApp({
        apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
        authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
        projectId: process.env.NEXT_PUBLIC_IDENTITY_PROJECT_ID,
      });
    const auth = getAuth(app);
    await setPersistence(auth, browserSessionPersistence);
    return auth;
  })();
  return authPromise;
}

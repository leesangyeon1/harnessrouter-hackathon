import { getApps, initializeApp } from "firebase/app";
import {
  browserSessionPersistence,
  getAuth,
  setPersistence,
} from "firebase/auth";
export const configured = () =>
  Boolean(
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY &&
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN &&
    process.env.NEXT_PUBLIC_IDENTITY_PROJECT_ID,
  );
export async function adminAuth() {
  if (!configured())
    throw new Error("Administrator sign-in is not configured.");
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
}

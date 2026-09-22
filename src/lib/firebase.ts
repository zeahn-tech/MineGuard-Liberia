// ---------------------------------------------------------------------------
// FIREBASE INITIALIZATION — MineGuard Liberia backend
//
// Firebase web config values are public client identifiers by design. All
// access control is enforced by Firestore/Storage security rules (see
// firestore.rules / storage.rules), never by secrecy of these values.
// ---------------------------------------------------------------------------

import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from "firebase/firestore";
import { getStorage, type FirebaseStorage } from "firebase/storage";

export const firebaseConfig = {
  apiKey: "AIzaSyB0n1zg5mREvZmQ3bZhg6PqtfaUZpACXto",
  authDomain: "mineguard-liberia.firebaseapp.com",
  projectId: "mineguard-liberia",
  storageBucket: "mineguard-liberia.firebasestorage.app",
};

let app: FirebaseApp | null = null;
let _auth: Auth | null = null;
let _db: Firestore | null = null;
let _storage: FirebaseStorage | null = null;

export function firebaseApp(): FirebaseApp {
  if (!app) app = initializeApp(firebaseConfig);
  return app;
}

export function fbAuth(): Auth {
  if (!_auth) _auth = getAuth(firebaseApp());
  return _auth;
}

export function firestore(): Firestore {
  if (!_db) {
    // Persistent local cache: snapshots resolve from IndexedDB instantly on
    // tab switches and cold starts, and field operations keep working fully
    // offline — then reconcile when connectivity returns.
    // ignoreUndefinedProperties: optional form fields (district, coordinates,
    // notes…) are passed as `undefined` by callers; without this flag any
    // such write would hard-fail. Undefined fields are simply skipped.
    try {
      _db = initializeFirestore(firebaseApp(), {
        localCache: persistentLocalCache({
          tabManager: persistentMultipleTabManager(),
        }),
        ignoreUndefinedProperties: true,
      });
    } catch {
      // Very old browsers without IndexedDB: fall back to in-memory cache.
      _db = getFirestore(firebaseApp());
    }
  }
  return _db;
}

export function fbStorage(): FirebaseStorage {
  if (!_storage) _storage = getStorage(firebaseApp());
  return _storage;
}

// Convenience singletons (tree-shaken init on first import use).
export const auth = fbAuth();
export const db = firestore();
export const storage = fbStorage();

/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Build-time environment tag. Only "production" disables the demo seeder
   *  and enables production hardening (doc 14 deploy path). Any other value
   *  or absence = development/demo behavior. */
  readonly VITE_MINEGUARD_ENV?: string;
  /** Public contact address of the program office, shown on the Terms and
   *  Privacy pages. Unset → those pages point to the program office that
   *  provides access instead (no address is ever invented). */
  readonly VITE_LEGAL_CONTACT_EMAIL?: string;
  /** Web Push (VAPID) PUBLIC key for emergency alerts. Unset → the app does not offer to
   *  enable push notifications and says so; in-app alerts still work while the app is open. */
  readonly VITE_VAPID_PUBLIC_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Short commit id injected at build time (vite.config.ts `define`). */
declare const __BUILD_ID__: string;

/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Build-time environment tag. Only "production" disables the demo seeder
   *  and enables production hardening (doc 14 deploy path). Any other value
   *  or absence = development/demo behavior. */
  readonly VITE_MINEGUARD_ENV?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

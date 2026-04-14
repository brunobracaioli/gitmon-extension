/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Web app origin — `http://localhost:3000` in dev, prod URL otherwise.
   *  Injected by vite.config.ts via `define`. Single source of truth
   *  lives in vite.config.ts + manifest.config.ts. */
  readonly VITE_WEB_ORIGIN: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

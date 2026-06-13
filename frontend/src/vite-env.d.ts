/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HUSHPOT_ADDRESS?: string;
  readonly VITE_CUSDT_ADDRESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

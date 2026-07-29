/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CONVEX_URL?: string;
  readonly VITE_MOCK_CONVEX?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  vellum?: { platform: string; isElectron: boolean };
}

/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CONVEX_URL?: string;
  readonly VITE_CONVEX_SITE_URL?: string;
  /** Overrides the origin published /p/ links are minted from. */
  readonly VITE_PUBLIC_SITE_URL?: string;
  readonly VITE_MOCK_CONVEX?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  vellum?: {
    platform: string;
    isElectron: boolean;
    touchId?: {
      status(): Promise<{ available: boolean; enrolled: boolean }>;
      save(email: string, password: string): Promise<boolean>;
      signIn(): Promise<{ email: string; password: string } | null>;
      clear(): Promise<boolean>;
    };
    exportPdf?(
      html: string,
      suggestedName: string,
    ): Promise<{ ok: boolean; canceled?: boolean; error?: string; path?: string }>;
  };
}

declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    AICD_AUTH_MODE?: string;
    AICD_BACKGROUND_PROCESSING?: string;
    AICD_LOCAL_REQUEST_TOKEN?: string;
    SUPABASE_URL?: string;
    SUPABASE_ANON_KEY?: string;
    AICD_OWNER_EMAIL?: string;
    MOONSHOT_API_KEY?: string;
    MOONSHOT_MODEL?: string;
    ZAI_API_KEY?: string;
    ZAI_MODEL?: string;
  }
}

interface ImportMetaEnv {
  readonly AICD_LOCAL_RUNTIME: boolean;
}

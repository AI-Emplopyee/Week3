import vinext from "vinext";
import { defineConfig } from "vite";
import { standaloneConfig } from "./scripts/standalone-config.mjs";
import { assertLocalDevelopment, localPaths, PRIVATE_FILE_PATTERNS } from "./scripts/local-config.mjs";
import { localOnly } from "./build/local-vite-plugin";

const local = process.env.AICD_LOCAL === "1";
const standalone = process.env.AICD_STANDALONE === "1";
const placeholderDatabaseId = "00000000-0000-4000-8000-000000000000";

export default defineConfig(async ({ command }) => {
  if (local) {
    assertLocalDevelopment(command, process.env.AICD_LOCAL_REQUEST_TOKEN);
    if (standalone) throw new Error("Local and standalone deployment modes cannot be combined.");
  }

  // Keep development tools offline and their state within the project.
  process.env.CLOUDFLARE_CF_FETCH_ENABLED ??= "false";
  process.env.WRANGLER_SEND_METRICS ??= "false";
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.WRANGLER_REGISTRY_PATH ??= ".wrangler/dev-registry";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots tool settings when this plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  const bindings = standalone ? standaloneConfig({ development: command === "serve" }) : {
    name: "aicd-preview",
    vars: { AICD_AUTH_MODE: "unconfigured" },
    d1_databases: [{ binding: "DB", database_name: "aicd-preview-db", database_id: placeholderDatabaseId, migrations_dir: "drizzle" }],
    r2_buckets: [{ binding: "BUCKET", bucket_name: "aicd-preview-documents" }],
  };

  return {
    ...(local ? { envDir: localPaths().directory } : {}),
    define: { "import.meta.env.AICD_LOCAL_RUNTIME": JSON.stringify(local && command === "serve") },
    server: {
      host: "127.0.0.1", allowedHosts: ["localhost", "127.0.0.1"], cors: false,
      ...(local ? { strictPort: true } : {}),
      // macOS sandboxed previews cannot use FSEvents.
      ...(process.platform === "darwin" ? { watch: { useFsEvents: false, usePolling: true } } : {}),
      fs: { deny: PRIVATE_FILE_PATTERNS },
    },
    plugins: [
      ...(local ? [localOnly(process.env.AICD_LOCAL_REQUEST_TOKEN!)] : []),
      vinext(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] }, inspectorPort: false,
        ...(local ? { configPath: localPaths().config, persistState: { path: localPaths().state }, remoteBindings: false, tunnel: false } : {}),
        config: local ? {} : {
          main: "./build/worker.ts", compatibility_date: "2026-05-15", compatibility_flags: ["nodejs_compat"],
          ...bindings,
          d1_databases: bindings.d1_databases.map(binding => ({ ...binding, migrations_dir: command === "serve" ? "drizzle" : "../../drizzle" })),
        },
      }),
    ],
  };
});

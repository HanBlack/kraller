import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
let refreshInFlight: Promise<boolean> | null = null;

function runDataUpdate(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = new Promise((resolve) => {
    const proc = spawn("python", ["scripts/update_data.py"], {
      cwd: projectRoot,
      shell: true,
      stdio: "inherit",
    });
    proc.on("close", (code) => {
      refreshInFlight = null;
      resolve(code === 0);
    });
    proc.on("error", () => {
      refreshInFlight = null;
      resolve(false);
    });
  });

  return refreshInFlight;
}

/** Dev-only: POST /api/dev/refresh-data → python scripts/update_data.py */
function devDataRefreshPlugin(): Plugin {
  return {
    name: "dev-data-refresh",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/dev/refresh-data", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("Method Not Allowed");
          return;
        }

        void runDataUpdate().then((ok) => {
          res.setHeader("Content-Type", "application/json");
          res.statusCode = ok ? 200 : 500;
          res.end(JSON.stringify({ ok }));
        });
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), devDataRefreshPlugin()],
  // Pro https://kraller.eu nech '/'. Pro podsložku např. VITE_BASE_PATH=/app/
  base: process.env.VITE_BASE_PATH || "/",
});

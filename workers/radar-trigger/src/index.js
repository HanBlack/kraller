/**
 * Cloudflare Cron → GitHub workflow_dispatch (Live radar).
 * GitHub schedule cron alone is unreliable; this keeps meta.updatedAt ≤ ~7 min.
 */

const GH_HEADERS = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "kraller-radar-trigger",
});

async function metaAgeMin(env) {
  const base = (env.R2_PUBLIC_URL || "").replace(/\/$/, "");
  if (!base) return null;
  try {
    const res = await fetch(`${base}/data/meta.json`, {
      headers: { "User-Agent": "kraller-radar-trigger" },
    });
    if (!res.ok) return null;
    const meta = await res.json();
    const updated = meta?.updatedAt;
    if (!updated) return null;
    const ts = Date.parse(String(updated));
    if (!Number.isFinite(ts)) return null;
    return (Date.now() - ts) / 60_000;
  } catch {
    return null;
  }
}

async function liveRadarActive(env, token) {
  const repo = env.GITHUB_REPO || "HanBlack/kraller";
  const workflow = env.WORKFLOW_FILE || "live-radar.yml";
  for (const status of ["in_progress", "queued"]) {
    const url =
      `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs` +
      `?status=${status}&per_page=1`;
    const res = await fetch(url, { headers: GH_HEADERS(token) });
    if (!res.ok) continue;
    const data = await res.json();
    if ((data.total_count ?? 0) > 0) return true;
  }
  return false;
}

async function shouldDispatch(env) {
  const freshMin = Number(env.FRESH_MIN || "4");
  const age = await metaAgeMin(env);
  if (age != null && age < freshMin) {
    console.log(`skip dispatch: R2 meta fresh (${age.toFixed(1)} min)`);
    return false;
  }
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN secret missing");
  if (await liveRadarActive(env, token)) {
    console.log("skip dispatch: Live radar already running or queued");
    return false;
  }
  return true;
}

async function triggerLiveRadar(env) {
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN secret missing");

  const repo = env.GITHUB_REPO || "HanBlack/kraller";
  const workflow = env.WORKFLOW_FILE || "live-radar.yml";
  const ref = env.GITHUB_REF || "main";

  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        ...GH_HEADERS(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref }),
    },
  );

  const body = await res.text();
  if (!res.ok) {
    console.error(`dispatch failed ${res.status}: ${body}`);
    throw new Error(`GitHub ${res.status}: ${body}`);
  }

  console.log(`dispatched ${workflow} ref=${ref} repo=${repo}`);
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        if (await shouldDispatch(env)) {
          await triggerLiveRadar(env);
        }
      })(),
    );
  },

  /** GET /trigger s Authorization: Bearer <TRIGGER_SECRET> — ruční test */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/trigger") {
      const secret = env.TRIGGER_SECRET;
      const auth = request.headers.get("Authorization") || "";
      if (!secret || auth !== `Bearer ${secret}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      try {
        const force = url.searchParams.get("force") === "1";
        if (!force && !(await shouldDispatch(env))) {
          return new Response("SKIP — fresh or already running", { status: 200 });
        }
        await triggerLiveRadar(env);
        return new Response("OK — Live radar dispatched", { status: 200 });
      } catch (err) {
        return new Response(String(err), { status: 502 });
      }
    }
    return new Response("kraller radar trigger (cron */5)", { status: 200 });
  },
};

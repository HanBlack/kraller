/**
 * Cloudflare Cron → GitHub workflow_dispatch (Live radar).
 * GitHub schedule cron alone is unreliable; this keeps meta.updatedAt ≤ ~7 min.
 */

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
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "kraller-radar-trigger",
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
    ctx.waitUntil(triggerLiveRadar(env));
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
        await triggerLiveRadar(env);
        return new Response("OK — Live radar dispatched", { status: 200 });
      } catch (err) {
        return new Response(String(err), { status: 502 });
      }
    }
    return new Response("kraller radar trigger (cron */5)", { status: 200 });
  },
};

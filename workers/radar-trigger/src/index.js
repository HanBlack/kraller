/**
 * Cloudflare Cron → GitHub workflow_dispatch (Live radar + Live sat).
 * GitHub schedule cron alone is unreliable; this keeps meta + CTT cooling fresh.
 */

const GH_HEADERS = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "kraller-radar-trigger",
});

async function jsonFieldAgeMin(url, field) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "kraller-radar-trigger" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.[field] || data?.updatedAt || data?.validAt;
    if (!raw) return null;
    const ts = Date.parse(String(raw));
    if (!Number.isFinite(ts)) return null;
    return (Date.now() - ts) / 60_000;
  } catch {
    return null;
  }
}

async function jsonAgeMin(url) {
  return jsonFieldAgeMin(url, "updatedAt");
}

async function r2Base(env) {
  const fromEnv = (env.R2_PUBLIC_URL || "").replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  // Veřejné CDN — fallback když Worker secret není nastavený
  return "https://pub-4b180166ad2d4648a27ba3853b3eebd1.r2.dev";
}

/** Stáří mapového radaru (mosaicTime → radarTime → chmi → opera). */
async function operaFrameAgeMin(env) {
  const base = await r2Base(env);
  const url = `${base}/data/meta.json`;
  for (const field of ["mosaicTime", "radarTime", "chmiTime", "operaTime"]) {
    const age = await jsonFieldAgeMin(url, field);
    if (age != null) return age;
  }
  return jsonAgeMin(url);
}

async function coolingAgeMin(env) {
  const base = await r2Base(env);
  // Product time (CTT slot), ne file mtime — keep-last-good drží staré validAt
  return jsonFieldAgeMin(`${base}/data/satellite/cooling.json`, "validAt");
}

/** Ignore ghost in_progress runs older than this (minutes). */
function busyMaxAgeMin(env) {
  const n = Number(env.BUSY_MAX_AGE_MIN || "15");
  return Number.isFinite(n) && n > 0 ? n : 15;
}

async function cancelRun(token, repo, runId) {
  try {
    const cancelUrl = `https://api.github.com/repos/${repo}/actions/runs/${runId}/cancel`;
    const cancelRes = await fetch(cancelUrl, {
      method: "POST",
      headers: GH_HEADERS(token),
    });
    if (!cancelRes.ok) {
      const forceUrl = `https://api.github.com/repos/${repo}/actions/runs/${runId}/force-cancel`;
      await fetch(forceUrl, { method: "POST", headers: GH_HEADERS(token) });
    }
  } catch {
    /* ignore */
  }
}

/**
 * Queued runs: cancel them (cron every 2 min makes them redundant).
 * Block only on fresh in_progress — otherwise the queue stalls radar 20+ min.
 */
async function workflowBusy(env, token, workflow) {
  const repo = env.GITHUB_REPO || "HanBlack/kraller";
  const maxAgeMs = busyMaxAgeMin(env) * 60_000;
  const now = Date.now();

  // Zruš frontu — stačí jeden in_progress / nový dispatch
  {
    const url =
      `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs` +
      `?status=queued&per_page=10`;
    const res = await fetch(url, { headers: GH_HEADERS(token) });
    if (res.ok) {
      const data = await res.json();
      for (const run of data.workflow_runs || []) {
        console.log(`cancel queued ${workflow} run ${run.id}`);
        await cancelRun(token, repo, run.id);
      }
    }
  }

  const url =
    `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs` +
    `?status=in_progress&per_page=5`;
  const res = await fetch(url, { headers: GH_HEADERS(token) });
  if (!res.ok) return false;
  const data = await res.json();
  for (const run of data.workflow_runs || []) {
    const created = Date.parse(run.created_at || "");
    if (!Number.isFinite(created)) continue;
    const ageMs = now - created;
    if (ageMs <= maxAgeMs) return true;
    console.log(
      `ignore/cancel stale in_progress ${workflow} run ${run.id} age=${(ageMs / 60_000).toFixed(0)} min`,
    );
    await cancelRun(token, repo, run.id);
  }
  return false;
}

async function shouldDispatchRadar(env) {
  // Debounce podle stáří snímku, ne updatedAt (fast-path jinak blokuje nový OPERA)
  const freshMin = Number(env.FRESH_MIN || "4");
  const age = await operaFrameAgeMin(env);
  if (age != null && age < freshMin) {
    console.log(`skip radar: map frame fresh (${age.toFixed(1)} min)`);
    return false;
  }
  if (age == null) {
    console.log("radar: opera age unknown — dispatch");
  } else {
    console.log(`radar: map frame stale (${age.toFixed(1)} min >= ${freshMin})`);
  }
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN secret missing");
  const workflow = env.WORKFLOW_FILE || "live-radar.yml";
  if (await workflowBusy(env, token, workflow)) {
    console.log("skip radar: Live radar already in progress");
    return false;
  }
  return true;
}

async function shouldDispatchSat(env) {
  const freshMin = Number(env.SAT_FRESH_MIN || "12");
  const age = await coolingAgeMin(env);
  if (age != null && age < freshMin) {
    console.log(`skip sat: cooling fresh (${age.toFixed(1)} min)`);
    return false;
  }
  if (age == null) {
    console.log("sat: cooling age unknown — dispatch");
  } else {
    console.log(`sat: cooling stale (${age.toFixed(1)} min > ${freshMin})`);
  }
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN secret missing");
  const workflow = env.SAT_WORKFLOW_FILE || "live-sat.yml";
  if (await workflowBusy(env, token, workflow)) {
    console.log("skip sat: Live sat already in progress");
    return false;
  }
  return true;
}

async function triggerWorkflow(env, workflow) {
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN secret missing");

  const repo = env.GITHUB_REPO || "HanBlack/kraller";
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
    console.error(`dispatch ${workflow} failed ${res.status}: ${body}`);
    throw new Error(`GitHub ${res.status}: ${body}`);
  }

  console.log(`dispatched ${workflow} ref=${ref} repo=${repo}`);
}

async function triggerLiveRadar(env) {
  await triggerWorkflow(env, env.WORKFLOW_FILE || "live-radar.yml");
}

async function triggerLiveSat(env) {
  await triggerWorkflow(env, env.SAT_WORKFLOW_FILE || "live-sat.yml");
}

async function runCron(env) {
  const errors = [];
  try {
    if (await shouldDispatchRadar(env)) {
      await triggerLiveRadar(env);
    }
  } catch (err) {
    console.error("radar trigger error", err);
    errors.push(err);
  }
  try {
    if (await shouldDispatchSat(env)) {
      await triggerLiveSat(env);
    }
  } catch (err) {
    console.error("sat trigger error", err);
    errors.push(err);
  }
  if (errors.length) throw errors[0];
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },

  /** GET /trigger — Live radar; GET /trigger-sat — Live sat */
  async fetch(request, env) {
    const url = new URL(request.url);
    const secret = env.TRIGGER_SECRET;
    const auth = request.headers.get("Authorization") || "";

    if (url.pathname === "/trigger" || url.pathname === "/trigger-sat") {
      if (!secret || auth !== `Bearer ${secret}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      try {
        const force = url.searchParams.get("force") === "1";
        if (url.pathname === "/trigger-sat") {
          if (!force && !(await shouldDispatchSat(env))) {
            return new Response("SKIP — sat fresh or already running", {
              status: 200,
            });
          }
          await triggerLiveSat(env);
          return new Response("OK — Live sat dispatched", { status: 200 });
        }
        if (!force && !(await shouldDispatchRadar(env))) {
          return new Response("SKIP — fresh or already running", {
            status: 200,
          });
        }
        await triggerLiveRadar(env);
        return new Response("OK — Live radar dispatched", { status: 200 });
      } catch (err) {
        return new Response(String(err), { status: 502 });
      }
    }
    return new Response(
      "kraller radar+sat trigger (cron */2; /trigger /trigger-sat)",
      { status: 200 },
    );
  },
};

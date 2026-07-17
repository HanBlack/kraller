/** V dev režimu spustí na serveru python scripts/update_data.py. V produkci nic. */
export async function requestServerDataRefresh(): Promise<boolean> {
  if (!import.meta.env.DEV) return false;

  try {
    const res = await fetch("/api/dev/refresh-data", {
      method: "POST",
      cache: "no-store",
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

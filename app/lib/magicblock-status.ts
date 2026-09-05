// Mission Control - MagicBlock service status client.
//
// Wraps https://status.magicblock.app/api/services, the source of truth the
// magicblock dev skill directs you to for live/historical service health -
// "always fetch current data; do not answer from remembered status." Used to
// power the dashboard's region health chips independently of whatever our
// own probes are doing (a probe hanging could be our bug OR a real outage;
// this is how the UI tells them apart).

export type NetworkKey = "mainnet" | "devnet";
export type RegionKey = "asia" | "europe" | "usa" | "tee";
export type ServiceKey = "er" | "rpc_router" | "pricing_oracle" | "vrf_oracle";

export interface ServiceStatusSnapshot {
  network: NetworkKey;
  region: RegionKey;
  service: ServiceKey;
  server?: string;
  live: boolean | null; // true=Operational, false=Down, null=N/A
  downtimeMinutesPerDay?: Record<string, number>;
}

interface RawStatusPayload {
  meta?: { services?: string[]; days?: string[] };
  environments?: Record<
    string,
    {
      regions?: Record<
        string,
        {
          servers?: Record<string, unknown>;
          live_status?: Record<string, boolean | undefined>;
          metrics?: Record<string, Record<string, number>>;
        }
      >;
    }
  >;
}

let cache: { at: number; payload: RawStatusPayload } | null = null;
const CACHE_MS = 15_000;

async function fetchRaw(): Promise<RawStatusPayload> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.payload;
  const res = await fetch("https://status.magicblock.app/api/services", {
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`status.magicblock.app returned ${res.status}`);
  }
  const payload = (await res.json()) as RawStatusPayload;
  cache = { at: Date.now(), payload };
  return payload;
}

export async function fetchServiceStatus(
  network: NetworkKey,
): Promise<ServiceStatusSnapshot[]> {
  const raw = await fetchRaw();
  const services = raw.meta?.services ?? ["er", "rpc_router", "pricing_oracle", "vrf_oracle"];
  const envRegions = raw.environments?.[network]?.regions ?? {};

  const out: ServiceStatusSnapshot[] = [];
  for (const [regionKey, regionData] of Object.entries(envRegions)) {
    for (const service of services) {
      const liveRaw = regionData.live_status?.[service];
      out.push({
        network,
        region: regionKey as RegionKey,
        service: service as ServiceKey,
        live: liveRaw === undefined ? null : liveRaw,
        downtimeMinutesPerDay: regionData.metrics?.[service],
      });
    }
  }
  return out;
}

import type { Map as MapLibreMap } from "maplibre-gl";
import {
  blendSteeringGrid,
  createDemoWindLow,
  createDemoWindUpper,
  sampleWind,
  type WindGrid,
  type WindLayerMode,
} from "./windField";

type Particle = {
  lon: number;
  lat: number;
  age: number;
  maxAge: number;
};

/**
 * Pixely / (m·s⁻¹) / s — zoom-invariant.
 * 850 je pomalejší než 500; cap dřív srovnával obě vrstvy (~95 % 500 hitlo strop).
 */
const SPEED_TO_PX_LOW = 5.5;
const SPEED_TO_PX_UPPER = 7;
const SPEED_TO_PX_STEER = 6;
const MAX_MOVE_PX_LOW = 1.35;
const MAX_MOVE_PX_UPPER = 3.4;
const MAX_MOVE_PX_STEER = 2.5;
const MAX_AGE = 110;
const MIN_PARTICLES = 400;
const MAX_PARTICLES = 750;
const DENSITY_PER_KPX = 0.58;

function colorForSpeed(speedMs: number, mode: "low" | "upper" | "steer"): string {
  if (mode === "low") {
    if (speedMs < 3) return "rgba(155, 200, 220, 0.75)";
    if (speedMs < 7) return "rgba(125, 195, 215, 0.8)";
    if (speedMs < 12) return "rgba(145, 210, 190, 0.82)";
    return "rgba(210, 205, 155, 0.85)";
  }
  if (mode === "steer") {
    if (speedMs < 8) return "rgba(170, 185, 210, 0.75)";
    if (speedMs < 16) return "rgba(180, 175, 205, 0.8)";
    if (speedMs < 22) return "rgba(195, 170, 195, 0.82)";
    return "rgba(205, 175, 170, 0.85)";
  }
  if (speedMs < 10) return "rgba(185, 170, 215, 0.75)";
  if (speedMs < 18) return "rgba(195, 160, 210, 0.8)";
  if (speedMs < 24) return "rgba(210, 165, 190, 0.82)";
  return "rgba(215, 180, 165, 0.85)";
}

function speedScale(mode: WindLayerMode): { toPx: number; maxMove: number } {
  if (mode === "low") return { toPx: SPEED_TO_PX_LOW, maxMove: MAX_MOVE_PX_LOW };
  if (mode === "upper") {
    return { toPx: SPEED_TO_PX_UPPER, maxMove: MAX_MOVE_PX_UPPER };
  }
  return { toPx: SPEED_TO_PX_STEER, maxMove: MAX_MOVE_PX_STEER };
}

/**
 * Animované proudění větru — směr z mřížky, stabilní při zoomu.
 * Data vždy z rodiče (setWindGrids) — stejný zdroj jako šipky bouřek.
 */
export class WindParticleOverlay {
  private map: MapLibreMap;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private particles: Particle[] = [];
  private grid: WindGrid | null = null;
  private mode: WindLayerMode = "off";
  private raf = 0;
  private running = false;
  private lowGrid = createDemoWindLow();
  private upperGrid = createDemoWindUpper();
  private windReal = false;
  private gridsReady = false;
  private lastTs = 0;
  private cssW = 0;
  private cssH = 0;

  private onResize = () => {
    this.resize();
    this.clearCanvas();
    if (this.mode !== "off") this.ensureParticleCount(true);
  };

  private onMoveStart = () => {
    this.clearCanvas();
  };

  private onMoveEnd = () => {
    this.clearCanvas();
    this.lastTs = 0;
    if (this.mode !== "off") this.ensureParticleCount(true);
  };

  constructor(map: MapLibreMap) {
    this.map = map;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "wind-particle-canvas";
    this.canvas.setAttribute("aria-hidden", "true");

    const host = map.getContainer();
    host.appendChild(this.canvas);

    const ctx = this.canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;

    this.resize();
    map.on("resize", this.onResize);
    map.on("movestart", this.onMoveStart);
    map.on("zoomstart", this.onMoveStart);
    map.on("moveend", this.onMoveEnd);
    map.on("zoomend", this.onMoveEnd);
  }

  isRealData(): boolean {
    return this.windReal;
  }

  private gridForMode(mode: WindLayerMode): WindGrid | null {
    if (mode === "off") return null;
    if (mode === "low") return this.lowGrid;
    if (mode === "upper") return this.upperGrid;
    return blendSteeringGrid(this.lowGrid, this.upperGrid);
  }

  setWindGrids(low: WindGrid, upper: WindGrid, real: boolean) {
    this.lowGrid = low;
    this.upperGrid = upper;
    this.windReal = real;
    this.gridsReady = true;
    if (this.mode !== "off") {
      this.grid = this.gridForMode(this.mode);
      this.ensureParticleCount(true);
    }
  }

  setMode(mode: WindLayerMode) {
    this.mode = mode;
    this.canvas.style.display = mode === "off" ? "none" : "block";

    if (mode === "off") {
      this.grid = null;
      this.stop();
      this.clearCanvas();
      return;
    }

    if (!this.gridsReady) {
      this.grid = null;
      this.stop();
      this.clearCanvas();
      return;
    }

    this.grid = this.gridForMode(mode);
    this.resize();
    this.ensureParticleCount(true);
    this.start();
  }

  destroy() {
    this.stop();
    this.map.off("resize", this.onResize);
    this.map.off("movestart", this.onMoveStart);
    this.map.off("zoomstart", this.onMoveStart);
    this.map.off("moveend", this.onMoveEnd);
    this.map.off("zoomend", this.onMoveEnd);
    this.canvas.remove();
  }

  private start() {
    if (this.running) return;
    this.running = true;
    this.lastTs = 0;
    const tick = (ts: number) => {
      if (!this.running) return;
      this.frame(ts);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.lastTs = 0;
  }

  private clearCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private resize() {
    const host = this.map.getContainer();
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w <= 0 || h <= 0) return;

    this.cssW = w;
    this.cssH = h;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private targetParticleCount(): number {
    const areaKpx = (this.cssW * this.cssH) / 1000;
    return Math.round(
      Math.min(
        MAX_PARTICLES,
        Math.max(MIN_PARTICLES, areaKpx * DENSITY_PER_KPX),
      ),
    );
  }

  private ensureParticleCount(forceRespawn = false) {
    if (!this.grid) {
      this.particles = [];
      return;
    }
    const target = this.targetParticleCount();
    if (forceRespawn || this.particles.length === 0) {
      this.particles = Array.from({ length: target }, () => this.spawn());
      return;
    }
    while (this.particles.length < target) this.particles.push(this.spawn());
    if (this.particles.length > target) {
      this.particles.length = target;
    }
  }

  private spawn(): Particle {
    const g = this.grid!;
    const b = this.map.getBounds();
    const west = Math.max(g.west, b.getWest());
    const east = Math.min(g.east, b.getEast());
    const south = Math.max(g.south, b.getSouth());
    const north = Math.min(g.north, b.getNorth());

    const lon =
      west < east
        ? west + Math.random() * (east - west)
        : g.west + Math.random() * (g.east - g.west);
    const lat =
      south < north
        ? south + Math.random() * (north - south)
        : g.south + Math.random() * (g.north - g.south);

    return {
      lon,
      lat,
      age: Math.floor(Math.random() * MAX_AGE),
      maxAge: MAX_AGE * (0.65 + Math.random() * 0.55),
    };
  }

  private advanceParticle(
    p: Particle,
    g: WindGrid,
    dt: number,
  ): {
    prevX: number;
    prevY: number;
    nextX: number;
    nextY: number;
    speed: number;
  } | null {
    p.age += 1;
    if (p.age > p.maxAge) {
      Object.assign(p, this.spawn(), { age: 0 });
    }

    const sample = sampleWind(g, p.lon, p.lat);
    if (!sample || sample.speed < 0.15) {
      Object.assign(p, this.spawn(), { age: 0 });
      return null;
    }

    const prev = this.map.project([p.lon, p.lat]);

    const tip = this.map.project([
      p.lon + sample.u * 0.01,
      p.lat + sample.v * 0.01,
    ]);
    let dx = tip.x - prev.x;
    let dy = tip.y - prev.y;
    const dlen = Math.hypot(dx, dy);
    if (dlen < 1e-6) {
      Object.assign(p, this.spawn(), { age: 0 });
      return null;
    }
    dx /= dlen;
    dy /= dlen;

    const moveScale = speedScale(this.mode);
    const movePx = Math.min(
      moveScale.maxMove,
      Math.max(0.28, sample.speed * moveScale.toPx * dt),
    );

    const nextScreen = this.map.unproject([
      prev.x + dx * movePx,
      prev.y + dy * movePx,
    ]);
    p.lon = nextScreen.lng;
    p.lat = nextScreen.lat;

    if (
      p.lon < g.west ||
      p.lon > g.east ||
      p.lat < g.south ||
      p.lat > g.north
    ) {
      Object.assign(p, this.spawn(), { age: 0 });
      return null;
    }

    if (prev.x < -40 || prev.y < -40 || prev.x > this.cssW + 40 || prev.y > this.cssH + 40) {
      Object.assign(p, this.spawn(), { age: 0 });
      return null;
    }

    const next = this.map.project([p.lon, p.lat]);
    return {
      prevX: prev.x,
      prevY: prev.y,
      nextX: next.x,
      nextY: next.y,
      speed: sample.speed,
    };
  }

  private frame(ts: number) {
    const mode = this.mode;
    if (!this.grid || mode === "off") return;
    if (this.cssW <= 0 || this.cssH <= 0) return;

    if (this.map.isMoving()) {
      this.lastTs = ts;
      return;
    }

    const rawDt = this.lastTs ? (ts - this.lastTs) / 1000 : 1 / 60;
    this.lastTs = ts;
    const dt = Math.min(0.05, Math.max(0.012, rawDt));

    const g = this.grid;
    const colorMode: "low" | "upper" | "steer" = mode;
    const w = this.cssW;
    const h = this.cssH;
    const ctx = this.ctx;
    const zoom = this.map.getZoom();

    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0, 0, 0, 0.1)";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";

    const lineW = zoom < 7 ? 1.4 : zoom < 9 ? 1.25 : 1.15;
    ctx.lineCap = "round";
    ctx.lineWidth = lineW;

    for (const p of this.particles) {
      const step = this.advanceParticle(p, g, dt);
      if (!step) continue;

      const { prevX, prevY, nextX, nextY, speed } = step;
      if (nextX < -30 || nextY < -30 || nextX > w + 30 || nextY > h + 30) {
        continue;
      }

      const segLen = Math.hypot(nextX - prevX, nextY - prevY);
      if (segLen < 0.12 || segLen > 22) continue;

      const life = 1 - p.age / p.maxAge;
      ctx.strokeStyle = colorForSpeed(speed, colorMode);
      ctx.globalAlpha = 0.16 + 0.24 * life;
      ctx.beginPath();
      ctx.moveTo(prevX, prevY);
      ctx.lineTo(nextX, nextY);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }
}


import { useEffect, useState } from "react";
import { useI18n } from "./i18n";
import { AddressPanel } from "./components/AddressPanel";
import { DataStatus } from "./components/DataStatus";
import { LayerToggle } from "./components/LayerToggle";
import { LocationWatch } from "./components/LocationWatch";
import { MapLegend } from "./components/MapLegend";
import { MapView } from "./components/MapView";
import {
  StormDetail,
  type SelectedStorm,
} from "./components/StormDetail";
import {
  useStormDataContext,
  type BootPhase,
} from "./providers/StormDataProvider";
import type { WindLayerMode } from "./lib/windField";
import type { ScoredFormationPoint } from "./storm/formationData";
import type { ThreatBannerItem } from "./storm/userThreats";
import type { UserLocation } from "./types";
import "./App.css";

const MAP_READY_TIMEOUT_MS = 12_000;

function bootMessage(t: (key: string) => string, phase: BootPhase): string {
  switch (phase) {
    case "data":
      return t("app.bootData");
    case "history":
      return t("app.bootHistory");
    case "fetch":
      return t("app.bootFetch");
    case "refresh":
      return t("app.bootRefresh");
    case "map":
      return t("app.bootMap");
    case "done":
      return t("app.bootTiles");
    default:
      return t("app.bootSub");
  }
}

export default function App() {
  const { t } = useI18n();
  const { booting, bootPhase } = useStormDataContext();
  const [location, setLocation] = useState<UserLocation | null>(null);
  const [showFormation, setShowFormation] = useState(true);
  const [showProgress, setShowProgress] = useState(true);
  const [showRadar, setShowRadar] = useState(true);
  const [windMode, setWindMode] = useState<WindLayerMode>("steer");
  const [selected, setSelected] = useState<SelectedStorm | null>(null);
  const [windReal, setWindReal] = useState(false);
  const [formationReal, setFormationReal] = useState(false);
  const [timeOffsetMinutes, setTimeOffsetMinutes] = useState(0);
  const [historyRadarTime, setHistoryRadarTime] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [dataMeta, setDataMeta] = useState<{
    lastUpdated: string | null;
    operaTime: string | null;
    loading: boolean;
    booting: boolean;
    windReal: boolean;
    formationReal: boolean;
    sources: {
      opera?: { ok: boolean; updatedAt?: string | null; error?: string | null };
      wind?: { ok: boolean; updatedAt?: string | null; error?: string | null };
      formation?: { ok: boolean; updatedAt?: string | null; error?: string | null };
    } | null;
  }>({
    lastUpdated: null,
    operaTime: null,
    loading: false,
    booting: true,
    windReal: false,
    formationReal: false,
    sources: null,
  });
  const [threats, setThreats] = useState<ThreatBannerItem[]>([]);
  const [formationStats, setFormationStats] = useState({
    count: 0,
    linkCount: 0,
  });
  const [formationPoints, setFormationPoints] = useState<ScoredFormationPoint[]>(
    [],
  );
  const [controlsOpen, setControlsOpen] = useState(true);

  useEffect(() => {
    if (!booting) return;
    setMapReady(false);
  }, [booting]);

  useEffect(() => {
    if (booting || mapReady) return;
    const id = window.setTimeout(() => setMapReady(true), MAP_READY_TIMEOUT_MS);
    return () => window.clearTimeout(id);
  }, [booting, mapReady]);

  /** Na mobilu po výběru lokace sbal panel — víc mapy. */
  useEffect(() => {
    if (!location) return;
    const mq = window.matchMedia("(max-width: 900px)");
    if (mq.matches) setControlsOpen(false);
  }, [location?.lat, location?.lon]);

  useEffect(() => {
    if (selected) setControlsOpen(true);
  }, [selected]);

  const selectThreat = (item: ThreatBannerItem) => {
    setSelected(
      item.kind === "formation"
        ? { kind: "formation", feature: item.feature }
        : { kind: "radar", feature: item.feature },
    );
  };

  const ready = !booting && mapReady;

  return (
    <div className={`app${ready ? "" : " app-booting"}`}>
      {!ready && (
        <div className="boot-screen" role="status" aria-live="polite">
          <p className="boot-screen-title">Kraller</p>
          <p className="boot-screen-sub">
            {booting ? bootMessage(t, bootPhase) : t("app.bootTiles")}
          </p>
        </div>
      )}
      {!booting && (
        <MapView
          location={location}
          showFormation={showFormation}
          showProgress={showProgress}
          showRadar={showRadar}
          windMode={windMode}
          timeOffsetMinutes={timeOffsetMinutes}
          selected={selected}
          onSelect={setSelected}
          onWindSource={setWindReal}
          onFormationSource={setFormationReal}
          onDataMeta={setDataMeta}
          onThreatAlerts={setThreats}
          onHistoryRadarTime={setHistoryRadarTime}
          onFormationStats={setFormationStats}
          onFormationPoints={setFormationPoints}
          onMapReady={() => setMapReady(true)}
        />
      )}
      {ready && (
        <MapLegend
          showFormation={showFormation}
          showProgress={showProgress}
          showRadar={showRadar}
          windMode={windMode}
          hasLocation={!!location}
          windReal={windReal}
          formationReal={formationReal}
          formationCount={formationStats.count}
        />
      )}
      {ready && (
        <aside
          className={`sidebar${controlsOpen ? " is-open" : " is-collapsed"}${
            selected ? " has-detail" : ""
          }`}
        >
          <div className="sidebar-chrome">
            <button
              type="button"
              className="sidebar-chrome-toggle"
              aria-expanded={controlsOpen}
              aria-controls="sidebar-body"
              onClick={() => setControlsOpen((v) => !v)}
            >
              <span className="brand-mark" aria-hidden />
              <span className="sidebar-chrome-title">
                {location?.placeName ?? "Kraller"}
              </span>
              {threats.length > 0 && (
                <span className="sidebar-chrome-badge" aria-label={t("app.warnings")}>
                  {threats.length}
                </span>
              )}
              <span className="sidebar-chrome-chevron" aria-hidden>
                {controlsOpen ? "▾" : "▴"}
              </span>
            </button>
          </div>
          <div id="sidebar-body" className="sidebar-body">
            <AddressPanel location={location} onLocated={setLocation} />
            {location && (
              <LocationWatch
                location={location}
                threats={threats}
                onSelectThreat={selectThreat}
              />
            )}
            <DataStatus
              lastUpdated={dataMeta.lastUpdated}
              operaTime={dataMeta.operaTime}
              loading={dataMeta.loading}
              sources={dataMeta.sources}
              windReal={dataMeta.windReal}
              formationReal={dataMeta.formationReal}
            />
            <LayerToggle
              showFormation={showFormation}
              showProgress={showProgress}
              showRadar={showRadar}
              windMode={windMode}
              timeOffsetMinutes={timeOffsetMinutes}
              historyRadarTime={historyRadarTime}
              onToggleFormation={() => {
                setShowFormation((v) => !v);
                setSelected(null);
              }}
              onToggleProgress={() => {
                setShowProgress((v) => !v);
                setSelected(null);
              }}
              onToggleRadar={() => setShowRadar((v) => !v)}
              onWindMode={setWindMode}
              onTimeOffsetMinutes={setTimeOffsetMinutes}
            />
            {selected && (
              <StormDetail
                selected={selected}
                location={location}
                forecastMinutes={Math.max(0, timeOffsetMinutes)}
                formationPoints={formationPoints}
                onClose={() => setSelected(null)}
              />
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

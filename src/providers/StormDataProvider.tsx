import { createContext, useContext, type ReactNode } from "react";
import {
  useStormData,
  type BootPhase,
  type StormDataState,
} from "../hooks/useStormData";
import type { FormationZone } from "../storm/demo";

const StormDataContext = createContext<StormDataState | null>(null);

type Props = {
  fallbackFormation: FormationZone[];
  children: ReactNode;
};

export function StormDataProvider({ fallbackFormation, children }: Props) {
  const value = useStormData(fallbackFormation);
  return (
    <StormDataContext.Provider value={value}>{children}</StormDataContext.Provider>
  );
}

export function useStormDataContext(): StormDataState {
  const ctx = useContext(StormDataContext);
  if (!ctx) {
    throw new Error("useStormDataContext must be used within StormDataProvider");
  }
  return ctx;
}

export type { BootPhase, StormDataState };

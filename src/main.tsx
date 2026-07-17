import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LocaleProvider } from "./i18n";
import { StormDataProvider } from "./providers/StormDataProvider";
import { demoFormationZones } from "./storm/demo";
import "./index.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleProvider>
      <StormDataProvider fallbackFormation={demoFormationZones}>
        <App />
      </StormDataProvider>
    </LocaleProvider>
  </StrictMode>,
);

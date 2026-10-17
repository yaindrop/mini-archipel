import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { syncPreferences } from "./preferences.tsx";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginProvider } from "./plugins.tsx";
import { workbenchPlugins } from "../plugins/catalog.web.tsx";
import { App } from "./App.tsx";
import "@fontsource/manrope/latin-400.css";
import "@fontsource/manrope/latin-600.css";
import "@fontsource/manrope/latin-700.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "antd/dist/reset.css";
import "./styles.css";
const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      retry: 1,
    },
    mutations: {
      retry: 0,
    },
  },
});
// Remove the previous console's persistent credential; sessions are now HttpOnly cookies.
try {
  localStorage.removeItem("fleet-token");
  localStorage.removeItem("fleet-theme");
} catch {
  /* Storage is optional. */
}
if (new URLSearchParams(location.search).has("token"))
  history.replaceState(null, "", location.pathname);
const root = document.getElementById("root");
if (!root) throw new Error("Missing workbench root");
syncPreferences();
createRoot(root).render(
  <StrictMode>
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <PluginProvider plugins={workbenchPlugins}>
            <App />
          </PluginProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </I18nProvider>
  </StrictMode>,
);

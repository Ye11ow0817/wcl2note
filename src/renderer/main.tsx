import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RequestError } from "./api/wcl/client";
import { App } from "./app/App";
import { installWowheadTooltips } from "./integrations/wowhead";
import "./styles/global.css";
import "./integrations/wowhead.css";

installWowheadTooltips();
const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 300000,
      gcTime: 600000,
      refetchOnWindowFocus: false,
      retry: (count, error) =>
        count < 2 &&
        (!(error instanceof RequestError) ||
          error.status === 429 ||
          error.code === "NETWORK" ||
          error.code === "UPSTREAM"),
      retryDelay: (attempt, error) =>
        error instanceof RequestError && error.retryAfter
          ? error.retryAfter
          : Math.min(1000 * 2 ** attempt, 10000),
    },
  },
});
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);

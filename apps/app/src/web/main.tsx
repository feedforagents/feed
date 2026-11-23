// spec/app/index.md, "Story: Browse, switch modes, and sign in through the JoinSheet"
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../main.css";
import { App } from "./App.tsx";

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

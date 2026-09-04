import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";
import { report } from "./diagnostics";

// Chyba v rozhraní jinak skončí v konzoli prohlížeče, kterou uživatel na televizi neotevře.
window.addEventListener("error", (event) => report("ERROR", `Interface error: ${event.message}`, {
  source: event.filename, line: event.lineno, column: event.colno, stack: event.error instanceof Error ? event.error.stack : undefined,
}));
window.addEventListener("unhandledrejection", (event) => report("ERROR", `Unhandled rejection: ${event.reason instanceof Error ? event.reason.message : String(event.reason)}`, {
  stack: event.reason instanceof Error ? event.reason.stack : undefined,
}));

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);


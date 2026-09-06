import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";
import { classifyClientError, report } from "./diagnostics";

// Chyba v rozhraní jinak skončí v konzoli prohlížeče, kterou uživatel na televizi neotevře.
window.addEventListener("error", (event) => {
  const stack = event.error instanceof Error ? event.error.stack : undefined;
  const level = classifyClientError({ message: event.message, filename: event.filename, stack });
  if (level) report(level, `Interface error: ${event.message}`, { source: event.filename, line: event.lineno, column: event.colno, stack });
});
window.addEventListener("unhandledrejection", (event) => {
  const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
  const stack = event.reason instanceof Error ? event.reason.stack : undefined;
  const level = classifyClientError({ message, stack });
  if (level) report(level, `Unhandled rejection: ${message}`, { stack });
});

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

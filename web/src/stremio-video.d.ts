declare module "@stremio/stremio-video" {
  import { EventEmitter } from "events";
  export default class StremioVideo extends EventEmitter {
    dispatch(action: Record<string, unknown>, options?: Record<string, unknown>): void;
    destroy(): void;
  }
}


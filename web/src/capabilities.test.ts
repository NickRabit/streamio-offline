import { describe, expect, it } from "vitest";
import { detectCapabilities, isAppleMobile } from "./capabilities";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1";
const IPADOS = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.2 Safari/605.1.15";
const MAC = IPADOS;
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

describe("isAppleMobile", () => {
  it("recognises an iPhone", () => {
    expect(isAppleMobile(IPHONE, 5)).toBe(true);
  });

  it("recognises an iPad, which claims to be a Mac but has a touch screen", () => {
    expect(isAppleMobile(IPADOS, 5)).toBe(true);
  });

  it("leaves a real Mac and other browsers alone", () => {
    expect(isAppleMobile(MAC, 0)).toBe(false);
    expect(isAppleMobile(CHROME, 0)).toBe(false);
  });
});

describe("detectCapabilities", () => {
  const everything = () => true;

  it("reports what the browser claims", () => {
    expect(detectCapabilities(everything, CHROME, 0)).toEqual({
      h264: true, hevc: true, hevc10: true, vp8: true, vp9: true, av1: true,
      aac: true, mp3: true, opus: true, vorbis: true, ac3: true, eac3: true, flac: true,
    });
  });

  it("does not believe an iPhone about AC-3, which it cannot decode", () => {
    const caps = detectCapabilities(everything, IPHONE, 5);
    expect(caps.ac3).toBe(false);
    expect(caps.eac3).toBe(false);
    expect(caps.aac).toBe(true);
    expect(caps.hevc).toBe(true);
  });

  it("keeps AC-3 on a Mac, where Safari really decodes it", () => {
    const caps = detectCapabilities(everything, MAC, 0);
    expect(caps.ac3).toBe(true);
    expect(caps.eac3).toBe(true);
  });

  it("passes the queried codec strings through unchanged", () => {
    const asked: string[] = [];
    detectCapabilities((type) => { asked.push(type); return false; }, CHROME, 0);
    expect(asked).toContain('video/mp4; codecs="avc1.640029"');
    expect(asked).toContain('video/mp4; codecs="hvc1.2.4.L153.B0"');
  });
});

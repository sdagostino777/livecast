import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { SettingsStore } from "../src/settings.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "livecast-settings-"));
  db = openDb(path.join(dir, "db.sqlite"));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("SettingsStore", () => {
  it("seeds defaults from the environment on first boot", () => {
    const store = new SettingsStore(db);
    const s = store.get();
    expect(s.publicBaseUrl).toBe("http://localhost:4100"); // config.publicUrl default
    expect(s.cdnBaseUrl).toBe("");
    expect(s.ingestPort).toBe(1935);
    expect(store.hlsBaseUrl()).toBe(s.publicBaseUrl); // no CDN → origin
  });

  it("persists an update and reloads it in a fresh store", () => {
    const store = new SettingsStore(db);
    store.update({ cdnBaseUrl: "https://cdn.example", ingestPort: 19350 });
    expect(store.hlsBaseUrl()).toBe("https://cdn.example");

    const reloaded = new SettingsStore(db);
    expect(reloaded.get().cdnBaseUrl).toBe("https://cdn.example");
    expect(reloaded.get().ingestPort).toBe(19350);
  });

  it("trims trailing slashes so URLs concatenate cleanly", () => {
    const store = new SettingsStore(db);
    store.update({ publicBaseUrl: "https://live.example.com/", cdnBaseUrl: "https://cdn.example.com//" });
    expect(store.get().publicBaseUrl).toBe("https://live.example.com");
    expect(store.hlsBaseUrl()).toBe("https://cdn.example.com");
  });

  it("rejects an invalid URL and a CDN on the same origin as the app", () => {
    const store = new SettingsStore(db);
    expect(() => store.update({ publicBaseUrl: "not-a-url" })).toThrow();
    expect(() => store.update({ cdnBaseUrl: "ftp://cdn" })).toThrow();
    expect(() => store.update({ cdnBaseUrl: "http://localhost:4100" })).toThrow(/cdn_same_as_origin/);
  });

  it("returns to origin delivery when the CDN is cleared", () => {
    const store = new SettingsStore(db);
    store.update({ publicBaseUrl: "https://live.example.com", cdnBaseUrl: "https://cdn.example.com" });
    store.update({ cdnBaseUrl: "" });
    expect(store.hlsBaseUrl()).toBe("https://live.example.com");
  });
});

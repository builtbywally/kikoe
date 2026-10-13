/**
 * The desk's data: the place and the day's weather, read once and kept, so
 * a TV left on all day does not ask Open-Meteo every few seconds, and what
 * it draws is the real reading or nothing.
 */

import { describe, expect, it } from "vitest";
import { Dashboard, type Fetch, aqiWord } from "../src/dashboard.js";

function fakeFetch(calls: string[]): Fetch {
  return async (url: string) => {
    calls.push(url);
    let body: unknown = {};
    if (url.includes("ip-api.com"))
      body = {
        status: "success",
        city: "Bangkok",
        lat: 13.75,
        lon: 100.5,
        timezone: "Asia/Bangkok",
      };
    else if (url.includes("geocoding-api"))
      body = {
        results: [{ name: "Cairo", latitude: 30.04, longitude: 31.24, timezone: "Africa/Cairo" }],
      };
    else if (url.includes("air-quality"))
      body = { current: { us_aqi: 67, pm2_5: 21 }, hourly: { us_aqi: [60, 70] } };
    else if (url.includes("api.open-meteo.com/v1/forecast"))
      body = {
        current: {
          temperature_2m: 26,
          apparent_temperature: 30,
          relative_humidity_2m: 90,
          wind_speed_10m: 7,
          weather_code: 95,
          uv_index: 0,
        },
        hourly: {
          time: ["2026-10-13T00:00", "2026-10-13T01:00"],
          temperature_2m: [25, 26],
          apparent_temperature: [29, 30],
          relative_humidity_2m: [92, 90],
          uv_index: [0, 0],
        },
        daily: {
          weather_code: [95],
          temperature_2m_max: [31],
          temperature_2m_min: [25],
          precipitation_probability_max: [80],
        },
      };
    return { ok: true, json: async () => body };
  };
}

describe("Dashboard", () => {
  it("finds the place from the IP and reads the day", async () => {
    const calls: string[] = [];
    const d = new Dashboard(() => "", fakeFetch(calls));
    const w = await d.day();
    expect(w?.place.name).toBe("Bangkok");
    expect(w?.now).toMatchObject({ temp: 26, feels: 30, humidity: 90, aqi: 67, pm25: 21 });
    expect(w?.today).toEqual({ min: 25, max: 31, rain: 80, code: 95 });
    expect(w?.hours).toEqual(["00:00", "01:00"]);
    expect(w?.aqi).toEqual([60, 70]);
    expect(calls.some((u) => u.includes("timezone=Asia%2FBangkok"))).toBe(true);
  });

  it("uses the place the settings name", async () => {
    const calls: string[] = [];
    const d = new Dashboard(() => "Cairo", fakeFetch(calls));
    expect((await d.where())?.name).toBe("Cairo");
    expect(calls.some((u) => u.includes("ip-api"))).toBe(false);
  });

  it("keeps a reading for fifteen minutes", async () => {
    const calls: string[] = [];
    let now = 1_000_000;
    const d = new Dashboard(
      () => "",
      fakeFetch(calls),
      () => now,
    );
    await d.day();
    const first = calls.length;
    now += 10 * 60_000;
    await d.day();
    expect(calls.length).toBe(first);
    now += 6 * 60_000;
    await d.day();
    expect(calls.length).toBeGreaterThan(first);
  });

  it("gives nothing rather than a made-up number when the network fails", async () => {
    const d = new Dashboard(
      () => "",
      async () => {
        throw new Error("offline");
      },
    );
    expect(await d.day()).toBeNull();
  });

  it("says what an AQI means", () => {
    expect(aqiWord(67)).toBe("moderate");
    expect(aqiWord(null)).toBe("");
  });
});

describe("Dashboard.forget", () => {
  it("reads the place again after the settings change it", async () => {
    const calls: string[] = [];
    let place = "";
    const d = new Dashboard(() => place, fakeFetch(calls));
    expect((await d.where())?.name).toBe("Bangkok");
    place = "Cairo";
    expect((await d.where())?.name).toBe("Bangkok");
    d.forget();
    expect((await d.where())?.name).toBe("Cairo");
  });
});

/**
 * The desk's live data (KARA-PLAN phase 2): where the user is, and the
 * weather and air for the day, hour by hour, so the desk draws real numbers
 * and nothing else.
 *
 * Open-Meteo for weather and air (no key), and ip-api.com for a first guess
 * at the place when the settings name none. Both are cached: the place for
 * a day, the weather for fifteen minutes. Every fetch is injectable, so the
 * tests never touch the network.
 */

export type Fetch = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface Place {
  name: string;
  lat: number;
  lon: number;
  tz: string;
}

export interface DayWeather {
  place: Place;
  at: number;
  now: {
    temp: number;
    feels: number;
    humidity: number;
    wind: number;
    code: number;
    uv: number;
    aqi: number | null;
    pm25: number | null;
  };
  today: { min: number; max: number; rain: number; code: number };
  /** today's hours, local time "HH:00", and a value for each */
  hours: string[];
  temp: number[];
  feels: number[];
  humidity: number[];
  uv: number[];
  aqi: (number | null)[];
}

const PLACE_TTL = 24 * 3600_000;
const WEATHER_TTL = 15 * 60_000;

export class Dashboard {
  private place: { value: Place; at: number } | null = null;
  private weather: DayWeather | null = null;
  private inflight: Promise<DayWeather | null> | null = null;

  constructor(
    private readonly placeName: () => string,
    private readonly fetchImpl: Fetch = fetch as unknown as Fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** The place changed in the settings: read it, and its weather, again. */
  forget(): void {
    this.place = null;
    this.weather = null;
  }

  /** Where the user is: the settings' place by name, or a guess from the IP. */
  async where(): Promise<Place | null> {
    const t = this.now();
    if (this.place && t - this.place.at < PLACE_TTL) return this.place.value;
    const named = this.placeName().trim();
    let value: Place | null = null;
    try {
      if (named) {
        const g = (await (
          await this.fetchImpl(
            `https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(named)}`,
          )
        ).json()) as {
          results?: { name: string; latitude: number; longitude: number; timezone?: string }[];
        };
        const r = g.results?.[0];
        if (r)
          value = { name: r.name, lat: r.latitude, lon: r.longitude, tz: r.timezone ?? "auto" };
      } else {
        const g = (await (
          await this.fetchImpl("http://ip-api.com/json/?fields=status,city,lat,lon,timezone")
        ).json()) as {
          status?: string;
          city?: string;
          lat?: number;
          lon?: number;
          timezone?: string;
        };
        if (g.status === "success" && typeof g.lat === "number" && typeof g.lon === "number")
          value = { name: g.city ?? "", lat: g.lat, lon: g.lon, tz: g.timezone ?? "auto" };
      }
    } catch {
      value = null;
    }
    if (value) this.place = { value, at: t };
    return value ?? this.place?.value ?? null;
  }

  /** Today's weather and air, at most fifteen minutes old; null when it cannot be read. */
  async day(): Promise<DayWeather | null> {
    if (this.weather && this.now() - this.weather.at < WEATHER_TTL) return this.weather;
    this.inflight ??= this.readDay().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async readDay(): Promise<DayWeather | null> {
    const place = await this.where();
    if (!place) return this.weather;
    const q = `latitude=${place.lat}&longitude=${place.lon}&timezone=${encodeURIComponent(place.tz)}`;
    try {
      const w = (await (
        await this.fetchImpl(
          `https://api.open-meteo.com/v1/forecast?${q}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,uv_index&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,uv_index&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=1`,
        )
      ).json()) as {
        current?: Record<string, number>;
        hourly?: Record<string, (number | string)[]>;
        daily?: Record<string, number[]>;
      };
      // the air is a second service; the desk shows the weather without it
      let air: { current?: Record<string, number>; hourly?: Record<string, (number | null)[]> } =
        {};
      try {
        air = (await (
          await this.fetchImpl(
            `https://air-quality-api.open-meteo.com/v1/air-quality?${q}&current=us_aqi,pm2_5&hourly=us_aqi&forecast_days=1`,
          )
        ).json()) as typeof air;
      } catch {
        air = {};
      }
      const c = w.current ?? {};
      const h = w.hourly ?? {};
      const d = w.daily ?? {};
      const num = (x: unknown) => (typeof x === "number" ? x : Number(x) || 0);
      const hours = (h.time ?? []).map((s) => String(s).slice(11, 16));
      this.weather = {
        place,
        at: this.now(),
        now: {
          temp: num(c.temperature_2m),
          feels: num(c.apparent_temperature),
          humidity: num(c.relative_humidity_2m),
          wind: num(c.wind_speed_10m),
          code: num(c.weather_code),
          uv: num(c.uv_index),
          aqi: typeof air.current?.us_aqi === "number" ? air.current.us_aqi : null,
          pm25: typeof air.current?.pm2_5 === "number" ? air.current.pm2_5 : null,
        },
        today: {
          min: num(d.temperature_2m_min?.[0]),
          max: num(d.temperature_2m_max?.[0]),
          rain: num(d.precipitation_probability_max?.[0]),
          code: num(d.weather_code?.[0]),
        },
        hours,
        temp: (h.temperature_2m ?? []).map(num),
        feels: (h.apparent_temperature ?? []).map(num),
        humidity: (h.relative_humidity_2m ?? []).map(num),
        uv: (h.uv_index ?? []).map(num),
        aqi: hours.map((_, i) => {
          const v = air.hourly?.us_aqi?.[i];
          return typeof v === "number" ? v : null;
        }),
      };
    } catch {
      /* keep what was read last */
    }
    return this.weather;
  }
}

/** What a US AQI number means, in a word. */
export function aqiWord(aqi: number | null): string {
  if (aqi == null) return "";
  if (aqi <= 50) return "good";
  if (aqi <= 100) return "moderate";
  if (aqi <= 150) return "unhealthy for some";
  if (aqi <= 200) return "unhealthy";
  return "very unhealthy";
}

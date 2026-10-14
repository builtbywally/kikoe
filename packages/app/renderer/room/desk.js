// The desk: Kik's life dashboard for a wall screen, after K.A.R.A's
// (KARA-PLAN phase 2). A neuron sphere in the middle that is Kik thinking,
// ribbons of light along the bottom, a dock of five tabs (home, life, comms,
// work, you), panels of real readings on either side, and topic cards that
// slide in over the sphere as Kik speaks.
//
// Plain script, 2D canvas and SVG; no three.js, so it is cheap to leave on a
// TV all day. Data comes from the daemon's /dashboard (window.room.dashboard)
// every 30 seconds while the desk is open; nothing is drawn that was not
// read. API: window.KikDesk.mount(host) returns { show, hide, state, level,
// say, quiet }.
(() => {
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const THEMES = {
    // K.A.R.A's: hot pink to violet on black
    neon: { a: [255, 46, 136], b: [168, 85, 247], c: [255, 170, 60], ink: [255, 220, 236] },
    // Kikoe's ember
    ember: { a: [226, 110, 62], b: [245, 170, 110], c: [255, 214, 150], ink: [250, 232, 218] },
  };
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

  // --- the neuron sphere ------------------------------------------------------
  // After K.A.R.A's: shells of neurons on Fibonacci spheres, each linked to
  // its two nearest; waves of firing cross it and only the firing is drawn;
  // long arcs hold a pair for a few seconds; tilted ribbons orbit; a dense
  // core breathes; blocks of data arrive and leave.

  function makeSphere(seed0) {
    let seed = seed0;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const G = Math.PI * (3 - Math.sqrt(5));
    const shells = [0.36, 0.55, 0.74, 0.9, 1.0];
    const nodes = [];
    let k = 0;
    for (const [si, r] of shells.entries()) {
      const n = Math.round(110 + si * 40);
      for (let i = 0; i < n; i++) {
        const y = 1 - (i / (n - 1)) * 2;
        const rr = Math.sqrt(Math.max(0, 1 - y * y));
        const th = G * k++;
        const j = r * (0.95 + rnd() * 0.1);
        nodes.push({
          p: [Math.cos(th) * rr * j, y * j, Math.sin(th) * rr * j],
          fire: 0,
          ph: rnd() * 6.28,
        });
      }
    }
    // two nearest neighbours each, with a bow
    for (const a of nodes) {
      const best = [
        [9, -1],
        [9, -1],
      ];
      for (let i = 0; i < nodes.length; i++) {
        const b = nodes[i];
        if (b === a) continue;
        const d = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]);
        if (d < best[0][0]) {
          best[1] = best[0];
          best[0] = [d, i];
        } else if (d < best[1][0]) best[1] = [d, i];
      }
      a.links = best
        .filter(([d, i]) => i >= 0 && d < 0.3)
        .map(([d, i]) => {
          const b = nodes[i];
          const m = [(a.p[0] + b.p[0]) / 2, (a.p[1] + b.p[1]) / 2, (a.p[2] + b.p[2]) / 2];
          const amp = d * (0.15 + rnd() * 0.25);
          return {
            i,
            bow: [
              m[0] + (rnd() - 0.5) * amp,
              m[1] + (rnd() - 0.5) * amp,
              m[2] + (rnd() - 0.5) * amp,
            ],
          };
        });
    }
    const arcs = Array.from({ length: 22 }, () => ({
      life: 5 + rnd() * 6,
      off: rnd() * 12,
      a: 0,
      b: 0,
      out: 1.1 + rnd() * 0.4,
    }));
    const ribbons = [
      [1.18, 0.35, 0.9],
      [1.32, -0.5, 0.55],
      [1.42, 0.7, 0.45],
    ].map(([r, tilt, a]) => ({
      r,
      tilt,
      a,
      roll: rnd() * 6.28,
      sp: (rnd() < 0.5 ? -1 : 1) * (0.05 + rnd() * 0.05),
    }));
    const rings = [0.5, 0.66, 0.82].map((r, i) => ({
      r,
      sp: (i % 2 ? -1 : 1) * (0.06 + i * 0.03),
      tilt: (rnd() - 0.5) * 0.9,
      code: Array.from({ length: 26 }, () => ({ th: rnd() * 6.28, w: 0.02 + rnd() * 0.07 })),
    }));
    const packets = Array.from({ length: 10 }, () => {
      const z = rnd() * 2 - 1;
      const t = rnd() * 6.28;
      const s = Math.sqrt(1 - z * z);
      return {
        d: [Math.cos(t) * s, z, Math.sin(t) * s],
        ph: rnd(),
        sp: 0.06 + rnd() * 0.08,
        out: rnd() < 0.5,
      };
    });
    const core = Array.from({ length: 90 }, () => {
      const z = rnd() * 2 - 1;
      const t = rnd() * 6.28;
      const s = Math.sqrt(1 - z * z);
      return {
        d: [Math.cos(t) * s, z, Math.sin(t) * s],
        ph: rnd() * 6.28,
        reach: 0.1 + rnd() * 0.12,
      };
    });
    let waves = [];
    let nextWave = 0;
    return {
      nodes,
      arcs,
      ribbons,
      rings,
      packets,
      core,
      rnd,
      get waves() {
        return waves;
      },
      set waves(w) {
        waves = w;
      },
      get nextWave() {
        return nextWave;
      },
      set nextWave(t) {
        nextWave = t;
      },
    };
  }

  function drawSphere(g, sph, w, h, t, theme, mood, geo) {
    const cx = geo?.cx ?? w / 2;
    const cy = geo?.cy ?? h * 0.47;
    const R = (geo?.R ?? Math.min(w, h) * 0.27) * (1 + mood.level * 0.04);
    const ry = t * 0.08;
    const rx = 0.32 + Math.sin(t * 0.05) * 0.08;
    const cyR = Math.cos(ry);
    const syR = Math.sin(ry);
    const cxR = Math.cos(rx);
    const sxR = Math.sin(rx);
    const proj = (p) => {
      const x1 = p[0] * cyR + p[2] * syR;
      const z1 = -p[0] * syR + p[2] * cyR;
      const y2 = p[1] * cxR - z1 * sxR;
      const z2 = p[1] * sxR + z1 * cxR;
      const s = 3.2 / (3.2 - z2);
      return [cx + x1 * R * s, cy - y2 * R * s, z2];
    };
    g.globalCompositeOperation = "lighter";

    // the glow behind it
    const glow = g.createRadialGradient(cx, cy, 0, cx, cy, R * 1.5);
    glow.addColorStop(0, rgba(theme.a, 0.3 + mood.level * 0.18));
    glow.addColorStop(0.45, rgba(theme.b, 0.07));
    glow.addColorStop(1, rgba(theme.b, 0));
    g.fillStyle = glow;
    g.fillRect(cx - R * 1.6, cy - R * 1.6, R * 3.2, R * 3.2);

    // waves of firing: faster when thinking, brighter when speaking
    const rate = mood.thinking ? 0.45 : mood.speaking ? 0.7 - mood.level * 0.3 : 1.1;
    if (t > sph.nextWave) {
      const o = sph.nodes[Math.floor(sph.rnd() * sph.nodes.length)].p;
      sph.waves = sph.waves.concat([{ o, at: t }]).slice(-6);
      sph.nextWave = t + rate * (0.6 + sph.rnd() * 0.8);
    }
    for (const n of sph.nodes) {
      let f = 0;
      for (const wv of sph.waves) {
        const r = (t - wv.at) * 0.7;
        const d = Math.hypot(n.p[0] - wv.o[0], n.p[1] - wv.o[1], n.p[2] - wv.o[2]);
        const x = Math.abs(d - r);
        if (x < 0.12) f = Math.max(f, (1 - x / 0.12) * Math.max(0, 1 - r / 2));
      }
      n.fire = Math.max(f, n.fire * 0.94);
      n.s = proj(n.p);
    }
    // the links, only while firing
    g.lineWidth = 1;
    for (const a of sph.nodes) {
      if (a.fire < 0.05) continue;
      for (const l of a.links) {
        const b = sph.nodes[l.i];
        const al = Math.min(1, a.fire * 0.9 + b.fire * 0.3);
        const bow = proj(l.bow);
        g.strokeStyle = rgba(theme.a, al);
        g.beginPath();
        g.moveTo(a.s[0], a.s[1]);
        g.quadraticCurveTo(bow[0], bow[1], b.s[0], b.s[1]);
        g.stroke();
      }
    }
    // the neurons themselves: faint always, bright when firing
    for (const n of sph.nodes) {
      const depth = (n.s[2] + 1) / 2;
      const a = 0.28 + depth * 0.45 + n.fire * 0.8 + (mood.listening ? 0.15 : 0);
      g.fillStyle = n.fire > 0.3 ? rgba(theme.ink, a) : rgba(theme.a, a);
      const sz = 1.1 + depth * 1.6 + n.fire * 2.2;
      g.fillRect(n.s[0] - sz / 2, n.s[1] - sz / 2, sz, sz);
    }
    // the long arcs: a pair held a few seconds, a pulse running along
    for (const a of sph.arcs) {
      const cyc = (t + a.off) / a.life;
      const k = Math.floor(cyc);
      if (a.k !== k) {
        a.k = k;
        a.a = Math.floor(sph.rnd() * sph.nodes.length);
        a.b = Math.floor(sph.rnd() * sph.nodes.length);
      }
      const ph = cyc - k;
      const fade = Math.sin(ph * Math.PI);
      const p = sph.nodes[a.a].p;
      const q = sph.nodes[a.b].p;
      const m = [
        (p[0] + q[0]) * 0.5 * a.out,
        (p[1] + q[1]) * 0.5 * a.out,
        (p[2] + q[2]) * 0.5 * a.out,
      ];
      const P = sph.nodes[a.a].s;
      const Q = sph.nodes[a.b].s;
      const M = proj(m);
      g.strokeStyle = rgba(theme.b, 0.32 * fade);
      g.beginPath();
      g.moveTo(P[0], P[1]);
      g.quadraticCurveTo(M[0], M[1], Q[0], Q[1]);
      g.stroke();
      const u = (ph * 2) % 1;
      const x = (1 - u) * (1 - u) * P[0] + 2 * (1 - u) * u * M[0] + u * u * Q[0];
      const y = (1 - u) * (1 - u) * P[1] + 2 * (1 - u) * u * M[1] + u * u * Q[1];
      g.fillStyle = rgba(theme.ink, 0.8 * fade);
      g.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
    // the ribbons: tilted orbits, each a band of three lines
    for (const rb of sph.ribbons) {
      const roll = rb.roll + t * rb.sp;
      for (let line = 0; line < 3; line++) {
        g.strokeStyle = rgba(theme.a, rb.a * (line === 1 ? 0.2 : 0.08));
        g.lineWidth = line === 1 ? 1.8 : 1;
        g.beginPath();
        for (let i = 0; i <= 96; i++) {
          const th = (i / 96) * Math.PI * 2;
          const r = rb.r + (line - 1) * 0.025;
          let p = [Math.cos(th) * r, 0, Math.sin(th) * r];
          // tilt about x, then roll about y
          p = [p[0], -p[2] * Math.sin(rb.tilt), p[2] * Math.cos(rb.tilt)];
          p = [
            p[0] * Math.cos(roll) + p[2] * Math.sin(roll),
            p[1],
            -p[0] * Math.sin(roll) + p[2] * Math.cos(roll),
          ];
          const s = proj(p);
          if (i === 0) g.moveTo(s[0], s[1]);
          else g.lineTo(s[0], s[1]);
        }
        g.stroke();
      }
    }
    g.lineWidth = 1;
    // the rings, carrying code
    for (const rg of sph.rings) {
      const rot = t * rg.sp;
      for (const c of rg.code) {
        g.strokeStyle = rgba(theme.c, 0.35);
        g.beginPath();
        for (let i = 0; i <= 6; i++) {
          const th = c.th + rot + (i / 6) * c.w;
          const p = [
            Math.cos(th) * rg.r,
            Math.sin(th) * rg.r * Math.sin(rg.tilt),
            Math.sin(th) * rg.r * Math.cos(rg.tilt),
          ];
          const s = proj(p);
          if (i === 0) g.moveTo(s[0], s[1]);
          else g.lineTo(s[0], s[1]);
        }
        g.stroke();
      }
    }
    // the core: a breathing blob of points, joined to its neighbours
    const coreS = sph.core.map((c) => {
      const reach = c.reach * (1 + 0.25 * Math.sin(t * 1.3 + c.ph) + mood.level * 0.5);
      return proj([c.d[0] * reach, c.d[1] * reach, c.d[2] * reach]);
    });
    g.strokeStyle = rgba(theme.ink, 0.14 + mood.level * 0.2);
    g.beginPath();
    for (let i = 0; i < coreS.length; i++) {
      const a = coreS[i];
      const b = coreS[(i * 7 + 3) % coreS.length];
      g.moveTo(a[0], a[1]);
      g.lineTo(b[0], b[1]);
    }
    g.stroke();
    // data arriving and leaving
    for (const pk of sph.packets) {
      const u = (t * pk.sp + pk.ph) % 1;
      const r = pk.out ? 1.05 + u * 0.6 : 1.65 - u * 0.6;
      const s = proj([pk.d[0] * r, pk.d[1] * r, pk.d[2] * r]);
      const a = Math.sin(u * Math.PI) * 0.6;
      g.strokeStyle = rgba(theme.c, a);
      g.strokeRect(s[0] - 7, s[1] - 3.5, 14, 7);
    }
    g.globalCompositeOperation = "source-over";
  }

  // --- the ribbons along the bottom -------------------------------------------

  function drawRibbons(g, w, h, t, theme, level) {
    g.globalCompositeOperation = "lighter";
    const base = h - 70;
    for (let k = 0; k < 4; k++) {
      const amp = 16 + k * 7 + level * 22;
      const sp = 0.25 + k * 0.08;
      const ph = k * 1.7;
      g.strokeStyle = rgba(k % 2 ? theme.b : theme.a, 0.22 - k * 0.03);
      g.lineWidth = 2 + (3 - k) * 0.8;
      g.beginPath();
      for (let x = 0; x <= w; x += 8) {
        const y =
          base +
          Math.sin(x * 0.006 + t * sp + ph) * amp +
          Math.sin(x * 0.017 - t * sp * 1.6 + ph) * amp * 0.35;
        if (x === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    }
    // sparks riding the first ribbon
    for (let i = 0; i < 160; i++) {
      const x = ((i * 97.3 + t * (30 + (i % 7) * 9)) % (w + 40)) - 20;
      const y =
        base + Math.sin(x * 0.006 + t * 0.25) * (16 + level * 22) + Math.sin(i * 12.9898) * 9;
      const a = 0.25 + 0.6 * Math.abs(Math.sin(i * 3.7 + t * 2));
      g.fillStyle = rgba(theme.ink, a * 0.5);
      g.fillRect(x, y, 1.6, 1.6);
    }
    g.globalCompositeOperation = "source-over";
  }

  // --- charts: a glowing line over the day ---------------------------------------

  let chartN = 0;
  function lineChart(values, opts = {}) {
    const v = values.map((x) => (x == null ? null : Number(x)));
    const real = v.filter((x) => x != null);
    if (real.length < 2) return `<div class="dk-empty">no reading</div>`;
    const W = 300;
    const H = opts.h ?? 70;
    const mn = opts.min ?? Math.min(...real);
    const mx = opts.max ?? Math.max(...real);
    const span = mx - mn || 1;
    const pts = v
      .map((x, i) =>
        x == null ? null : [(i / (v.length - 1)) * W, H - 6 - ((x - mn) / span) * (H - 14)],
      )
      .filter(Boolean);
    const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
    const id = `dkc${chartN++}`;
    const hour = opts.hour ?? -1;
    const mark =
      hour >= 0 && pts[hour]
        ? `<circle cx="${pts[hour][0]}" cy="${pts[hour][1]}" r="3.5" class="dk-now"/>`
        : "";
    const ticks = ["00", "06", "12", "18", "24"]
      .map(
        (t, i) =>
          `<text x="${(i / 4) * W}" y="${H + 12}" text-anchor="${i === 0 ? "start" : i === 4 ? "end" : "middle"}">${t}</text>`,
      )
      .join("");
    return `<svg viewBox="0 -4 ${W} ${H + 18}" class="dk-chart" preserveAspectRatio="none">
      <defs>
        <linearGradient id="${id}s" x1="0" x2="1"><stop offset="0" stop-color="var(--dk-c)"/><stop offset="0.55" stop-color="var(--dk-a)"/><stop offset="1" stop-color="var(--dk-b)"/></linearGradient>
        <linearGradient id="${id}f" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--dk-a)" stop-opacity="0.35"/><stop offset="1" stop-color="var(--dk-a)" stop-opacity="0"/></linearGradient>
        <filter id="${id}g"><feGaussianBlur stdDeviation="2.4"/></filter>
      </defs>
      <path d="${d}L${W},${H}L0,${H}Z" fill="url(#${id}f)"/>
      <path d="${d}" fill="none" stroke="url(#${id}s)" stroke-width="3" filter="url(#${id}g)" opacity="0.8"/>
      <path d="${d}" fill="none" stroke="url(#${id}s)" stroke-width="1.6"/>
      ${mark}${ticks}
    </svg>`;
  }

  // --- what each tab shows ----------------------------------------------------------

  const WMO = {
    0: "clear",
    1: "mostly clear",
    2: "partly cloudy",
    3: "overcast",
    45: "fog",
    48: "fog",
    51: "drizzle",
    53: "drizzle",
    55: "drizzle",
    61: "rain",
    63: "rain",
    65: "heavy rain",
    71: "snow",
    80: "showers",
    81: "showers",
    82: "heavy showers",
    95: "thunderstorms",
    96: "thunderstorms",
    99: "thunderstorms",
  };
  const aqiWord = (a) =>
    a == null
      ? ""
      : a <= 50
        ? "good"
        : a <= 100
          ? "moderate"
          : a <= 150
            ? "unhealthy for some"
            : a <= 200
              ? "unhealthy"
              : "very unhealthy";
  const tile = (big, small, sub = "") =>
    `<div class="dk-tile"><b>${big}</b><span>${small}</span>${sub ? `<i>${sub}</i>` : ""}</div>`;
  const panel = (title, body, extra = "") =>
    `<section class="dk-panel ${extra}"><h3>${title}</h3>${body}</section>`;
  const notYet = (what) => `<div class="dk-empty">${what}</div>`;

  /**
   * The city around the user: Esri's dark grey canvas tiles (no key; CARTO's
   * started asking for one), three by three at zoom 13, tinted to the theme by CSS, with a pulse where the
   * place is. Tiles are images, so a missing network is a dark panel.
   */
  function cityMap(place) {
    if (!place || typeof place.lat !== "number") return notYet("no place yet");
    const z = 13;
    const n = 2 ** z;
    const fx = ((place.lon + 180) / 360) * n;
    const lat = (place.lat * Math.PI) / 180;
    const fy = ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n;
    const tx = Math.floor(fx) - 1;
    const ty = Math.floor(fy) - 1;
    const tiles = [];
    for (let y = 0; y < 3; y++)
      for (let x = 0; x < 3; x++)
        tiles.push(
          `<img src="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${z}/${ty + y}/${tx + x}" alt="" style="left:${x * 256}px;top:${y * 256}px">`,
        );
    // the place within the 768-pixel square, as a fraction
    const px = ((fx - tx) * 256) / 768;
    const py = ((fy - ty) * 256) / 768;
    return `<div class="dk-map"><div class="dk-tiles-map" style="--px:${px};--py:${py}">${tiles.join("")}</div><i class="dk-pin" style="left:50%;top:50%"></i><small>Esri, HERE, Garmin, © OpenStreetMap</small></div>`;
  }

  function hourNow(w) {
    const h = new Date().getHours();
    return w?.hours?.findIndex((x) => Number(x.slice(0, 2)) === h) ?? -1;
  }

  const SOURCE = {
    mail: "mail",
    slack: "slack",
    telegram: "telegram",
    discord: "discord",
    whatsapp: "whatsapp",
    line: "line",
  };
  function ago(at) {
    const m = Math.round((Date.now() - at) / 60000);
    return m < 1
      ? "now"
      : m < 60
        ? `${m}m`
        : m < 1440
          ? `${Math.round(m / 60)}h`
          : `${Math.round(m / 1440)}d`;
  }
  function ringTiles(d) {
    const n = d?.health;
    if (!n)
      return notYet(
        d?.sources?.ring
          ? "the ring has not been read yet"
          : "no ring connected: ultrahuman_token.txt and your email in settings, or oura_token.txt",
      );
    const hrs =
      n.sleepMinutes != null
        ? `${Math.floor(n.sleepMinutes / 60)}h${String(Math.round(n.sleepMinutes % 60)).padStart(2, "0")}`
        : "–";
    return `<div class="dk-tiles">${tile(n.sleepScore != null ? Math.round(n.sleepScore) : "–", "sleep score")}${tile(hrs, "asleep")}${tile(n.hrv != null ? Math.round(n.hrv) : "–", "hrv")}${tile(n.recovery != null ? Math.round(n.recovery) : "–", "recovery")}</div>`;
  }
  function githubBody(g) {
    if (!g) return notYet("not read yet: is the gh CLI signed in?");
    const rows = [
      ...g.reviews.map(
        (p) =>
          `<li data-status="waiting"><span>${esc(p.title)}</span><i>review · ${esc(p.repo)}</i></li>`,
      ),
      ...g.mine.map(
        (p) =>
          `<li data-status="${p.checks === "fail" ? "failed" : p.checks === "pending" ? "working" : "idle"}"><span>${esc(p.title)}</span><i>${esc(p.checks)} · ${esc(p.repo)}#${p.number}</i></li>`,
      ),
    ];
    return rows.length
      ? `<ul class="dk-list">${rows.slice(0, 8).join("")}</ul>`
      : notYet("nothing waiting on you");
  }

  const TABS = {
    home(d) {
      const w = d?.weather;
      const left = [];
      const right = [];
      if (w) {
        const n = w.now;
        left.push(
          panel(
            `weather · ${esc(w.place.name)}`,
            `<div class="dk-tiles">
              ${tile(`${Math.round(n.temp)}°`, "now", WMO[n.code] ?? "")}
              ${tile(`${Math.round(n.feels)}°`, "feels like")}
              ${tile(`${Math.round(w.today.min)}–${Math.round(w.today.max)}°`, "today", `${w.today.rain}% rain`)}
              ${tile(n.aqi ?? "–", "air · us aqi", aqiWord(n.aqi))}
              ${tile(n.pm25 != null ? Math.round(n.pm25) : "–", "pm2.5")}
              ${tile(`${Math.round(n.uv * 10) / 10}`, "uv now")}
              ${tile(`${Math.round(n.humidity)}%`, "humidity")}
              ${tile(Math.round(n.wind), "wind km/h")}
            </div>`,
          ),
        );
        const hr = hourNow(w);
        left.push(panel("the whole day", lineChart(w.temp, { hour: hr, h: 90 }), "wide"));
        left.push(panel(`around you · ${esc(w.place.name)}`, cityMap(w.place), "map"));
        right.push(
          panel(`air quality · ${n.aqi ?? "–"} ${aqiWord(n.aqi)}`, lineChart(w.aqi, { hour: hr })),
        );
        right.push(panel("feels like", lineChart(w.feels, { hour: hr })));
        right.push(panel("uv", lineChart(w.uv, { hour: hr, min: 0 })));
        right.push(
          panel(`humidity · ${Math.round(n.humidity)}%`, lineChart(w.humidity, { hour: hr })),
        );
      } else left.push(panel("weather", notYet("not read yet: no network, or no place")));
      right.unshift(
        panel(
          "calendar",
          d?.agenda?.text
            ? `<p class="dk-text">${esc(d.agenda.text).slice(0, 420)}</p>`
            : notYet("nothing read from the calendar yet"),
        ),
      );
      return { left, right };
    },
    life(d) {
      const rem = (d?.reminders ?? []).slice().sort((a, b) => a.at - b.at);
      const todos = (d?.todos ?? []).slice().sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0));
      const left = [
        panel(
          `to-do · ${todos.filter((t) => !t.done).length} open`,
          todos.length
            ? `<ul class="dk-list">${todos
                .slice(0, 10)
                .map(
                  (t) =>
                    `<li class="${t.done ? "done" : ""}"><span>${esc(t.text)}</span><i>${t.done ? "done" : ""}</i></li>`,
                )
                .join("")}</ul>`
            : notYet("nothing on the list. Say “add … to my list”"),
        ),
        panel(
          "reminders",
          rem.length
            ? `<ul class="dk-list">${rem
                .slice(0, 6)
                .map(
                  (r) =>
                    `<li><span>${esc(r.text)}</span><i>${new Date(r.at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}</i></li>`,
                )
                .join("")}</ul>`
            : notYet("nothing to remember. Say “remind me to…”"),
        ),
      ];
      const right = [panel("the ring", ringTiles(d))];
      return { left, right };
    },
    comms(d) {
      const inbox = d?.inbox;
      const items = inbox?.items ?? [];
      const src = d?.sources ?? {};
      const left = [
        panel(
          `inbox · ${inbox ? esc(inbox.summary) : "not read"}`,
          items.length
            ? `<ul class="dk-list dk-inbox">${items
                .slice(0, 12)
                .map(
                  (m) =>
                    `<li><span><b>${esc(m.from)}</b> ${esc(String(m.text).slice(0, 90))}</span><i>${esc(SOURCE[m.source] ?? m.source)} · ${ago(m.at)}</i></li>`,
                )
                .join("")}</ul>`
            : notYet("nothing has arrived yet"),
        ),
      ];
      const chip = (on, name, how) =>
        `<li data-status="${on ? "working" : "idle"}"><span>${name}</span><i>${on ? "connected" : esc(how)}</i></li>`;
      const wa = d?.whatsapp;
      const waBody =
        wa?.phase === "scan" && wa.qr
          ? `<div class="dk-qr"><img src="${wa.qr}" alt="WhatsApp pairing code"/><p>On the phone: WhatsApp → Settings → Linked devices → Link a device, and scan this.</p></div>`
          : wa?.phase === "open"
            ? `<p class="dk-text">Linked. New messages arrive in the inbox; nothing is ever sent.</p><button class="dk-btn" data-wa="off">unlink</button>`
            : wa?.phase === "installing" || wa?.phase === "starting"
              ? `<p class="dk-text">${wa.phase === "installing" ? "Installing the bridge (a minute, once)…" : "Starting…"}</p>`
              : `${wa?.detail ? `<p class="dk-empty">${esc(wa.detail)}</p>` : ""}<button class="dk-btn" data-wa="on">link WhatsApp</button>`;
      const right = [
        panel(
          "sources",
          `<ul class="dk-list">
            ${chip(src.mail, "Mail", "the desk reads Gmail hourly")}
            ${chip(src.slack, "Slack", "slack_token.txt in the data folder")}
            ${chip(src.telegram, "Telegram", "telegram_token.txt (a bot)")}
            ${chip(src.discord, "Discord", "discord_token.txt (a bot)")}
            ${chip(wa?.phase === "open", "WhatsApp", "link it below")}
          </ul>`,
        ),
        panel("whatsapp", waBody),
      ];
      return { left, right };
    },
    work(d) {
      const ss = Object.values(d?.sessions ?? {});
      const left = [
        panel(
          "agents",
          ss.length
            ? `<ul class="dk-list">${ss
                .map(
                  (s) =>
                    `<li data-status="${esc(s.status)}"><span>${esc(s.label)}</span><i>${esc(
                      s.status === "working"
                        ? (s.current_tool || "working").toLowerCase()
                        : s.status,
                    )}</i></li>`,
                )
                .join("")}</ul>`
            : notYet("no agents running"),
        ),
        panel("github", githubBody(d?.github)),
      ];
      const usage = (d?.usage ?? []).filter((u) => u.windows?.length);
      const right = [
        panel(
          "limits",
          usage.length
            ? usage
                .map(
                  (u) =>
                    `<div class="dk-usage"><b>${esc(u.name)}</b>${u.windows
                      .map(
                        (w) =>
                          `<div class="dk-bar"><span>${esc(w.label)}</span><i style="width:${Math.round(clamp(w.used, 0, 1) * 100)}%"></i><em>${Math.round(w.used * 100)}%</em></div>`,
                      )
                      .join("")}</div>`,
                )
                .join("")
            : notYet("no limits read"),
        ),
      ];
      return { left, right };
    },
    you(d) {
      const n = d?.health;
      return {
        left: [panel("last night", ringTiles(d))],
        right: [
          panel(
            "today",
            n
              ? `<div class="dk-tiles">${tile(n.steps ?? "–", "steps")}${tile(n.recovery != null ? Math.round(n.recovery) : "–", "recovery")}${tile(n.restingHr != null ? Math.round(n.restingHr) : "–", "resting hr")}</div>`
              : notYet("no ring connected yet"),
          ),
        ],
      };
    },
  };

  // --- the world: where everything sits on the desk's canvas ---------------------------
  // World pixels, the sphere at 0,0. Kik's cards begin at board.WORK (the
  // Work area's card layer), below the Work area's own panels.
  const SPHERE = 1400;
  const AREAS = {
    life: { x: -1240, y: -1760, w: 1180, label: "life" },
    you: { x: 60, y: -1760, w: 1180, label: "you" },
    home: { x: -2560, y: -560, w: 1180, label: "home" },
    comms: { x: 1380, y: -560, w: 1180, label: "comms" },
    work: { x: -1300, y: 860, w: 2600, label: "work" },
  };

  // --- mount ---------------------------------------------------------------------------

  /**
   * The desk is Kikoe's home: one infinite canvas (board.js is its camera).
   * The neuron sphere is drawn in world space at the centre, the five areas
   * sit around it, Kik's cards land in Work. The HUD (the header, Kik's line,
   * the orb, the ribbons, the topic card, the dock) is fixed on the screen.
   */
  function mount(host) {
    const B = window.board;
    host.classList.add("desk");
    // the world: the sphere, then the areas (board.js puts the cards above them)
    const sphereC = document.createElement("canvas");
    sphereC.className = "dk-world-sphere";
    Object.assign(sphereC.style, {
      left: `${-SPHERE / 2}px`,
      top: `${-SPHERE / 2}px`,
      width: `${SPHERE}px`,
      height: `${SPHERE}px`,
    });
    B.layer("sphere").append(sphereC);
    const areaEls = {};
    const areasLayer = B.layer("areas");
    for (const [name, a] of Object.entries(AREAS)) {
      const el = document.createElement("section");
      el.className = "area";
      el.dataset.area = name;
      Object.assign(el.style, { left: `${a.x}px`, top: `${a.y}px`, width: `${a.w}px` });
      el.innerHTML = `<h2 class="area-label">${a.label}</h2><div class="area-cols"></div>`;
      areasLayer.append(el);
      areaEls[name] = el;
    }
    // the HUD
    const hud = document.createElement("div");
    hud.className = "dk-hud";
    hud.innerHTML = `
      <canvas class="dk-ribbons"></canvas>
      <header class="dk-top">
        <div class="dk-hello"><small>K I K</small><b data-k="hello"></b><span data-k="date"></span></div>
        <div class="dk-clock"><b data-k="time"></b><span data-k="wx"></span><button class="dk-theme" title="neon or ember">◐</button></div>
      </header>
      <div class="dk-topic" hidden></div>
      <nav class="dk-dock">
        ${["home", "life", "comms", "work", "you"]
          .map((t) => `<button data-area="${t}">${t}</button>`)
          .join("")}<button data-area="all" title="the whole desk">●</button>
      </nav>`;
    host.append(hud);
    const $ = (q) => hud.querySelector(q);
    const ribC = $(".dk-ribbons");
    const sg = sphereC.getContext("2d");
    const rg = ribC.getContext("2d");
    const topicEl = $(".dk-topic");
    const sph = makeSphere(0x4b494b);
    const S = {
      visible: false,
      theme: window.kikTheme?.get() ?? "neon",
      data: null,
      state: "idle",
      level: 0,
      levelTo: 0,
      levelAt: 0,
      t: 0,
      res: 0,
    };
    let raf = 0;
    let last = 0;
    let poll = 0;
    let topicTimer = 0;
    let fitted = false;

    // The palette is the design system's (tokens.css, theme.js); the
    // canvases draw with THEMES, the same colours as numbers.
    window.addEventListener("kik:theme", (e) => {
      S.theme = e.detail;
    });
    /** Every area's panels, from the last reading: real data, or what is not connected. */
    function render() {
      for (const [name, el] of Object.entries(areaEls)) {
        const out = (TABS[name] ?? TABS.home)(S.data);
        const cols = el.querySelector(".area-cols");
        const html = `<div class="area-col">${out.left.join("")}</div><div class="area-col">${out.right.join("")}</div>`;
        if (cols.dataset.html !== html) {
          cols.dataset.html = html;
          cols.innerHTML = html;
        }
      }
      const w = S.data?.weather;
      $('[data-k="wx"]').textContent = w
        ? `${Math.round(w.now.temp)}° ${WMO[w.now.code] ?? ""} · ${w.place.name}`
        : "";
    }
    function clock() {
      const d = new Date();
      const h = d.getHours();
      $('[data-k="time"]').textContent = d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      $('[data-k="date"]').textContent = d.toLocaleDateString([], {
        weekday: "long",
        day: "numeric",
        month: "long",
      });
      $('[data-k="hello"]').textContent =
        h < 5
          ? "Still up."
          : h < 12
            ? "Good morning."
            : h < 18
              ? "Good afternoon."
              : "Good evening.";
    }
    async function refresh() {
      try {
        S.data = (await window.room?.dashboard?.()) ?? S.data;
      } catch {
        /* keep the last reading */
      }
      render();
      // the first reading gives the areas their heights: frame the desk then
      if (!fitted) {
        fitted = true;
        requestAnimationFrame(() => B.fit(false));
      }
    }
    function size(c) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      return [w, h, dpr];
    }
    function frame(now) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - (last || now)) / 1000);
      last = now;
      S.t += reduce ? 0 : dt;
      if (S.t - S.levelAt > 0.25) S.levelTo = 0;
      S.level += (S.levelTo - S.level) * (1 - Math.exp(-14 * dt));
      const th = THEMES[S.theme] ?? THEMES.neon;
      // The sphere lives in the world: drawn only when on screen, at a
      // resolution that follows the zoom, so it is sharp up close and cheap
      // from far away.
      const cam = B.camera();
      const half = (SPHERE / 2) * cam.zoom;
      const on =
        cam.x + half > 0 && cam.x - half < cam.w && cam.y + half > 0 && cam.y - half < cam.h;
      if (on) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const res = Math.max(0.3, Math.min(1.5, Math.round(cam.zoom * dpr * 10) / 10));
        if (res !== S.res) {
          S.res = res;
          sphereC.width = Math.round(SPHERE * res);
          sphereC.height = Math.round(SPHERE * res);
        }
        sg.setTransform(res, 0, 0, res, 0, 0);
        sg.clearRect(0, 0, SPHERE, SPHERE);
        drawSphere(
          sg,
          sph,
          SPHERE,
          SPHERE,
          S.t,
          th,
          {
            level: S.level,
            speaking: S.state === "speaking",
            thinking: S.state === "thinking",
            listening: S.state === "listening",
          },
          { cx: SPHERE / 2, cy: SPHERE / 2, R: SPHERE * 0.3 },
        );
      }
      const [w2, h2, d2] = size(ribC);
      rg.setTransform(d2, 0, 0, d2, 0, 0);
      rg.clearRect(0, 0, w2, h2);
      drawRibbons(rg, w2, h2, S.t, th, S.level);
    }

    /** Fly to an area, or to the whole desk. */
    function go(name) {
      for (const b of hud.querySelectorAll(".dk-dock button"))
        b.classList.toggle("on", b.dataset.area === name);
      if (name === "all") return B.fit(true);
      const el = areaEls[name];
      if (!el) return;
      const r = B.worldRect(el);
      // Work is its panels and Kik's cards below them
      if (name === "work") {
        const cards = [...document.querySelectorAll(".work-layer .frame")].map(B.worldRect);
        const y1 = Math.max(r.y + r.h, ...cards.map((c) => c.y + c.h));
        const x1 = Math.max(r.x + r.w, ...cards.map((c) => c.x + c.w));
        return B.flyTo(r.x - 40, r.y - 60, x1 - r.x + 80, Math.min(y1 - r.y + 100, 2600));
      }
      B.flyTo(r.x - 40, r.y - 60, r.w + 80, r.h + 100);
    }

    hud.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.area) go(b.dataset.area);
      else if (b.classList.contains("dk-theme")) {
        window.kikTheme?.set(S.theme === "neon" ? "ember" : "neon");
      }
    });
    // buttons inside the areas (WhatsApp's link) are in the world
    areasLayer.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b?.dataset.wa) {
        b.disabled = true;
        void window.room?.whatsapp?.(b.dataset.wa === "on").then(() => setTimeout(refresh, 1500));
      }
    });
    const api = {
      show() {
        host.hidden = false;
        if (S.visible) return;
        S.visible = true;
        clock();
        render();
        void refresh();
        poll = setInterval(() => {
          clock();
          void refresh();
        }, 30000);
        last = 0;
        raf = requestAnimationFrame(frame);
      },
      hide() {
        S.visible = false;
        host.hidden = true;
        cancelAnimationFrame(raf);
        clearInterval(poll);
      },
      /** Fly to an area by name, or "all". */
      go,
      /** Something the desk shows changed (a message, a QR, GitHub): read it again. */
      changed() {
        if (S.visible) void refresh();
      },
      /** Kik's state: the sphere fires faster when thinking, swells when speaking. */
      state(state, label) {
        S.state = label === "thinking" ? "thinking" : state;
      },
      level(l) {
        S.levelTo = clamp(Number(l) || 0, 0, 1);
        S.levelAt = S.t;
      },
      /** A topic card under the header when a line carries a figure (Kik's line is the caption). */
      say(text, figure) {
        clearTimeout(topicTimer);
        if (!figure) return;
        topicEl.innerHTML = `<div class="dk-fig">${esc(figure.figure)}<small>${esc(figure.unit ?? "")}</small><i>${esc(figure.kicker ?? "")}</i></div><p>${esc(text)}</p>`;
        topicEl.hidden = false;
        topicEl.classList.remove("in");
        void topicEl.offsetWidth;
        topicEl.classList.add("in");
      },
      quiet() {
        clearTimeout(topicTimer);
        topicTimer = setTimeout(() => {
          topicEl.classList.remove("in");
          setTimeout(() => {
            if (!topicEl.classList.contains("in")) topicEl.hidden = true;
          }, 500);
        }, 5000);
      },
    };
    return api;
  }

  window.KikDesk = { mount };
})();

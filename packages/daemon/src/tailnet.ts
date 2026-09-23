/**
 * Tailscale: the phone away from home.
 *
 * The walkie listens on every interface, so a phone on the user's tailnet
 * already reaches it at the machine's 100.x address — with the self-signed
 * certificate's warning, since the certificate names that address too. The
 * better door is Tailscale Serve: the tailnet's own HTTPS name
 * (`machine.tailnet.ts.net`) with a real certificate, reachable only from
 * the user's own devices. A real certificate is what lets a phone skip the
 * warning, keep the microphone without doubt, and later take notifications.
 *
 * Kikoe never signs in to Tailscale and never changes anything but the one
 * serve rule it owns (HTTPS 443 → the walkie), and only while the setting
 * says so: off takes the rule down with the walkie, as off closes the socket.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface Tailnet {
  /** the daemon is up and this machine is on a tailnet */
  running: boolean;
  /** "wm.taile841c1.ts.net", without the trailing dot */
  dns: string;
  /** the machine's 100.x address */
  ip: string;
  /** HTTPS certificates are enabled for the tailnet (an admin console switch) */
  https: boolean;
  /** our serve rule is in place: 443 goes to the walkie */
  serving: boolean;
}

export const NO_TAILNET: Tailnet = {
  running: false,
  dns: "",
  ip: "",
  https: false,
  serving: false,
};

/** Where the CLI lives when it is not on the PATH. */
export function tailscaleBin(pathEnv = process.env.PATH ?? ""): string {
  const exts = process.platform === "win32" ? [".exe", ""] : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, `tailscale${ext}`);
      if (existsSync(p)) return p;
    }
  }
  for (const p of [
    "C:\\Program Files\\Tailscale\\tailscale.exe",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/bin/tailscale",
    "/usr/local/bin/tailscale",
  ]) {
    if (existsSync(p)) return p;
  }
  return "";
}

export type Run = (bin: string, args: string[]) => Promise<{ code: number; out: string }>;

const run: Run = (bin, args) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}` });
    });
  });

/** The serve target for the walkie: Serve speaks HTTPS to it and ignores its self-signed certificate. */
export function serveTarget(port: number): string {
  return `https+insecure://127.0.0.1:${port}`;
}

/** Read this machine's place on the tailnet, and whether our serve rule is up. */
export async function tailnetStatus(
  port: number,
  exec: Run = run,
  bin = tailscaleBin(),
): Promise<Tailnet> {
  if (!bin) return NO_TAILNET;
  const st = await exec(bin, ["status", "--json"]);
  if (st.code !== 0) return NO_TAILNET;
  let j: {
    BackendState?: string;
    Self?: { DNSName?: string; TailscaleIPs?: string[] };
    CertDomains?: string[] | null;
  };
  try {
    j = JSON.parse(st.out);
  } catch {
    return NO_TAILNET;
  }
  const running = j.BackendState === "Running";
  const dns = String(j.Self?.DNSName ?? "").replace(/\.$/, "");
  const ip = (j.Self?.TailscaleIPs ?? []).find((a) => /^100\./.test(a)) ?? "";
  const https = Array.isArray(j.CertDomains) && j.CertDomains.length > 0;
  let serving = false;
  if (running) {
    const sv = await exec(bin, ["serve", "status", "--json"]);
    serving = sv.code === 0 && sv.out.includes(`127.0.0.1:${port}`);
  }
  return { running, dns, ip, https, serving };
}

/**
 * Put the walkie behind Tailscale Serve, or take it down. Returns a line to
 * show: what happened, or what the user has to do (turning on HTTPS for the
 * tailnet is an admin console switch Kikoe cannot flip).
 */
export async function setServe(
  on: boolean,
  port: number,
  exec: Run = run,
  bin = tailscaleBin(),
): Promise<{ ok: boolean; said: string }> {
  if (!bin) return { ok: false, said: "Tailscale is not installed on this machine" };
  const args = on
    ? ["serve", "--bg", "--https=443", serveTarget(port)]
    : ["serve", "--https=443", "off"];
  const r = await exec(bin, args);
  if (r.code === 0)
    return { ok: true, said: on ? "served on your tailnet" : "taken off your tailnet" };
  // Serve has never been switched on for this tailnet: the CLI prints a link
  // to approve it and then waits (seen 2026-09-23; our timeout ends the wait).
  // The link is the answer, so it is what we show.
  const approve = /serve is not enabled|to enable, visit/i.test(r.out)
    ? /https:\/\/login\.tailscale\.com\/\S+/.exec(r.out)?.[0]
    : undefined;
  if (approve) return { ok: false, said: `approve Serve for your tailnet once: ${approve}` };
  if (/https.*(not enabled|disabled)|enable https|certificates?/i.test(r.out))
    return {
      ok: false,
      said: "turn on HTTPS for your tailnet first: login.tailscale.com/admin/dns, then HTTPS Certificates",
    };
  if (/access denied|operator|permission/i.test(r.out))
    return {
      ok: false,
      said: "Tailscale refused: run 'tailscale set --operator=%USERNAME%' once as admin",
    };
  return { ok: false, said: r.out.trim().split("\n")[0]?.slice(0, 160) || "Tailscale said no" };
}

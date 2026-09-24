/**
 * Kik's hands and eyes on this PC: `docs/OS.md`, rung L1.
 *
 * What it can do: list the open windows, bring one to the front, open an
 * app, type, press keys, read the buttons and fields of the window in front
 * (Windows UI Automation — the semantic tree, a few hundred tokens, where a
 * screenshot would be thousands and imprecise), and press one of them by
 * name.
 *
 * How: one long-lived PowerShell, fed a command at a time on stdin, each
 * answered on stdout as a JSON line after a marker. No native module — a
 * third one would be a third way for the installer to drop something and
 * the app to die quietly — and no new process per call, which costs 200 to
 * 500 ms each. Every script here is fixed; what the user said only ever
 * arrives as data (base64, decoded inside PowerShell), never as code.
 *
 * What it may do is not decided here: every write goes through the daemon's
 * `askPermission`, graded by `capability.ts`. This file is only the hands.
 */

import { type ChildProcess, spawn } from "node:child_process";

export interface Win {
  pid: number;
  name: string;
  title: string;
}
export interface Control {
  type: string;
  name: string;
}

/** SendKeys treats these as syntax; typed text has them wrapped in braces. */
export function sendKeysText(text: string): string {
  return text
    .replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`)
    .replace(/\r?\n/g, "{ENTER}")
    .replace(/\t/g, "{TAB}");
}

const NAMED: Record<string, string> = {
  enter: "{ENTER}",
  return: "{ENTER}",
  tab: "{TAB}",
  esc: "{ESC}",
  escape: "{ESC}",
  backspace: "{BACKSPACE}",
  delete: "{DELETE}",
  del: "{DELETE}",
  insert: "{INSERT}",
  up: "{UP}",
  down: "{DOWN}",
  left: "{LEFT}",
  right: "{RIGHT}",
  home: "{HOME}",
  end: "{END}",
  pageup: "{PGUP}",
  pagedown: "{PGDN}",
  space: " ",
};
const MOD: Record<string, string> = { ctrl: "^", control: "^", shift: "+", alt: "%" };

/**
 * A key as people name it, as SendKeys wants it: "ctrl+s" is "^s",
 * "alt+f4" is "%{F4}", "enter" is "{ENTER}". "" for a key it does not know,
 * so a guess is never pressed.
 */
export function sendKeysChord(spec: string): string {
  const parts = spec
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const key = parts.pop() ?? "";
  let mods = "";
  for (const p of parts) {
    const m = MOD[p];
    if (!m) return "";
    mods += m;
  }
  let k = NAMED[key] ?? "";
  if (!k && /^f([1-9]|1[0-2])$/.test(key)) k = `{${key.toUpperCase()}}`;
  if (!k && /^[a-z0-9]$/.test(key)) k = key;
  if (!k && key.length === 1) k = sendKeysText(key);
  if (!k) return "";
  // a modifier applies to the next key only; brace a multi-character one
  return mods ? `${mods}${k.length > 1 && !k.startsWith("{") ? `(${k})` : k}` : k;
}

/** Keys by name that only a virtual key code can press. */
const MEDIA: Record<string, number> = {
  play: 0xb3,
  pause: 0xb3,
  "play pause": 0xb3,
  "play/pause": 0xb3,
  next: 0xb0,
  "next track": 0xb0,
  previous: 0xb1,
  "previous track": 0xb1,
  prev: 0xb1,
  "stop music": 0xb2,
  mute: 0xad,
  unmute: 0xad,
  "volume up": 0xaf,
  louder: 0xaf,
  "volume down": 0xae,
  quieter: 0xae,
  "print screen": 0x2c,
};
const VK: Record<string, number> = {
  win: 0x5b,
  windows: 0x5b,
  ctrl: 0x11,
  control: 0x11,
  shift: 0x10,
  alt: 0x12,
  tab: 0x09,
  enter: 0x0d,
  esc: 0x1b,
  escape: 0x1b,
  space: 0x20,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
};

/**
 * A key that SendKeys cannot press, as virtual key codes: the media and
 * volume keys, and any chord with the Windows key ("win+d", "windows").
 * null for everything else, which goes by SendKeys.
 */
export function vkChord(spec: string): number[] | null {
  const s = spec.toLowerCase().trim();
  const media = MEDIA[s];
  if (media !== undefined) return [media];
  const parts = s
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.some((p) => p === "win" || p === "windows")) return null;
  const codes: number[] = [];
  for (const p of parts) {
    const c = VK[p] ?? (/^[a-z0-9]$/.test(p) ? p.toUpperCase().charCodeAt(0) : undefined);
    if (c === undefined) return null;
    codes.push(c);
  }
  return codes;
}

/** The PowerShell every command runs in: types loaded once, output in UTF-8. */
const PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "Add-Type -AssemblyName UIAutomationClient",
  "Add-Type -AssemblyName UIAutomationTypes",
  `Add-Type -Namespace Kik -Name U32 -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n); [DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p); [DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h); [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, System.UIntPtr e);'`,
].join("; ");

/** The fixed scripts. `$a` is the one argument, decoded from base64 inside PowerShell. */
const SCRIPTS = {
  windows:
    "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object { [pscustomobject]@{ pid = $_.Id; name = $_.ProcessName; title = $_.MainWindowTitle } }",
  front:
    "$h = [Kik.U32]::GetForegroundWindow(); $p = 0; [void][Kik.U32]::GetWindowThreadProcessId($h, [ref]$p); $x = Get-Process -Id $p; [pscustomobject]@{ pid = $x.Id; name = $x.ProcessName; title = $x.MainWindowTitle }",
  // Windows only lets a process that just had input take the foreground; a
  // tap of Alt is the documented way to be that process.
  focus:
    '$w = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.MainWindowTitle -like "*$a*" -or $_.ProcessName -like "*$a*") } | Select-Object -First 1; if (-not $w) { throw "no window like $a" }; $h = $w.MainWindowHandle; if ([Kik.U32]::IsIconic($h)) { [void][Kik.U32]::ShowWindow($h, 9) }; [Kik.U32]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [Kik.U32]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero); [void][Kik.U32]::SetForegroundWindow($h); [pscustomobject]@{ pid = $w.Id; name = $w.ProcessName; title = $w.MainWindowTitle }',
  // An app by name, resolved to a real program before anything starts: a
  // program on the PATH, then Windows' App Paths (chrome, spotify, word),
  // then a Start menu entry, Store apps included. Never a bare name handed to
  // the shell: from a Git Bash PATH "notepad" found Git's extensionless
  // script first and Windows asked "how do you want to open this?"
  // (2026-09-24), and the keys after it were typed into that dialog.
  open: String.raw`$exe = Get-Command $a -CommandType Application -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.exe', '.com' } | Select-Object -First 1; if ($exe) { Start-Process -FilePath $exe.Source; "started $($exe.Name)"; return }; foreach ($root in 'HKCU:', 'HKLM:') { $k = "$root\Software\Microsoft\Windows\CurrentVersion\App Paths\$a.exe"; if (Test-Path $k) { $p = ((Get-ItemProperty $k).'(default)' -replace '"', ''); if ($p -and (Test-Path $p)) { Start-Process -FilePath $p; "started $a"; return } } }; $s = Get-StartApps | Where-Object { $_.Name -like "*$a*" } | Select-Object -First 1; if (-not $s) { throw "no app called $a" }; Start-Process ("shell:AppsFolder\" + $s.AppID); "started $($s.Name)"`,
  keys: "[System.Windows.Forms.SendKeys]::SendWait($a); 'sent'",
  // Keys SendKeys cannot send: the Windows key, media and volume. Virtual
  // key codes, pressed in order and let go in reverse.
  vk: "$codes = @($a -split ','); foreach ($c in $codes) { [Kik.U32]::keybd_event([byte][int]$c, 0, 0, [UIntPtr]::Zero) }; [array]::Reverse($codes); foreach ($c in $codes) { [Kik.U32]::keybd_event([byte][int]$c, 0, 2, [UIntPtr]::Zero) }; 'sent'",
  // The whole screen, as a JPEG small enough for a card: 1280 wide, the
  // quality lowered until it fits.
  shot: "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $w = [Math]::Min(1280, $b.Width); $h = [int]($b.Height * $w / $b.Width); $s = New-Object System.Drawing.Bitmap $bmp, $w, $h; $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }; $p = New-Object System.Drawing.Imaging.EncoderParameters 1; $q = 70; do { $p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$q); $ms = New-Object IO.MemoryStream; $s.Save($ms, $enc, $p); $out = [Convert]::ToBase64String($ms.ToArray()); $q -= 15 } while ($out.Length -gt 190000 -and $q -gt 10); $g.Dispose(); $bmp.Dispose(); $s.Dispose(); 'data:image/jpeg;base64,' + $out",
  controls:
    "$root = [System.Windows.Automation.AutomationElement]::FromHandle([Kik.U32]::GetForegroundWindow()); $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition); $want = 'button','edit','menu item','hyperlink','list item','tab item','check box','combo box','radio button','document','text'; $seen = @{}; $out = @(); foreach ($e in $all) { $c = $e.Current; $t = $c.LocalizedControlType; if (-not $c.Name -or -not ($want -contains $t) -or $c.IsOffscreen) { continue }; $k = \"$t|$($c.Name)\"; if ($seen[$k]) { continue }; $seen[$k] = 1; $out += [pscustomobject]@{ type = $t; name = $c.Name.Substring(0, [Math]::Min(80, $c.Name.Length)) }; if ($out.Count -ge 80) { break } }; $out",
  // Press a control by its name: invoke it, toggle it, or select it,
  // whichever it supports. Nothing is clicked by coordinates.
  press:
    "$root = [System.Windows.Automation.AutomationElement]::FromHandle([Kik.U32]::GetForegroundWindow()); $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $a); $e = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond); if (-not $e) { $e = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.Name -like \"*$a*\" } | Select-Object -First 1 }; if (-not $e) { throw \"nothing called $a in this window\" }; $p = $null; if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); 'pressed' } elseif ($e.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); 'toggled' } elseif ($e.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); 'selected' } else { $e.SetFocus(); 'focused' }",
} as const;
export type Script = keyof typeof SCRIPTS;

const MARK = "@@KIK@@";

export interface HandsOptions {
  /** for tests: what starts the shell */
  spawnImpl?: (cmd: string, args: string[]) => ChildProcess;
  log?: (line: string) => void;
  /** one command longer than this is abandoned (and the shell restarted) */
  timeoutMs?: number;
}

/** One PowerShell, kept open; one command at a time. */
export class Hands {
  private ps: ChildProcess | null = null;
  private buffer = "";
  private seq = 0;
  private waiting = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly log: (line: string) => void;
  constructor(private readonly opts: HandsOptions = {}) {
    this.log = opts.log ?? (() => {});
  }

  private shell(): ChildProcess {
    if (this.ps && this.ps.exitCode === null && !this.ps.killed) return this.ps;
    const args = [
      "-NoProfile",
      "-NoLogo",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "-",
    ];
    const ps = (this.opts.spawnImpl ?? ((c, a) => spawn(c, a, { windowsHide: true })))(
      "powershell.exe",
      args,
    );
    ps.stdout?.setEncoding("utf8");
    ps.stdout?.on("data", (d: string) => this.read(d));
    ps.stderr?.on("data", (d: Buffer) => this.log(`hands: ${String(d).trim().slice(0, 300)}`));
    ps.on("exit", (code) => {
      this.log(`hands: shell exited (${code})`);
      for (const [, w] of this.waiting) w.reject(new Error("the shell went away"));
      this.waiting.clear();
      if (this.ps === ps) this.ps = null;
    });
    ps.stdin?.write(`${PRELUDE}\n`);
    this.ps = ps;
    return ps;
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf("\n");
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      nl = this.buffer.indexOf("\n");
      if (!line.startsWith(MARK)) continue;
      const rest = line.slice(MARK.length);
      const space = rest.indexOf(" ");
      const id = Number(rest.slice(0, space));
      const w = this.waiting.get(id);
      if (!w) continue;
      this.waiting.delete(id);
      try {
        const out = JSON.parse(rest.slice(space + 1) || "null") as { ok?: unknown; error?: string };
        if (out && typeof out === "object" && "error" in out && out.error)
          w.reject(new Error(out.error));
        else w.resolve((out as { ok?: unknown })?.ok ?? null);
      } catch (e) {
        w.reject(e as Error);
      }
    }
  }

  /** Run one fixed script with one argument; one at a time, in order. */
  run(script: Script, arg = ""): Promise<unknown> {
    const next = this.chain.then(() => this.send(script, arg));
    this.chain = next.catch(() => {});
    return next;
  }

  private send(script: Script, arg: string): Promise<unknown> {
    const ps = this.shell();
    const id = ++this.seq;
    const a = Buffer.from(arg, "utf8").toString("base64");
    const body = Buffer.from(SCRIPTS[script], "utf8").toString("base64");
    // One line: decode the argument, run the fixed script, answer after the mark.
    const line = `$a = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${a}')); try { $r = & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${body}')))); $o = @{ ok = @($r) } } catch { $o = @{ error = $_.Exception.Message } }; [Console]::Out.WriteLine('${MARK}${id} ' + ($o | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush()\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${script} took too long`));
        // a shell stuck on one command is stuck for all of them
        this.ps?.kill();
        this.ps = null;
      }, this.opts.timeoutMs ?? 15_000);
      this.waiting.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ps.stdin?.write(line);
    });
  }

  /** The open windows, front to back as Windows lists them. */
  async windows(): Promise<Win[]> {
    return ((await this.run("windows")) as Win[] | null) ?? [];
  }
  /** The window in front. */
  async front(): Promise<Win | null> {
    return (((await this.run("front")) as Win[] | null) ?? [])[0] ?? null;
  }
  /** Bring a window to the front by a piece of its title or its app's name. */
  async focus(match: string): Promise<Win | null> {
    return (((await this.run("focus", match)) as Win[] | null) ?? [])[0] ?? null;
  }
  async open(app: string): Promise<string> {
    return String((((await this.run("open", app)) as string[] | null) ?? [])[0] ?? "");
  }
  /** Type text into whatever has the focus. */
  async type(text: string): Promise<void> {
    await this.run("keys", sendKeysText(text));
  }
  /** Press a key or a chord ("ctrl+s", "enter"). Refuses a key it does not know. */
  async press(spec: string): Promise<void> {
    // the Windows key, media and volume go by virtual key; the rest by SendKeys
    const vk = vkChord(spec);
    if (vk) {
      await this.run("vk", vk.join(","));
      return;
    }
    const k = sendKeysChord(spec);
    if (!k) throw new Error(`I don't know the key "${spec}"`);
    await this.run("keys", k);
  }
  /** The screen, as a data: URL a card can show. */
  async screenshot(): Promise<string> {
    return String((((await this.run("shot")) as string[] | null) ?? [])[0] ?? "");
  }
  /** The named buttons, fields and links of the window in front. */
  async controls(): Promise<Control[]> {
    return ((await this.run("controls")) as Control[] | null) ?? [];
  }
  /** Press a control of the window in front by its name. */
  async pressControl(name: string): Promise<string> {
    return String((((await this.run("press", name)) as string[] | null) ?? [])[0] ?? "");
  }

  close(): void {
    this.ps?.kill();
    this.ps = null;
  }
}

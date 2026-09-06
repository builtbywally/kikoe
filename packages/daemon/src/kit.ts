/**
 * The artboard kit: the stylesheet every HTML artifact gets.
 *
 * An html pin runs in a sandboxed frame with an opaque origin and the
 * Room's content policy, so it can load nothing: no CDN, no fonts, no
 * framework. Without help the model's pages come out as browser defaults.
 * This is the help: the Room's tokens, good defaults for bare elements
 * (a `<button>` looks like a button, a `<table>` like a table), and a
 * small set of classes for product UI. Inlined into the page itself, so
 * open and download carry it too.
 */

export const KIT_MARK = "data-kikoe-kit";

export const KIT_CSS = `
:root{--bg:#14100e;--bg-2:#1c1815;--card:#181815;--line:rgba(245,241,236,.14);--line-2:rgba(245,241,236,.28);--fg:#f5f1ec;--muted:rgba(245,241,236,.6);--dim:rgba(245,241,236,.38);--accent:#d2683f;--accent-fg:#fff8f3;--ok:#7bb26b;--warn:#d9a441;--bad:#d4553f;--radius:12px;--radius-s:8px;--sans:"Instrument Sans","Segoe UI",system-ui,-apple-system,sans-serif;--serif:"Instrument Serif",Georgia,"Times New Roman",serif;--mono:"IBM Plex Mono",ui-monospace,Consolas,monospace;--shadow:0 18px 50px rgba(0,0,0,.45)}
[data-theme=light]{--bg:#f5f1ec;--bg-2:#eee8e1;--card:#fffcf9;--line:rgba(20,16,14,.14);--line-2:rgba(20,16,14,.28);--fg:#14100e;--muted:rgba(20,16,14,.62);--dim:rgba(20,16,14,.4);--shadow:0 18px 50px rgba(20,16,14,.16)}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--fg);font:15px/1.55 var(--sans);-webkit-font-smoothing:antialiased;padding:24px}
h1,h2,h3,h4{margin:0 0 .35em;line-height:1.15;letter-spacing:-.01em}
h1{font:400 34px/1.1 var(--serif)}h2{font:600 20px/1.2 var(--sans)}h3{font:600 16px/1.3 var(--sans)}h4{font:600 13px/1.3 var(--sans);color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
p{margin:0 0 .8em}p:last-child{margin-bottom:0}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
small,.muted{color:var(--muted)}.dim{color:var(--dim)}.mono,code,kbd,pre{font-family:var(--mono);font-size:.92em}
code{background:rgba(127,127,127,.15);padding:.1em .4em;border-radius:6px}
pre{background:var(--bg-2);border:1px solid var(--line);border-radius:var(--radius-s);padding:12px 14px;overflow:auto;margin:0 0 1em}
kbd{border:1px solid var(--line-2);border-bottom-width:2px;border-radius:6px;padding:.05em .45em;background:var(--bg-2)}
hr{border:0;border-top:1px solid var(--line);margin:20px 0}
img,svg,video{max-width:100%}
button,.btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:38px;padding:0 16px;border-radius:10px;border:1px solid var(--line-2);background:var(--bg-2);color:var(--fg);font:500 14px/1 var(--sans);cursor:pointer;transition:background .15s,border-color .15s,transform .05s;user-select:none}
button:hover,.btn:hover{border-color:var(--fg);background:var(--card)}button:active,.btn:active{transform:translateY(1px)}
button:disabled,.btn[aria-disabled=true]{opacity:.45;cursor:not-allowed}
.primary,button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}.primary:hover{filter:brightness(1.08);border-color:var(--accent)}
.ghost{background:transparent;border-color:transparent}.ghost:hover{background:var(--bg-2);border-color:var(--line)}
.danger{background:transparent;border-color:var(--bad);color:var(--bad)}.danger:hover{background:var(--bad);color:#fff}
.small,button.small{min-height:30px;padding:0 10px;font-size:12.5px}.big,button.big{min-height:46px;padding:0 22px;font-size:16px}
.block{display:flex;width:100%}
input,select,textarea{appearance:none;width:100%;min-height:40px;padding:8px 12px;border-radius:10px;border:1px solid var(--line-2);background:var(--bg-2);color:var(--fg);font:15px/1.4 var(--sans);outline:none;transition:border-color .15s,box-shadow .15s}
textarea{min-height:96px;resize:vertical}select{padding-right:32px;background-image:linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%);background-position:calc(100% - 16px) 50%,calc(100% - 11px) 50%;background-size:5px 5px;background-repeat:no-repeat}
input::placeholder,textarea::placeholder{color:var(--dim)}
input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(210,104,63,.25)}
input[type=checkbox],input[type=radio]{width:18px;height:18px;min-height:0;padding:0;accent-color:var(--accent);appearance:auto}
input[type=range]{appearance:auto;padding:0;border:0;background:transparent;accent-color:var(--accent);min-height:0}
label,.label{display:block;font:600 13px/1.3 var(--sans);color:var(--muted);margin-bottom:6px}
.field{margin-bottom:14px}.field .help{display:block;margin-top:6px;font-size:12.5px;color:var(--dim)}.field.invalid input{border-color:var(--bad)}.field .error{color:var(--bad);font-size:12.5px;margin-top:6px}
.check{display:flex;align-items:center;gap:10px;font:14px/1.3 var(--sans);color:var(--fg);margin:0}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:20px;box-shadow:var(--shadow)}
.card.flat{box-shadow:none}.card>h2:first-child,.card>h3:first-child{margin-top:0}
.card .head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
.stack{display:flex;flex-direction:column;gap:12px}.stack.tight{gap:6px}.stack.loose{gap:24px}
.row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.row.between{justify-content:space-between}.row.end{justify-content:flex-end}.row.center{justify-content:center}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}.grid.two{grid-template-columns:repeat(2,1fr)}.grid.three{grid-template-columns:repeat(3,1fr)}.grid.four{grid-template-columns:repeat(4,1fr)}
.container{max-width:920px;margin:0 auto}.narrow{max-width:460px;margin:0 auto}.wide{max-width:1200px;margin:0 auto}
.spread{flex:1}.right{text-align:right}.center{text-align:center}
.topbar{display:flex;align-items:center;gap:16px;padding:12px 0;margin-bottom:24px;border-bottom:1px solid var(--line)}.topbar .brand{font:600 16px/1 var(--sans);display:flex;align-items:center;gap:10px}.topbar nav{display:flex;gap:4px}.topbar nav a{padding:8px 12px;border-radius:8px;color:var(--muted)}.topbar nav a:hover,.topbar nav a.active{background:var(--bg-2);color:var(--fg);text-decoration:none}
.hero{padding:48px 0 32px}.hero h1{font-size:44px;max-width:14em}.hero p{font-size:18px;color:var(--muted);max-width:36em}
.badge{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;border:1px solid var(--line-2);font:500 12px/1.6 var(--sans);color:var(--muted)}.badge.ok{color:var(--ok);border-color:var(--ok)}.badge.warn{color:var(--warn);border-color:var(--warn)}.badge.bad{color:var(--bad);border-color:var(--bad)}.badge.accent{color:var(--accent);border-color:var(--accent)}
.dot{width:8px;height:8px;border-radius:50%;background:currentColor;display:inline-block}
.stat{display:flex;flex-direction:column;gap:4px}.stat .value{font:400 32px/1 var(--serif)}.stat .name{font:600 12px/1.3 var(--sans);color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{font:600 12px/1.3 var(--sans);color:var(--muted);text-transform:uppercase;letter-spacing:.06em}tr:hover td{background:rgba(127,127,127,.06)}td.num,th.num{text-align:right;font-family:var(--mono)}
ul,ol{margin:0 0 1em;padding-left:1.3em}li{margin:.25em 0}.list{list-style:none;padding:0;margin:0}.list li{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}.list li:last-child{border-bottom:0}
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin-bottom:16px}.tabs button,.tabs .tab{border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:var(--muted);padding:8px 12px;min-height:0;margin-bottom:-1px}.tabs .active,.tabs button.active{color:var(--fg);border-bottom-color:var(--accent)}
.progress{height:6px;border-radius:999px;background:var(--bg-2);overflow:hidden}.progress>i,.progress>div{display:block;height:100%;background:var(--accent);border-radius:999px}
.toggle{position:relative;width:40px;height:22px;border-radius:999px;background:var(--line-2);cursor:pointer;flex:none;transition:background .15s}.toggle::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:var(--fg);transition:left .15s}.toggle.on,.toggle[aria-checked=true]{background:var(--accent)}.toggle.on::after,.toggle[aria-checked=true]::after{left:21px}
.avatar{width:36px;height:36px;border-radius:50%;background:var(--accent);color:var(--accent-fg);display:inline-flex;align-items:center;justify-content:center;font:600 14px/1 var(--sans);flex:none}.avatar.big{width:64px;height:64px;font-size:24px;border-radius:18px}
.alert{padding:12px 14px;border-radius:var(--radius-s);border:1px solid var(--line-2);background:var(--bg-2)}.alert.ok{border-color:var(--ok)}.alert.warn{border-color:var(--warn)}.alert.bad{border-color:var(--bad)}
.divider{border-top:1px solid var(--line);margin:16px 0}
.timer,.display{font:400 64px/1 var(--serif);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (max-width:640px){body{padding:16px}.grid.two,.grid.three,.grid.four{grid-template-columns:1fr}.hero h1{font-size:32px}}
`.trim();

/** The page with the kit inlined, once. Leaves a page that already has it alone. */
export function withKit(html: string): string {
  if (html.includes(KIT_MARK)) return html;
  const style = `<style ${KIT_MARK}>${KIT_CSS}</style>`;
  const head = /<head[^>]*>/i.exec(html);
  if (head && head.index !== undefined)
    return `${html.slice(0, head.index + head[0].length)}\n${style}\n${html.slice(head.index + head[0].length)}`;
  const htmlTag = /<html[^>]*>/i.exec(html);
  if (htmlTag && htmlTag.index !== undefined)
    return `${html.slice(0, htmlTag.index + htmlTag[0].length)}\n<head>${style}</head>\n${html.slice(htmlTag.index + htmlTag[0].length)}`;
  return `${style}\n${html}`;
}

/** How the kit is described to the model, in the artifact tool. */
export const KIT_GUIDE =
  "HTML pages get the Kikoe kit stylesheet inlined automatically: bare elements already look right (button, input, select, textarea, table, h1 to h4, code, pre) and these classes make product UI: card (with .head), btn with primary | ghost | danger | small | big | block, field + label + help + error, check, stack | row (between, end) | grid (two, three, four), container | narrow | wide, topbar (with .brand and nav), hero, badge (ok, warn, bad, accent), stat (.value, .name), list, tabs (.active), progress (> i with a width), toggle (.on), avatar, alert (ok, warn, bad), timer for a big number. Tokens: --bg, --card, --fg, --muted, --accent, --ok, --warn, --bad, --radius. Dark by default; set data-theme=light on html for a light page. No external scripts, fonts or images (they are blocked); inline scripts run. Design it like a real product screen, not a demo: a clear hierarchy, one primary action, real copy, sensible empty and error states.";

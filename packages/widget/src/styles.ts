// Class names are short because this string ships verbatim in the bundle:
// w wrapper (l/r side, o open), b launcher (lg = shows the site logo), p panel, h header,
// n name, x close, m message list, g message group (u user / a assistant), t text bubble
// (md = rendered Markdown), li list row (in = nested), s sources, d typing dots, f footer, v voice input (on = listening), k send
// button, q note, sq starter questions, e contact form (er field row, ec small print, ee error line).
//
// Theme variables set on .w by ui.ts: --c accent, --t text on accent, --bg panel
// background, --fg text on the background, --lk link colour, --ff font family.
// Every other shade is mixed from --fg and --bg, so one pair themes the whole panel.
//
// Sizes are px, not rem: rem resolves against the host page's root font size,
// which the shadow boundary does not isolate. The 16px textarea on small screens
// stops iOS Safari zooming the page when the field takes focus.
export const CSS = `
:host{all:initial!important}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
.w{--c:#2563eb;--t:#fff;--bg:#fff;--fg:#111827;--lk:#1d4ed8;font:14px/1.45 var(--ff,system-ui),system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--fg);-webkit-text-size-adjust:100%}
button,textarea,input{font:inherit;color:inherit;margin:0}
button{cursor:pointer;border:0;padding:0;background:none}
:focus-visible{outline:2px solid var(--fg);outline-offset:2px;box-shadow:0 0 0 2px var(--bg)}
.b{position:fixed;bottom:20px;z-index:2147483000;width:56px;height:56px;border-radius:50%;background:var(--c);color:var(--t);display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,.25),inset 0 0 0 1px rgba(0,0,0,.08);transition:transform .15s}
.b:hover{transform:scale(1.06)}
.r .b{right:20px}
.l .b{left:20px}
.b svg{width:26px;height:26px}
.b img{width:34px;height:34px;border-radius:9px;object-fit:contain}
.b.lg{background:var(--bg);color:var(--fg);box-shadow:0 4px 14px rgba(0,0,0,.3),inset 0 0 0 2px var(--c)}
.b.lg svg:first-of-type{display:none}
.b[aria-expanded=true] svg:first-of-type,.b[aria-expanded=true] img,.b[aria-expanded=false] svg:last-of-type{display:none}
.p{position:fixed;bottom:88px;z-index:2147483001;width:380px;height:560px;max-width:calc(100vw - 40px);max-height:calc(100vh - 108px);display:flex;flex-direction:column;overflow:hidden;background:var(--bg);border:1px solid color-mix(in srgb,var(--fg) 16%,transparent);border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.28);animation:in .18s ease-out}
.r .p{right:20px}
.l .p{left:20px}
@keyframes in{from{opacity:0;transform:translateY(8px)}}
.h{flex:none;display:flex;align-items:center;gap:10px;padding:12px 12px 12px 14px;background:var(--c);color:var(--t);border-bottom:1px solid rgba(0,0,0,.08)}
.h img{flex:none;width:26px;height:26px;border-radius:7px;object-fit:contain}
.n{flex:1;min-width:0;font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.x{flex:none;width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center}
.x:hover{background:rgba(127,127,127,.3)}
.x:focus-visible{outline-color:currentColor;outline-offset:0;box-shadow:none}
.x svg,.k svg{width:18px;height:18px}
.m{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:10px;padding:14px;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--fg) 30%,transparent) transparent}
.g{max-width:88%;display:flex;flex-direction:column;gap:6px}
.u{align-self:flex-end}
.a{align-self:flex-start}
.t{padding:9px 12px;border-radius:14px;white-space:pre-wrap;overflow-wrap:anywhere}
.a .t{background:color-mix(in srgb,var(--fg) 9%,var(--bg));border-bottom-left-radius:4px}
.u .t{background:var(--c);color:var(--t);border-bottom-right-radius:4px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.08)}
.md{white-space:normal;display:flex;flex-direction:column;gap:8px}
.md p{margin:0}
.md a{color:var(--lk);text-decoration:underline}
.li{display:flex;gap:8px}
.in{margin-left:22px}
.li>span:first-child{flex:none;min-width:14px;font-variant-numeric:tabular-nums;color:color-mix(in srgb,var(--fg) 65%,var(--bg))}
.li>span:last-child{min-width:0}
code,pre{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:color-mix(in srgb,var(--fg) 12%,var(--bg));border-radius:5px}
code{padding:1px 5px}
pre{margin:0;padding:9px 11px;border-radius:8px;overflow-x:auto;white-space:pre;border:1px solid color-mix(in srgb,var(--fg) 12%,transparent)}
.s{display:flex;flex-direction:column;gap:3px;padding:0 4px;font-size:12px}
.s a{color:var(--lk);text-decoration:underline;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:3px}
.sq{display:flex;flex-wrap:wrap;gap:6px}
.sq button{max-width:100%;padding:6px 12px;border:1px solid color-mix(in srgb,var(--fg) 32%,transparent);border-radius:16px;background:var(--bg);color:var(--fg);font-size:13px;text-align:left;overflow-wrap:anywhere}
.sq button:hover{border-color:var(--c);background:color-mix(in srgb,var(--c) 12%,var(--bg))}
.e{display:flex;flex-direction:column;gap:6px;margin:0;padding:10px 12px;border:1px solid color-mix(in srgb,var(--fg) 22%,transparent);border-radius:12px;background:var(--bg);font-size:13px}
.er{display:flex;gap:6px}
input{flex:1;min-width:0;height:36px;padding:0 10px;border:1px solid color-mix(in srgb,var(--fg) 38%,transparent);border-radius:8px;background:var(--bg);color:var(--fg)}
.er button{flex:none;height:36px;padding:0 14px;border-radius:8px;background:var(--c);color:var(--t);font-weight:600;box-shadow:inset 0 0 0 1px rgba(0,0,0,.08)}
.er [aria-disabled]{opacity:.5;cursor:default}
.ec{font-size:11px;color:color-mix(in srgb,var(--fg) 60%,var(--bg))}
.ee{font-weight:600}
.ee:empty{display:none}
.d{display:inline-flex;gap:4px;padding:6px 0}
.d i{width:6px;height:6px;border-radius:50%;background:color-mix(in srgb,var(--fg) 55%,var(--bg));animation:bl 1.2s infinite both}
.d i:nth-child(2){animation-delay:.2s}
.d i:nth-child(3){animation-delay:.4s}
@keyframes bl{0%,80%,100%{opacity:.25}40%{opacity:1}}
.f{flex:none;display:flex;align-items:flex-end;gap:8px;padding:10px 12px 6px;border-top:1px solid color-mix(in srgb,var(--fg) 13%,transparent)}
textarea{flex:1;min-width:0;height:40px;max-height:112px;resize:none;padding:9px 12px;border:1px solid color-mix(in srgb,var(--fg) 38%,transparent);border-radius:10px;background:var(--bg);color:var(--fg);line-height:20px}
textarea::placeholder,input::placeholder{color:color-mix(in srgb,var(--fg) 55%,var(--bg))}
textarea:disabled{background:color-mix(in srgb,var(--fg) 6%,var(--bg))}
.k{flex:none;width:40px;height:40px;border-radius:10px;background:var(--c);color:var(--t);display:flex;align-items:center;justify-content:center;box-shadow:inset 0 0 0 1px rgba(0,0,0,.08)}
.k:disabled,.v:disabled{opacity:.5;cursor:default}
.v{flex:none;width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;border:1px solid color-mix(in srgb,var(--fg) 38%,transparent);color:color-mix(in srgb,var(--fg) 80%,var(--bg))}
.v svg{width:20px;height:20px}
.v.on{background:var(--c);color:var(--t);border-color:transparent;animation:pu 1.2s infinite}
@keyframes pu{50%{box-shadow:0 0 0 5px color-mix(in srgb,var(--c) 30%,transparent)}}
.q{flex:none;padding:0 12px 8px;font-size:11px;color:color-mix(in srgb,var(--fg) 60%,var(--bg));text-align:center}
@media (max-width:479px){
.w .p{inset:0;width:100%;height:100%;max-width:none;max-height:none;border:0;border-radius:0}
.w.o .b{display:none}
textarea,input{font-size:16px}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

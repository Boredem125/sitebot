// Class names are short because this string ships verbatim in the bundle:
// w wrapper (l/r side, o open), b launcher, p panel, h header, n name, x close,
// m message list, g message group (u user / a assistant), t text bubble, s sources,
// d typing dots, f footer, k send button, q note.
//
// Sizes are px, not rem: rem resolves against the host page's root font size,
// which the shadow boundary does not isolate. The 16px textarea on small screens
// stops iOS Safari zooming the page when the field takes focus.
export const CSS = `
:host{all:initial!important}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
.w{--c:#2563eb;--t:#fff;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#111827;-webkit-text-size-adjust:100%}
button,textarea{font:inherit;color:inherit;margin:0}
button{cursor:pointer;border:0;padding:0;background:none}
:focus-visible{outline:2px solid #111827;outline-offset:2px;box-shadow:0 0 0 2px #fff}
.b{position:fixed;bottom:20px;z-index:2147483000;width:56px;height:56px;border-radius:50%;background:var(--c);color:var(--t);display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,.25),inset 0 0 0 1px rgba(0,0,0,.08);transition:transform .15s}
.b:hover{transform:scale(1.06)}
.r .b{right:20px}
.l .b{left:20px}
.b svg{width:26px;height:26px}
.b[aria-expanded=true] svg:first-child,.b[aria-expanded=false] svg:last-child{display:none}
.p{position:fixed;bottom:88px;z-index:2147483001;width:360px;height:520px;max-width:calc(100vw - 40px);max-height:calc(100vh - 108px);display:flex;flex-direction:column;overflow:hidden;background:#fff;border:1px solid rgba(0,0,0,.1);border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.22);animation:in .18s ease-out}
.r .p{right:20px}
.l .p{left:20px}
@keyframes in{from{opacity:0;transform:translateY(8px)}}
.h{flex:none;display:flex;align-items:center;gap:8px;padding:12px 12px 12px 16px;background:var(--c);color:var(--t);border-bottom:1px solid rgba(0,0,0,.08)}
.n{flex:1;min-width:0;font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.x{flex:none;width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center}
.x:hover{background:rgba(127,127,127,.3)}
.x:focus-visible{outline-color:currentColor;outline-offset:0;box-shadow:none}
.x svg,.k svg{width:18px;height:18px}
.m{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:10px;padding:14px}
.g{max-width:85%;display:flex;flex-direction:column;gap:6px}
.u{align-self:flex-end}
.a{align-self:flex-start}
.t{padding:9px 12px;border-radius:14px;white-space:pre-wrap;overflow-wrap:anywhere}
.a .t{background:#f1f3f5;border-bottom-left-radius:4px}
.u .t{background:var(--c);color:var(--t);border-bottom-right-radius:4px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.08)}
.s{display:flex;flex-direction:column;gap:3px;padding:0 4px;font-size:12px}
.s a{color:#1d4ed8;text-decoration:underline;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:3px}
.d{display:inline-flex;gap:4px;padding:6px 0}
.d i{width:6px;height:6px;border-radius:50%;background:#6b7280;animation:bl 1.2s infinite both}
.d i:nth-child(2){animation-delay:.2s}
.d i:nth-child(3){animation-delay:.4s}
@keyframes bl{0%,80%,100%{opacity:.25}40%{opacity:1}}
.f{flex:none;display:flex;align-items:flex-end;gap:8px;padding:10px 12px 6px;border-top:1px solid #e5e7eb}
textarea{flex:1;min-width:0;height:40px;max-height:112px;resize:none;padding:9px 12px;border:1px solid #9ca3af;border-radius:10px;background:#fff;color:#111827;line-height:20px}
textarea::placeholder{color:#6b7280}
textarea:disabled{background:#f3f4f6}
.k{flex:none;width:40px;height:40px;border-radius:10px;background:var(--c);color:var(--t);display:flex;align-items:center;justify-content:center;box-shadow:inset 0 0 0 1px rgba(0,0,0,.08)}
.k:disabled{opacity:.5;cursor:default}
.q{flex:none;padding:0 12px 8px;font-size:11px;color:#6b7280;text-align:center}
@media (max-width:479px){
.w .p{inset:0;width:100%;height:100%;max-width:none;max-height:none;border:0;border-radius:0}
.w.o .b{display:none}
textarea{font-size:16px}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

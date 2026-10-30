/* Home Dashboard site menu. One <script src="nav.js"></script> per page draws the left-hand menu,
   highlights the current section and pushes the page over to make room. Self-contained styles,
   so it works on pages with different design tokens (ev.html, climate.html).
   Slim icon rail on tablets, full names on wide screens, a menu button on phones. */
(() => {
  const PAGES = [
    { id: 'dash', href: './', label: 'Dashboard', short: 'Home', match: ['', 'index.html', 'home.html'],
      icon: '<rect x="3" y="3" width="7.5" height="9" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="5.5" rx="1.5"/><rect x="13.5" y="11.5" width="7.5" height="9.5" rx="1.5"/><rect x="3" y="15" width="7.5" height="6" rx="1.5"/>' },
    { id: 'weather', href: 'weather.html', label: 'Weather', short: 'Weather', match: ['weather.html'],
      icon: '<circle cx="8.5" cy="8" r="3.2"/><path d="M8.5 1.8v1.4M2.8 8H1.4M4.4 3.9l1 1M12.6 3.9l-1 1"/><path d="M7 20h10.5a3.5 3.5 0 0 0 0-7 5 5 0 0 0-9.6 1.2A3 3 0 0 0 7 20z"/>' },
    { id: 'ev', href: 'ev.html', label: 'EV Charging', short: 'EV', match: ['ev.html', 'history.html', 'decisions.html'],
      icon: '<path d="M3.5 15.5v-3.2c0-.9.6-1.6 1.4-1.8l1.6-.4 2.2-3.2c.4-.6 1.1-.9 1.8-.9h3.4c.7 0 1.4.3 1.8.9l2.1 3.2 1.6.4c.9.2 1.6 1 1.6 1.9v3.1z"/><circle cx="7.5" cy="16" r="2"/><circle cx="16.5" cy="16" r="2"/><path d="M11.5 1.5l-1.6 3h3l-1.6 3"/>' },
    { id: 'energy', href: 'energy.html', label: 'Energy', short: 'Energy', match: ['energy.html', 'upload.html'],
      icon: '<path d="M13 2L4.5 13.5H11L10 22l8.5-11.5H12z"/>' },
    { id: 'climate', href: 'climate.html', label: 'Climate Control', short: 'Climate', match: ['climate.html'],
      icon: '<path d="M10 14.5V4a2 2 0 1 1 4 0v10.5a4 4 0 1 1-4 0z"/><path d="M12 9v8"/><path d="M17.5 6h3M17.5 10h2"/>' },
  ];
  const file = location.pathname.split('/').pop();
  const here = (PAGES.find(p => p.match.includes(file)) || {}).id;

  const css = `
  :root{--rail-w:72px}
  html.has-rail{padding-left:var(--rail-w)}
  .sh-rail{position:fixed;top:0;left:0;bottom:0;width:var(--rail-w);z-index:1500;display:flex;flex-direction:column;gap:4px;
    padding:calc(12px + env(safe-area-inset-top,0px)) 8px calc(12px + env(safe-area-inset-bottom,0px));
    background:#0d1220;border-right:1px solid rgba(255,255,255,.08);font-family:Inter,system-ui,-apple-system,'Segoe UI',sans-serif}
  .sh-brand{display:flex;align-items:center;justify-content:center;gap:10px;height:44px;margin-bottom:8px;color:#f5a623;text-decoration:none}
  .sh-brand svg{width:26px;height:26px;flex:none}
  .sh-brand b{display:none;font-size:15px;font-weight:700;letter-spacing:-.01em;color:#ecedf5;white-space:nowrap}
  .sh-item{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;min-height:58px;padding:6px 4px;border-radius:12px;
    color:#8890a8;text-decoration:none;font-size:10.5px;font-weight:600;letter-spacing:.02em;transition:background .15s,color .15s}
  .sh-item svg{width:22px;height:22px;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
  .sh-item:hover{background:rgba(255,255,255,.05);color:#ecedf5}
  .sh-item.on{background:rgba(0,212,166,.12);color:#00d4a6}
  .sh-item:focus-visible,.sh-burger:focus-visible{outline:2px solid #00d4a6;outline-offset:2px}
  .sh-item .full{display:none}
  .sh-burger{display:none}
  @media (min-width:1600px){
    :root{--rail-w:196px}
    .sh-rail{padding-left:12px;padding-right:12px}
    .sh-brand{justify-content:flex-start;padding:0 10px} .sh-brand b{display:block}
    .sh-item{flex-direction:row;justify-content:flex-start;gap:12px;min-height:46px;padding:0 12px;font-size:14px;font-weight:500;letter-spacing:0}
    .sh-item .short{display:none} .sh-item .full{display:inline}
  }
  @media (max-width:700px){
    :root{--rail-w:0px}
    .sh-rail{width:220px;transform:translateX(-100%);transition:transform .25s ease;box-shadow:0 0 40px rgba(0,0,0,.5)}
    .sh-rail .sh-item{flex-direction:row;justify-content:flex-start;gap:12px;min-height:48px;padding:0 12px;font-size:15px;font-weight:500}
    .sh-rail .sh-item .short{display:none} .sh-rail .sh-item .full{display:inline}
    .sh-brand{justify-content:flex-start;padding:0 10px} .sh-brand b{display:block}
    html.sh-open .sh-rail{transform:none}
    .sh-burger{display:grid;place-items:center;position:fixed;left:10px;bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:1499;width:48px;height:48px;border-radius:14px;
      background:#1a2137;border:1px solid rgba(255,255,255,.16);color:#ecedf5;box-shadow:0 6px 20px rgba(0,0,0,.4)}
    .sh-burger svg{width:22px;height:22px;stroke:currentColor;stroke-width:2;stroke-linecap:round;fill:none}
    .sh-scrim{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1498;opacity:0;visibility:hidden;transition:opacity .2s}
    html.sh-open .sh-scrim{opacity:1;visibility:visible}
  }
  @media print{ html.has-rail{padding-left:0} .sh-rail,.sh-burger{display:none} }`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const nav = document.createElement('nav');
  nav.className = 'sh-rail';
  nav.setAttribute('aria-label', 'Home Dashboard pages');
  nav.innerHTML = `<a class="sh-brand" href="./" aria-label="Home Dashboard"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></g></svg><b>Home Dashboard</b></a>` +
    PAGES.map(p => `<a class="sh-item${p.id === here ? ' on' : ''}" href="${p.href}"${p.id === here ? ' aria-current="page"' : ''} title="${p.label}"><svg viewBox="0 0 24 24" aria-hidden="true">${p.icon}</svg><span class="short">${p.short}</span><span class="full">${p.label}</span></a>`).join('');
  const burger = document.createElement('button');
  burger.className = 'sh-burger';
  burger.setAttribute('aria-label', 'Open menu');
  burger.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  const scrim = document.createElement('div');
  scrim.className = 'sh-scrim';
  const toggle = open => document.documentElement.classList.toggle('sh-open', open);
  burger.addEventListener('click', () => toggle(true));
  scrim.addEventListener('click', () => toggle(false));
  const mount = () => { document.body.prepend(scrim); document.body.prepend(burger); document.body.prepend(nav); document.documentElement.classList.add('has-rail'); };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();

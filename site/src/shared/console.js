// Console: the shared one-screen "inverted pyramid" dashboard shell (see docs/console.md for the full guide).
//
//   Overview (one equal tile per module)  →  topic (key numbers + one main view per sub-topic)  →  item (detail drawer)
//
// Desktop (≥ 1100px): left rail + one panel that fills the screen, no page scroll; level 3 opens in a drawer docked on
// the right and the view reflows beside it. Mobile (< 1100px): the page scrolls, the rail becomes sticky topic tabs, each
// topic shows sub-topic tabs, and the drawer is a bottom sheet. The URL hash mirrors the state as #topic/sub/item, so
// every level is linkable and the back button walks back up.
//
// ------------------------------------------------------------------ module contract
// A module is one topic (e.g. "ferry") with its own data, overview tile, sub-topics and drawers:
//   {
//     id: "ferry",                     // hash segment, data-topic value, unique on the page ("overview" is reserved)
//     title: "Island ferry",           // rail label (and document title)
//     color: "var(--ferry)",           // topic colour → --tc inside the module (dot, tile trim, active states)
//     eyebrow, heading,                // topic view header: small kicker + h1
//     tileTitle?,                      // tile name if different from title
//     load?(ctx) → Promise,            // lazy data load, called once on first use (or on idle prefetch)
//     badge?(ctx) → "1,234" | ["1,234", "tooltip"],     // rail badge (desktop)
//     kpis?(ctx) → [[label, value, sub?, attrs?], …],   // topic header summary strip
//     tile?(t, ctx),                   // overview tile; t = { el, vis, kpis(items), status(text) }
//                                      //   t.kpis([[value, label, extraNode?], …]); t.vis is a .chart that fills the tile
//     subs: [{ id, title, short?,      // level 2; short = tile link label
//              html,                   // pane markup (string, Node or (ctx) => either), built once at start
//              view?(host, ctx, route),// renders the pane each time it is shown or resized (host = the pane)
//              class?, rows?, cols? }],// pane class / desktop grid-template-rows / -columns
//     drawers?: { [subId]: (host, ctx, item) → spec | null },  // level 3, keyed by the sub-topic it opens from
//                                      //   spec = { kicker, title, body?: [Node…], after?() }; null = item not found
//     page?: true, separate?: true,    // a plain page (e.g. About): no tile/badge; separate = divider above in the rail
//   }
// A module without `subs` but with `html`/`view` is a single-pane topic routed as #id.
//
//   const cx = createConsole({ host, title, kicker, heading, note, modules, about, foot, ctx, onRoute });
//   cx.refresh()  re-render the visible view (call after live data arrives)    cx.go(topic, sub?, item?)  navigate
//   cx.route      current { topic, sub, item }                                  cx.ctx  the shared context
//
// ctx is the caller's shared state (e.g. { region, theme, skin }); the console adds ctx.route, ctx.theme ("light" |
// "dark"), ctx.skin (data-skin or ""), ctx.desktop (bool), ctx.go, ctx.href and ctx.refresh. Only the visible view renders;
// each module's load() runs on first use, and remaining modules prefetch when the browser is idle.
// Charts should size to their container (see ./charts.js frame()): the console re-renders the visible view whenever the
// main panel changes size (desktop: width or height; mobile: width only, as the page scrolls there).
// Styling: ./console.css (.cx-* classes, theme tokens only). A skin restyles it from its own CSS with higher-specificity
// selectors such as :root[data-skin="alt"] .cx-tile { … }.

import { el } from "./ui.js";

const DESKTOP = "(min-width: 1100px)";

/** "#topic/sub/item" for a route (item is URI-encoded). */
export const href = (topic, sub, item) => "#" + [topic, sub, item != null ? encodeURIComponent(item) : null].filter(Boolean).join("/");
/** Navigate to a route (no-op if already there). */
export const go = (topic, sub, item) => { const h = href(topic, sub, item); if (location.hash !== h) location.hash = h; };

// drawer building blocks (styled by console.css): a grid of big numbers, a chart slot, a short note, a link, a subheading
/** items: [[value, label], …]; four = a denser 4-up grid */
export const dStats = (items, four) => el("div", { class: four ? "cx-dstats four" : "cx-dstats" }, ...items.filter(Boolean).map(([v, l]) => el("div", {}, el("b", {}, v), el("span", {}, l))));
/** a titled .chart box (id) to draw into from spec.after() */
export const dChart = (id, title) => el("div", { class: "cx-dsec" }, el("h3", {}, title), el("div", { class: "chart cx-dchart", id }));
export const dNote = (text) => el("p", { class: "cx-dnote" }, text);
export const dLink = (h, text) => el("a", { class: "cx-dlink", href: h }, text, " →");
export const dHead = (text) => el("h3", { class: "cx-dsub-h" }, text);

const val = (v, ctx) => (typeof v === "function" ? v(ctx) : v);
function nodes(html, ctx) {
  const v = val(html, ctx);
  if (v == null) return [];
  if (v instanceof Node) return [v];
  const t = document.createElement("template");
  t.innerHTML = String(v);
  return [t.content];
}

export function createConsole({ host, title = document.title, kicker = "", heading = "", note = "", modules = [], about = null, foot = null,
  ctx = {}, onRoute = null, topbar = ".topbar", fullscreen = true, prefetch = true, tileCols = null } = {}) {
  host = typeof host === "string" ? document.querySelector(host) : host;
  const desktop = matchMedia(DESKTOP);
  const root = document.documentElement;
  const isDark = () => (root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);

  // ---------------------------------------------------------------- normalise modules
  const norm = (m) => {
    const single = !m.subs;
    const subs = single ? [{ id: "main", title: m.title, html: m.html, view: m.view, class: m.class, rows: m.rows, cols: m.cols }] : m.subs;
    return { ...m, single, subs, state: m.load ? null : "ready", error: null };
  };
  const mods = modules.map(norm);
  if (about) mods.push(norm({ id: "about", title: "About & method", page: true, separate: true, ...about }));
  const byId = new Map(mods.map((m) => [m.id, m]));
  const topics = mods.filter((m) => !m.page);

  // per-topic colours at zero specificity, and the overview dot (one slice per topic) just above .cx-dot, so page and
  // skin CSS can override both
  const style = document.createElement("style");
  style.dataset.cx = "";
  style.textContent = mods.filter((m) => m.color).map((m) => `:where([data-topic="${m.id}"]) { --tc: ${m.color}; }`).join("\n")
    + `\n:where(.cx-nav) [data-topic="overview"] .cx-dot { background: conic-gradient(${topics.map((m, i) =>
      `${m.color || "var(--muted)"} 0 ${((100 * (i + 1)) / topics.length).toFixed(2)}%`).join(", ")}); }`;
  document.head.prepend(style);

  // ---------------------------------------------------------------- DOM
  const state = { route: { topic: "overview", sub: null, item: null }, expanded: new Set(), drawerOpen: false };
  const navList = el("div", { class: "cx-nav-list" });
  const footEl = el("div", { class: "cx-foot" }, ...nodes(foot, ctx));
  const nav = el("nav", { class: "cx-nav", "aria-label": "Dashboard sections" }, navList, footEl);
  const main = el("main", { class: "cx-main", id: "main" });

  const ovKicker = el("div", { class: "eyebrow" });
  const ovH = el("h1", { id: "cx-overview-h", tabindex: "-1" });
  const ovNote = el("p", { class: "cx-head-note" });
  const tiles = el("div", { class: "cx-tiles" });
  const cols = tileCols || (topics.length <= 1 ? 1 : topics.length === 3 ? 3 : topics.length <= 4 ? 2 : 3);
  tiles.style.setProperty("--cx-tile-cols", cols);
  tiles.style.setProperty("--cx-tile-rows", Math.max(1, Math.ceil(topics.length / cols)));
  const overview = el("section", { class: "cx-view", "data-view": "overview", "aria-labelledby": ovH.id },
    el("header", { class: "cx-head cx-head-ov" }, el("div", { class: "cx-title" }, ovKicker, ovH), ovNote), tiles);
  main.append(overview);

  for (const m of topics) {
    const first = m.subs[0];
    const name = el("a", { class: "cx-tile-name", href: href(m.id, m.single ? null : first.id) }, m.tileTitle || m.title);
    const status = el("span", { class: "cx-tile-live", hidden: "" });
    const kp = el("div", { class: "cx-tile-kpis" });
    const vis = el("div", { class: "cx-tile-vis chart", id: `cx-tile-${m.id}` });
    const card = el("article", { class: "cx-tile", "data-topic": m.id, "data-href": name.getAttribute("href") },
      el("header", { class: "cx-tile-head" }, el("span", { class: "cx-tile-dot" }), name, status, el("span", { class: "cx-tile-go", "aria-hidden": "true" }, "→")),
      kp, vis,
      m.single ? null : el("footer", { class: "cx-tile-links" }, ...m.subs.map((s) => el("a", { href: href(m.id, s.id) }, s.short || s.title))));
    card.addEventListener("click", (e) => { if (e.target.closest("a, button, [data-pick]")) return; location.hash = card.dataset.href; });
    m.tileApi = {
      el: card, vis,
      kpis: (items) => kp.replaceChildren(...items.map(([v, l, extra]) =>
        el("div", { class: "cx-tk" }, el("b", { class: /\d/.test(v) ? null : "txt", title: v }, extra || null, v), el("span", {}, l)))),
      status: (text) => { status.textContent = text || ""; status.hidden = !text; },
    };
    tiles.append(card);
  }

  for (const m of mods) {
    const h1 = el("h1", { id: `${m.id}-h`, tabindex: "-1" }, m.heading || m.title);
    m.kpiEl = el("div", { class: "cx-kpis" });
    m.statusEl = el("p", { class: "note cx-status", hidden: "" });
    const head = el("header", { class: "cx-head" }, el("div", { class: "cx-title" }, el("div", { class: "eyebrow" }, m.eyebrow || m.title), h1), m.kpis ? m.kpiEl : null);
    const subtabs = m.single ? null : el("div", { class: "cx-subtabs", role: "navigation", "aria-label": `${m.title} sub-topics`, "data-for": m.id },
      ...m.subs.map((s) => el("a", { href: href(m.id, s.id), "data-sub": s.id }, s.title)));
    m.viewEl = el("section", { class: "cx-view", "data-view": m.id, "data-topic": m.page ? null : m.id, "aria-labelledby": h1.id, hidden: "" }, head, subtabs, m.statusEl);
    m.panes = new Map();
    for (const s of m.subs) {
      const pane = el("div", { class: ["cx-pane", s.class].filter(Boolean).join(" "), "data-sub": s.id, hidden: "" }, ...nodes(s.html, ctx));
      if (s.rows) pane.style.setProperty("--cx-rows", s.rows);
      if (s.cols) pane.style.setProperty("--cx-cols", s.cols);
      m.panes.set(s.id, pane);
      m.viewEl.append(pane);
    }
    m.subtabs = subtabs;
    main.append(m.viewEl);
  }

  const drKicker = el("div", { class: "eyebrow" });
  const drH = el("h2", { id: "cx-drawer-h", tabindex: "-1" });
  const drBody = el("div", { class: "cx-drawer-body" });
  const drX = el("button", { class: "icon-btn cx-drawer-x", type: "button", "aria-label": "Close detail" }, "✕");
  const drawer = el("aside", { class: "cx-drawer", "aria-labelledby": drH.id, hidden: "" },
    el("header", { class: "cx-drawer-head" }, el("div", {}, drKicker, drH), drX), drBody);
  main.append(drawer);

  host.classList.add("cx-app");
  host.replaceChildren(nav, main);
  if (fullscreen) document.body.classList.add("cx-body");

  // ---------------------------------------------------------------- rail
  navList.replaceChildren(...[{ id: "overview", title: "Overview", single: true }, ...mods].map((m) => {
    const leaf = m.single;
    const g = el("div", { class: `cx-group${leaf ? " cx-leaf" : ""}${m.page ? " cx-page" : ""}${m.separate ? " cx-sep" : ""}`, "data-topic": m.id });
    g.append(el("a", { class: "cx-topic", href: m.id === "overview" ? "#overview" : href(m.id, leaf ? null : m.subs[0].id) },
      el("span", { class: "cx-dot", "aria-hidden": "true" }), el("span", { class: "cx-label" }, m.title), el("span", { class: "cx-badge" })));
    if (!leaf) {
      const subs = el("ul", { class: "cx-subs", id: `cx-subs-${m.id}` }, ...m.subs.map((s) => el("li", {}, el("a", { href: href(m.id, s.id), "data-sub": s.id }, s.title))));
      const caret = el("button", { class: "cx-caret", type: "button", "aria-label": `Show ${m.title} sub-topics`, "aria-expanded": "false", "aria-controls": subs.id,
        onclick: () => { state.expanded.has(m.id) ? state.expanded.delete(m.id) : state.expanded.add(m.id); paintNav(); } });
      g.append(caret, subs);
    }
    if (byId.has(m.id)) byId.get(m.id).group = g;
    return g;
  }));

  function paintNav() {
    const r = state.route;
    for (const g of navList.children) {
      const t = g.dataset.topic, active = t === r.topic, open = active || state.expanded.has(t), m = byId.get(t);
      g.classList.toggle("active", active); g.classList.toggle("open", open);
      const top = g.querySelector(".cx-topic");
      if (active && (t === "overview" || m?.single)) top.setAttribute("aria-current", "page"); else top.removeAttribute("aria-current");
      g.querySelector(".cx-caret")?.setAttribute("aria-expanded", String(open));
      for (const a of g.querySelectorAll(".cx-subs a")) { if (active && a.dataset.sub === r.sub) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); }
    }
    for (const m of mods) for (const a of m.subtabs?.children || []) {
      if (m.id === r.topic && a.dataset.sub === r.sub) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    }
    if (!desktop.matches) { // keep the active topic tab and sub-topic tab in view inside their horizontal scrollers
      const reveal = (scroller, item) => { if (!scroller || !item) return;
        const l = item.offsetLeft - scroller.offsetLeft, rr = l + item.offsetWidth;
        if (l < scroller.scrollLeft + 12 || rr > scroller.scrollLeft + scroller.clientWidth - 12) scroller.scrollLeft = l - (scroller.clientWidth - item.offsetWidth) / 2; };
      reveal(navList, navList.querySelector(".cx-group.active"));
      const tabs = byId.get(r.topic)?.subtabs;
      reveal(tabs, tabs?.querySelector("[aria-current]"));
    }
  }

  // ---------------------------------------------------------------- routing
  function parse() {
    const [t, s, ...rest] = decodeURI(location.hash).replace(/^#\/?/, "").split("/");
    const m = byId.get(t);
    if (!m) return { topic: "overview", sub: null, item: null };
    if (m.single) return { topic: t, sub: "main", item: null };
    const ok = m.subs.some((x) => x.id === s);
    const item = ok && rest.length && rest[0] !== "" ? decodeURIComponent(rest.join("/")) : null;
    return { topic: t, sub: ok ? s : m.subs[0].id, item };
  }

  function applyRoute(userNav) {
    const prev = state.route;
    const r = (state.route = ctx.route = parse());
    const changedView = prev.topic !== r.topic || prev.sub !== r.sub;
    overview.hidden = r.topic !== "overview";
    for (const m of mods) {
      m.viewEl.hidden = m.id !== r.topic;
      if (m.id === r.topic) for (const [id, p] of m.panes) p.hidden = id !== r.sub;
    }
    host.dataset.route = r.topic;
    const m = byId.get(r.topic), sub = m && !m.single ? m.subs.find((x) => x.id === r.sub) : null;
    document.title = m ? `${m.title}${sub ? ` · ${sub.title}` : ""} · ${title}` : title;
    onRoute?.(r, ctx);
    paintNav();
    refresh();
    if (userNav && changedView) {
      (m ? m.viewEl : overview).querySelector("h1")?.focus({ preventScroll: true });
      if (!desktop.matches) window.scrollTo({ top: 0 });
    }
  }

  // ---------------------------------------------------------------- lazy loading
  let queued = false;
  const later = () => { if (queued) return; queued = true; queueMicrotask(() => { queued = false; refresh(); }); };
  function ensure(m) {
    if (m.state === "ready") return true;
    if (m.state == null) {
      m.state = "loading";
      Promise.resolve().then(() => m.load(ctx)).then(() => { m.state = "ready"; later(); },
        (err) => { m.state = "error"; m.error = err; console.error(`[console] ${m.id}:`, err); later(); });
    }
    return false;
  }
  const msg = (m) => (m.state === "error" ? `Could not load data: ${m.error?.message || m.error}` : "Loading…");

  // ---------------------------------------------------------------- render
  function refresh() {
    const r = state.route, m = byId.get(r.topic);
    ctx.desktop = desktop.matches;
    const ready = m ? ensure(m) : false;
    // the drawer is filled first so the view reflows around it (desktop) before its charts measure their panels
    const build = ready && r.item != null ? m.drawers?.[r.sub] : null;
    let spec = null;
    if (build) {
      drawer.hidden = false; drawer.dataset.topic = m.id; main.classList.add("cx-has-drawer");
      drBody.replaceChildren();
      spec = build(drBody, ctx, r.item) || null;
    }
    if (!spec) closeDrawer();
    else {
      drKicker.textContent = spec.kicker || ""; drH.textContent = spec.title || "";
      if (spec.body) drBody.replaceChildren(...spec.body.filter(Boolean));
    }

    if (!m) renderOverview();
    else {
      m.statusEl.hidden = ready; if (!ready) m.statusEl.textContent = msg(m);
      if (ready) {
        if (m.kpis) renderKpis(m.kpiEl, m.kpis(ctx) || []);
        const s = m.subs.find((x) => x.id === r.sub);
        s?.view?.(m.panes.get(s.id), ctx, r);
      }
    }
    paintBadges();
    if (spec) {
      spec.after?.();
      if (!state.drawerOpen) drH.focus({ preventScroll: true });
      state.drawerOpen = true;
      document.body.classList.add("cx-drawer-open");
    }
  }
  function closeDrawer() {
    drawer.hidden = true; main.classList.remove("cx-has-drawer"); document.body.classList.remove("cx-drawer-open");
    state.drawerOpen = false;
  }
  function renderOverview() {
    ovKicker.textContent = val(kicker, ctx) || ""; ovH.textContent = val(heading, ctx) || title; ovNote.textContent = val(note, ctx) || "";
    ovNote.hidden = !ovNote.textContent;
    for (const m of topics) {
      if (!m.tile) continue;
      if (ensure(m)) m.tile(m.tileApi, ctx);
      else { m.tileApi.kpis([]); m.tileApi.vis.replaceChildren(el("p", { class: "note cx-status" }, msg(m))); }
    }
  }
  function renderKpis(box, items) {
    box.replaceChildren(...items.map(([label, value, sub, attrs = {}]) =>
      el("div", { class: "cx-kpi", ...attrs }, el("div", { class: "cx-kpi-l" }, label),
        el("div", { class: /\d/.test(value) ? "cx-kpi-v" : "cx-kpi-v txt", title: value }, value), sub ? el("div", { class: "cx-kpi-s" }, sub) : null)));
  }
  function paintBadges() {
    for (const m of mods) {
      if (!m.badge || m.state !== "ready" || !m.group) continue;
      const b = m.group.querySelector(".cx-badge"), v = m.badge(ctx);
      const [text, tip] = Array.isArray(v) ? v : [v];
      b.textContent = text ?? ""; if (tip) b.title = tip;
    }
  }

  // ---------------------------------------------------------------- wiring
  drX.addEventListener("click", () => closeTo());
  const closeTo = () => { const r = state.route, m = byId.get(r.topic); go(r.topic, m?.single ? null : r.sub); };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !drawer.hidden) closeTo(); });
  const syncLook = () => { ctx.theme = isDark() ? "dark" : "light"; ctx.skin = root.dataset.skin || ""; };
  syncLook();
  window.addEventListener("skinchange", syncLook);
  window.addEventListener("themechange", () => { syncLook(); refresh(); });
  window.addEventListener("hashchange", () => applyRoute(true));

  const measure = () => { const tb = typeof topbar === "string" ? document.querySelector(topbar) : topbar; if (tb) root.style.setProperty("--cx-top", `${tb.offsetHeight}px`); };
  measure();
  let raf = 0, last = "";
  new ResizeObserver(([e]) => {
    const { width, height } = e.contentRect;
    const k = desktop.matches ? `${Math.round(width)}x${Math.round(height)}` : `${Math.round(width)}`;
    if (k === last) return; last = k; cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { measure(); refresh(); });
  }).observe(main);

  const api = {
    ctx, modules: mods, refresh, go, href,
    get route() { return state.route; },
  };
  Object.assign(ctx, { go, href, refresh, route: state.route, desktop: desktop.matches });
  applyRoute(false);
  if (prefetch) (window.requestIdleCallback || ((f) => setTimeout(f, 300)))(() => mods.forEach((m) => m.load && ensure(m)));
  return api;
}

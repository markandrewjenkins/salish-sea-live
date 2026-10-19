// Shared UI helpers: theme toggle, tooltip, formatting, data loading.

const THEME_KEY = "odp-theme";

export function initTheme(button) {
  const root = document.documentElement;
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved) root.dataset.theme = saved;
  } catch { /* storage unavailable */ }
  const isDark = () =>
    root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const paint = () => {
    if (!button) return;
    button.innerHTML = isDark()
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
    button.setAttribute("aria-label", isDark() ? "Switch to light theme" : "Switch to dark theme");
  };
  button?.addEventListener("click", () => {
    root.dataset.theme = isDark() ? "light" : "dark";
    try { localStorage.setItem(THEME_KEY, root.dataset.theme); } catch { /* ignore */ }
    paint();
    window.dispatchEvent(new CustomEvent("themechange"));
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    paint();
    window.dispatchEvent(new CustomEvent("themechange"));
  });
  paint();
  return isDark;
}

const SKIN_KEY = "odp-skin";

// Design skins: every page has its classic look and one themed alternative (data-skin="alt" on <html>).
// The choice is shared across pages so you can browse every alternative in one go.
export function initSkin(button) {
  const root = document.documentElement;
  const name = button?.dataset.skinName || "Alternative";
  const on = () => root.dataset.skin === "alt";
  const paint = () => {
    if (!button) return;
    button.replaceChildren(el("span", { class: "skin-dot", "aria-hidden": "true" }), el("span", {}, on() ? name : "Classic"));
    button.title = on() ? "Switch back to the classic design" : `Switch to the ${name} design`;
    button.setAttribute("aria-pressed", String(on()));
  };
  button?.addEventListener("click", () => {
    if (on()) delete root.dataset.skin; else root.dataset.skin = "alt";
    try { localStorage.setItem(SKIN_KEY, on() ? "alt" : "classic"); } catch { /* ignore */ }
    paint();
    window.dispatchEvent(new CustomEvent("skinchange"));
    window.dispatchEvent(new CustomEvent("themechange"));
  });
  paint();
  return on;
}

export const cssVar = (name, el = document.body) => getComputedStyle(el).getPropertyValue(name).trim();

// ---------- tooltip (one per page)
let tipEl;
export function tooltip() {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "tooltip";
    tipEl.setAttribute("role", "status");
    document.body.appendChild(tipEl);
  }
  return {
    show(x, y, build) {
      tipEl.replaceChildren();
      build(tipEl);
      tipEl.classList.add("on");
      const r = tipEl.getBoundingClientRect();
      const left = Math.min(window.innerWidth - r.width - 8, x + 14);
      const top = y + r.height + 20 > window.innerHeight ? y - r.height - 12 : y + 14;
      tipEl.style.left = `${Math.max(8, left)}px`;
      tipEl.style.top = `${Math.max(8, top)}px`;
    },
    hide() { tipEl.classList.remove("on"); },
  };
}

// Small DOM builder used for tooltips/legends so labels always go through textContent.
export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "style" && typeof v === "object") Object.assign(n.style, v);
    else if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

export const tipRow = (color, value, label) =>
  el("div", { class: "t-row" }, color ? el("i", { class: "t-key", style: { background: color } }) : null, el("b", {}, value), el("span", {}, label));

export async function loadJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

export const fmtInt = new Intl.NumberFormat("en-CA");

// Searchable checklist of tree types for a map side panel.
// items: [{ id, name, count, colour, tier }]; selected: Set of ids (mutated); onChange() after every edit.
// Rows toggle on click; "only" isolates a row; All / None act on the rows the search leaves visible.
export function treeList(host, items, selected, onChange, { placeholder = "Find a tree…" } = {}) {
  const rows = items.map((it) => {
    const box = el("input", { type: "checkbox", tabindex: "-1", "aria-hidden": "true" });
    const only = el("button", { type: "button", class: "tl-only", title: `Show only ${it.name}` }, "only");
    const row = el("li", { class: "tl-item", role: "option" },
      el("label", {}, box, el("i", { class: "tl-sw", style: { background: it.colour } }),
        el("span", { class: "tl-name" }, it.name), it.tier ? el("span", { class: `tl-tier tier-${it.tier}` }, it.tier) : null,
        el("span", { class: "tl-n" }, it.count ? fmtInt.format(it.count) : "0")), only);
    box.addEventListener("change", () => { box.checked ? selected.add(it.id) : selected.delete(it.id); paint(); onChange(); });
    only.addEventListener("click", () => { selected.clear(); selected.add(it.id); paint(); onChange(); });
    if (!it.count) row.classList.add("tl-zero");
    return { it, row, box };
  });
  const search = el("input", { type: "search", class: "tl-search", placeholder, "aria-label": placeholder });
  const visible = () => rows.filter((r) => !r.row.hidden);
  const bulk = (on) => { for (const r of visible()) on ? selected.add(r.it.id) : selected.delete(r.it.id); paint(); onChange(); };
  const summary = el("span", { class: "tl-summary" });
  const list = el("ul", { class: "tl-list", role: "listbox", "aria-multiselectable": "true" }, ...rows.map((r) => r.row));
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    for (const r of rows) r.row.hidden = q !== "" && !r.it.name.toLowerCase().includes(q);
  });
  function paint() {
    for (const r of rows) { r.box.checked = selected.has(r.it.id); r.row.setAttribute("aria-selected", String(r.box.checked)); }
    const on = rows.filter((r) => selected.has(r.it.id));
    summary.textContent = on.length === rows.length ? `All ${rows.length} shown` : `${on.length} of ${rows.length} shown`;
  }
  host.replaceChildren(
    el("div", { class: "tl-head" }, summary,
      el("span", { class: "tl-bulk" }, el("button", { type: "button", onclick: () => bulk(true) }, "All"), el("button", { type: "button", onclick: () => bulk(false) }, "None"))),
    search, list);
  paint();
  return { paint };
}


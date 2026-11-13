// Chart helpers for console dashboards (d3). Every chart sizes to its container's width AND height, so a card can
// give it whatever space the one-screen layout leaves: put the chart in a `.chart` element inside a `.cx-fill` card
// (desktop) and the console re-renders it on resize. On mobile `.cx-app .chart` gets a fixed height (console.css).
//
//   frame(target, margin, fallbackH) → { svg, g, iw, ih, width, height, host }   empty svg sized to the container
//   renderBars(target, rows, color, fmt, left?, { pick?, selected? })            horizontal bars; rows = [label, value, key?, title?]
//   renderHeat(target, cells, color, fmt, { pick?, selected? })                  weekday × hour heatmap; cells = [dow 0=Mon, hour, value]
//   renderHourBars(target, rows, color, overlay?, { compact?, hl?, unit?, max? })  columns per hour 6–23; rows = [{ h, v }]
//   renderCompare(target, rows, color, unit)                                     actual (bars) vs forecast (line); rows = [{ d: Date, o, p }]
//   gridY(g, y, iw, ih, fmt), colPath(), barPath(), yTicks(ih), axisClean        building blocks
// `target` is an element or an element id. `color` is a CSS custom property name such as "--ferry".
// pick(key) makes rows / cells clickable (typically ctx.go(topic, sub, key) to open a drawer); selected highlights one.

import * as d3 from "d3";
import { cssVar, tooltip, el, tipRow } from "./ui.js";

const tip = tooltip();
const $ = (t) => (typeof t === "string" ? document.getElementById(t) : t);
export const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const DOW_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const hourLbl = (h) => `${h % 12 || 12} ${h < 12 ? "am" : "pm"}`;
export const hShort = (h) => `${h % 12 || 12}${h < 12 ? "a" : "p"}`;
export const axisClean = (a) => a.select(".domain").remove();
const fmt0 = d3.format(",.0f");

export function frame(target, m, fallbackH = 220) {
  const host = $(target);
  const width = Math.max(160, host.clientWidth);
  const height = Math.max(40, host.clientHeight || fallbackH);
  host.replaceChildren();
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("width", width).attr("height", height);
  return { svg, g: svg.append("g").attr("transform", `translate(${m.l},${m.t})`), iw: width - m.l - m.r, ih: height - m.t - m.b, width, height, host };
}
export const colPath = (x0, w, y0, base, r = 3) => { const h = base - y0, rr = Math.min(r, h, w / 2);
  return h <= 0 ? "" : `M${x0},${base}V${y0 + rr}Q${x0},${y0} ${x0 + rr},${y0}H${x0 + w - rr}Q${x0 + w},${y0} ${x0 + w},${y0 + rr}V${base}Z`; };
export const barPath = (w, y0, h, r = 4) => { const rr = Math.min(r, w, h / 2); return `M0,${y0}H${w - rr}Q${w},${y0} ${w},${y0 + rr}V${y0 + h - rr}Q${w},${y0 + h} ${w - rr},${y0 + h}H0Z`; };
export const yTicks = (ih) => (ih < 110 ? 2 : ih < 200 ? 4 : 5);
export function gridY(g, y, iw, ih, fmt) {
  g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(yTicks(ih))).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(yTicks(ih)).tickFormat(fmt || null).tickSize(0).tickPadding(6)).call(axisClean);
}

// horizontal bars that share the container's height between rows; long labels are truncated (full text in a <title>)
export function renderBars(target, rows, color, fmt, left = 200, opt = {}) {
  const host = $(target);
  host.classList.add("bars"); host.style.setProperty("--rows", rows.length);
  const W = Math.max(160, host.clientWidth);
  left = Math.round(Math.min(left, Math.max(96, W * 0.48)));
  const m = { l: left, r: 62, t: 2, b: 2 };
  const { g, iw, ih } = frame(host, m, rows.length * 28 + 4);
  const rowH = Math.max(15, Math.min(40, ih / rows.length));
  const bh = Math.max(8, Math.min(16, rowH * 0.5));
  const x = d3.scaleLinear([0, d3.max(rows, (r) => r[1]) || 1], [0, iw]);
  const chars = Math.floor((left - 10) / 6.6);
  const hasSel = opt.selected != null && rows.some((r) => r[2] === opt.selected);
  const r_ = g.selectAll("g").data(rows).join("g").attr("transform", (_, i) => `translate(0,${i * rowH})`)
    .attr("class", (r) => (opt.pick ? "brow pick" : "brow") + (hasSel ? (r[2] === opt.selected ? " on" : " off") : ""));
  if (opt.pick) {
    r_.attr("tabindex", 0).attr("role", "button").attr("aria-label", (r) => `${r[0]}: ${fmt(r[1])}`)
      .on("click", (e, r) => opt.pick(r[2]))
      .on("keydown", (e, r) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); opt.pick(r[2]); } });
    r_.append("rect").attr("class", "hit").attr("x", -left).attr("width", left + iw + m.r).attr("height", rowH).style("fill", "transparent");
  }
  r_.append("text").attr("class", "label").attr("x", -10).attr("y", rowH / 2).attr("dy", "0.35em").attr("text-anchor", "end")
    .style("font-size", rowH < 20 ? "11px" : null)
    .text((r) => (r[0].length > chars ? r[0].slice(0, chars - 1) + "…" : r[0])).append("title").text((r) => r[3] || r[0]);
  r_.append("path").attr("d", (r) => barPath(Math.max(2, x(r[1])), (rowH - bh) / 2, bh)).style("fill", `var(${color})`);
  r_.append("text").attr("class", "label strong").attr("x", (r) => x(r[1]) + 6).attr("y", rowH / 2).attr("dy", "0.35em").style("font-size", "11px").text((r) => fmt(r[1]));
}

// weekday × hour (5 am – midnight) heatmap; pick(dow, hour) — the conventional item key is `${dow}-${hour}`
export function renderHeat(target, cells, color, fmt, opt = {}) {
  const data = cells.map(([d_, h, v]) => ({ d: d_, h, v })).filter((c) => c.h >= 5);
  const m = { l: 36, r: 8, t: 6, b: 22 };
  const { g, iw, ih } = frame(target, m, 210);
  const x = d3.scaleBand(d3.range(5, 24), [0, iw]).padding(0.06);
  const y = d3.scaleBand(d3.range(7), [0, ih]).padding(0.08);
  const c = d3.scaleSequential([0, d3.max(data, (r) => r.v)], d3.interpolateRgb(cssVar("--surface-2"), cssVar(color)));
  const selKey = opt.selected;
  const cell = g.selectAll("rect").data(data).join("rect").attr("x", (r) => x(r.h)).attr("y", (r) => y(r.d)).attr("width", x.bandwidth()).attr("height", y.bandwidth()).attr("rx", 3)
    .style("fill", (r) => c(r.v))
    .attr("class", (r) => (`${r.d}-${r.h}` === selKey ? "hcell on" : "hcell"))
    .on("pointermove", (e, r) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `${DOW[r.d]} ${hourLbl(r.h)}`), tipRow(cssVar(color), fmt(r.v), ""))))
    .on("pointerleave", () => tip.hide());
  if (opt.pick) cell.style("cursor", "pointer").on("click", (e, r) => { tip.hide(); opt.pick(r.d, r.h); });
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickFormat((d_) => DOW[d_]).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickValues(d3.range(6, 24, 3)).tickFormat(hShort).tickSize(0).tickPadding(6)).call(axisClean);
}

// columns for each hour 6 am – 11 pm, with an optional dashed overlay line (e.g. the forecast) and one highlighted hour
export function renderHourBars(target, rows, color, overlay, opt = {}) {
  const m = { l: opt.compact ? 30 : 40, r: 8, t: 8, b: 22 };
  const { g, iw, ih } = frame(target, m, 200);
  const x = d3.scaleBand(d3.range(6, 24), [0, iw]).padding(0.2);
  const y = d3.scaleLinear().domain([0, opt.max || d3.max([...rows.map((r) => r.v), ...(overlay || []).map((r) => r.v)]) || 1]).nice().range([ih, 0]);
  gridY(g, y, iw, ih, d3.format("~s"));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickValues(d3.range(6, 24, 3)).tickFormat(hShort).tickSize(0).tickPadding(6)).call(axisClean);
  const bw = Math.min(28, x.bandwidth());
  g.selectAll("path.b").data(rows.filter((r) => r.h >= 6)).join("path").attr("class", "b").attr("d", (r) => colPath(x(r.h) + (x.bandwidth() - bw) / 2, bw, y(r.v), ih))
    .style("fill", `var(${color})`).style("opacity", (r) => (opt.hl != null && r.h !== opt.hl ? 0.45 : 1))
    .on("pointermove", (e, r) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `${r.h % 12 || 12}:00 ${r.h < 12 ? "am" : "pm"}`), tipRow(cssVar(color), fmt0(r.v), opt.unit || "riders"))))
    .on("pointerleave", () => tip.hide());
  if (overlay) g.append("path").datum(overlay.filter((r) => r.h >= 6)).attr("d", d3.line().x((r) => x(r.h) + x.bandwidth() / 2).y((r) => y(r.v)).curve(d3.curveMonotoneX))
    .style("fill", "none").style("stroke", "var(--ink)").style("stroke-width", 2).style("stroke-dasharray", "4 3");
}

// actual values as translucent daily bars with the forecast as a line, for back-tests
export function renderCompare(target, rows, color, unit = "riders") {
  const m = { l: 44, r: 10, t: 10, b: 22 };
  const { svg, g, iw, ih } = frame(target, m, 240);
  const x = d3.scaleTime(d3.extent(rows, (r) => r.d), [0, iw]);
  const y = d3.scaleLinear().domain([0, d3.max(rows, (r) => Math.max(r.o, r.p))]).nice().range([ih, 0]);
  gridY(g, y, iw, ih, d3.format("~s"));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(Math.max(3, Math.floor(iw / 110))).tickSize(0).tickPadding(6)).call(axisClean);
  const bw = Math.max(1, iw / rows.length - 1);
  g.selectAll("rect").data(rows).join("rect").attr("x", (r) => x(r.d) - bw / 2).attr("width", bw).attr("y", (r) => y(r.o)).attr("height", (r) => ih - y(r.o)).style("fill", `var(${color})`).style("opacity", 0.35);
  g.append("path").datum(rows).attr("d", d3.line().x((r) => x(r.d)).y((r) => y(r.p))).style("fill", "none").style("stroke", "var(--ink)").style("stroke-width", 1.5);
  svg.on("pointermove", (e) => { const [px] = d3.pointer(e, g.node()); const r = rows[d3.bisector((q) => q.d).center(rows, x.invert(px))];
    tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, d3.timeFormat("%a %b %-d, %Y")(r.d)), tipRow(cssVar(color), fmt0(r.o), `actual ${unit}`), tipRow(cssVar("--ink"), fmt0(r.p), "forecast"))); })
    .on("pointerleave", () => tip.hide());
}

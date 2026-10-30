// lib/agent-marketing-article-fetch-lib.js — Netlify (shared). Can the approved article actually be read? (Oct 30, 2026)
//
// Sam's rule: Claude reads the whole article for its perspective, so an article we cannot read is no use. Two moments:
//   research time: checkReadable() / readabilityFilter() keep only topics whose article page loads and holds real article text (no paywall,
//                  no bot wall, no "enable JavaScript" shell); an unreadable article is dropped.
//   script time:   fetchArticle() returns the text for the planner to read (the planner is told what the article may and may not give).
// The fetch is plain HTTPS from the Netlify function. Only public https URLs are fetched (no localhost, private ranges or odd ports), the page is
// capped in size and time, and nothing is stored: the text is read for the script and not kept.
"use strict";

const MAX_BYTES = 1500000;
const TIMEOUT_MS = 8000;
const MIN_WORDS = 150;          // fewer readable words than this is a stub, a paywall teaser or a script-rendered shell
const MAX_TEXT_CHARS = 14000;   // what the planner is given; enough for a long blog post, bounded for cost
const UA = "Mozilla/5.0 (compatible; SmartStageProBot/1.0; +https://smartstagepro.com)";

// "Subscribe to keep reading", bot walls and script shells. Checked on the extracted text, not the markup.
const WALL = /\b(?:subscribe to (?:continue|keep) reading|already a subscriber|sign in to (?:read|continue)|log ?in to (?:read|continue)|create a free account to (?:read|continue)|you(?:'| ha)ve reached your (?:free )?(?:article )?limit|this content is (?:for|available to) (?:subscribers|members)|enable javascript|javascript is (?:required|disabled)|verify you are (?:a )?human|are you a robot|unusual traffic|access denied|request blocked|captcha)\b/i;

/** True for a hostname that is a public site (not localhost, an IP literal in a private range, or an internal name). */
function isPublicHost(host) {
  const h = String(host || "").toLowerCase();
  if (!h || h === "localhost" || !h.includes(".") || /\.(?:local|internal|lan|localdomain)$/.test(h)) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return false; // an IPv4 literal is never an article site
  if (h.includes(":") || h.startsWith("[")) return false; // IPv6 literal
  return true;
}

/** safeUrl(url) → URL | null: https only, public host, default port. */
function safeUrl(u) {
  try {
    const x = new URL(String(u || ""));
    if (x.protocol !== "https:" || (x.port && x.port !== "443") || x.username || x.password || !isPublicHost(x.hostname)) return null;
    return x;
  } catch (e) { return null; }
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…" };
const decode = (s) => String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " "; }
  return Object.prototype.hasOwnProperty.call(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : " ";
});

/** The readable article text of an HTML page: the <article> (or <main>) body when there is one, without scripts, menus or footers. */
function htmlToText(html) {
  let h = String(html || "");
  h = h.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|svg|template|iframe|form|nav|footer|header|aside|button)\b[\s\S]*?<\/\1>/gi, " ");
  const body = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(h) || /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(h);
  if (body && body[1].replace(/<[^>]*>/g, " ").split(/\s+/).filter(Boolean).length >= MIN_WORDS) h = body[1];
  h = h.replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote|section)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, " ");
  return decode(h).replace(/[ \t\f\v ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const wordCount = (t) => (String(t || "").match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) || []).length;

/**
 * fetchArticle(url, { fetchFn, timeoutMs }) → { ok, text?, reason? }
 * reason is one of: bad_url, blocked (HTTP 4xx/5xx), not_html, too_big, timeout, error, too_short, wall.
 */
async function fetchArticle(url, opts) {
  const o = opts || {};
  const u = safeUrl(url);
  if (!u) return { ok: false, reason: "bad_url" };
  const f = o.fetchFn || (typeof fetch === "function" ? fetch : null);
  if (!f) return { ok: false, reason: "error" };
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), o.timeoutMs || TIMEOUT_MS) : null;
  try {
    const res = await f(u.href, { method: "GET", redirect: "follow", headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" }, ...(ctl ? { signal: ctl.signal } : {}) });
    if (!res || !res.ok) return { ok: false, reason: "blocked" };
    // a redirect must still land on a public https page
    if (res.url && !safeUrl(res.url)) return { ok: false, reason: "bad_url" };
    const type = String((res.headers && res.headers.get && res.headers.get("content-type")) || "text/html");
    if (!/html|xml|text\/plain/i.test(type)) return { ok: false, reason: "not_html" };
    const len = Number(res.headers && res.headers.get && res.headers.get("content-length"));
    if (Number.isFinite(len) && len > MAX_BYTES) return { ok: false, reason: "too_big" };
    const raw = await res.text();
    if (raw.length > MAX_BYTES) return { ok: false, reason: "too_big" };
    const text = /text\/plain/i.test(type) ? raw.trim() : htmlToText(raw);
    if (wordCount(text) < MIN_WORDS) return { ok: false, reason: WALL.test(text) || WALL.test(raw.slice(0, 20000)) ? "wall" : "too_short" };
    // a real article can mention "subscribe" in its footer; a wall replaces the body, so only a short page with a wall phrase is a wall
    if (wordCount(text) < 400 && WALL.test(text)) return { ok: false, reason: "wall" };
    return { ok: true, text: text.slice(0, MAX_TEXT_CHARS) };
  } catch (e) {
    return { ok: false, reason: e && e.name === "AbortError" ? "timeout" : "error" };
  } finally { if (timer) clearTimeout(timer); }
}

/** The article a web topic rests on: its first usable source. */
function primaryUrl(topic) {
  const s = topic && Array.isArray(topic.sources) ? topic.sources.find((x) => x && x.url) : null;
  return s ? s.url : null;
}

/**
 * readabilityFilter(topics, { fetchFn }) → { kept: topic[], dropped: [{ id, url, reason }] }
 * Web topics need a readable article; a topic that does not come from a web article (the agent's own report) is always kept.
 * Fetches run together (a handful of pages), each bounded by the timeout.
 */
async function readabilityFilter(topics, opts) {
  const list = Array.isArray(topics) ? topics : [];
  const checked = await Promise.all(list.map(async (t) => {
    if (!t || t.origin !== "web") return { t, ok: true };
    const url = primaryUrl(t);
    if (!url) return { t, ok: false, url: "", reason: "no_url" };
    const r = await fetchArticle(url, opts);
    return { t, ok: r.ok, url, reason: r.reason };
  }));
  return { kept: checked.filter((c) => c.ok).map((c) => c.t), dropped: checked.filter((c) => !c.ok).map((c) => ({ id: c.t && c.t.id, url: c.url, reason: c.reason })) };
}

module.exports = { fetchArticle, readabilityFilter, htmlToText, safeUrl, isPublicHost, primaryUrl, MIN_WORDS, MAX_TEXT_CHARS };

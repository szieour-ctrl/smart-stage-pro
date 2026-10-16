// lib/brand-themes.js — shared by Netlify functions (and mirrored in index.html)
// Smart Stage PRO™ — Branding Themes (Oct 16, 2026)
//
// Three color roles: primary = buttons / social shared / CTA, secondary =
// navigation bar + panels, border = rules and lines. National-brand themes are
// LOCKED (server enforces these colors); "custom" uses the user's own colors.
// Fonts are limited to open-license families so the web app, compliance page and
// Railway renders all match. Each national brand maps to the closest open font
// (Gotham/GT America/Helvetica Neue are licensed), but the user may change it.
//
// Colors verified against each brand's published guidelines (Oct 16, 2026).
// eXp's preset still needs confirmation against its current Brand Toolkit;
// Coldwell Banker publishes only blue/white/black, so its border is white.

const FONTS = ["Montserrat", "Lato", "Open Sans", "Playfair Display", "Bodoni Moda", "Roboto", "Barlow", "Manrope"];

const THEMES = {
  kw:        { label: "Keller Williams",              primary: "#B40101", secondary: "#000000", border: "#999999", font: "Open Sans" },
  coldwell:  { label: "Coldwell Banker",              primary: "#012169", secondary: "#012169", border: "#FFFFFF", font: "Roboto" },
  remax:     { label: "RE/MAX",                       primary: "#FF1200", secondary: "#000E35", border: "#0043FF", font: "Montserrat" },
  century21: { label: "Century 21",                   primary: "#BEAF87", secondary: "#252526", border: "#A19276", font: "Barlow" },
  compass:   { label: "Compass",                      primary: "#000000", secondary: "#FFFFFF", border: "#000000", font: "Open Sans" },
  exp:       { label: "eXp Realty",                   primary: "#19469D", secondary: "#1B1E2A", border: "#F5821F", font: "Montserrat" },
  sothebys:  { label: "Sotheby's International Realty", primary: "#002349", secondary: "#002349", border: "#999999", font: "Playfair Display" },
  bhhs:      { label: "Berkshire Hathaway HomeServices", primary: "#670038", secondary: "#670038", border: "#2A2223", font: "Manrope" },
};

const DEFAULT_CUSTOM = { primary: "#b8975a", secondary: "#1a1714", border: "#b8975a", font: "Montserrat" };

module.exports = { FONTS, THEMES, DEFAULT_CUSTOM };

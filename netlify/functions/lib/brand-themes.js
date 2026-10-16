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
// NOTE: hex values are working values taken from Sam's themes doc and public
// brand palettes — verify against each brand's published guidelines.

const FONTS = ["Montserrat", "Lato", "Open Sans", "Playfair Display", "Bodoni Moda"];

const THEMES = {
  kw:        { label: "Keller Williams",              primary: "#B40101", secondary: "#333333", border: "#B40101", font: "Montserrat" },
  coldwell:  { label: "Coldwell Banker",              primary: "#1F69FF", secondary: "#012169", border: "#1F69FF", font: "Open Sans" },
  remax:     { label: "RE/MAX",                       primary: "#DC1C2E", secondary: "#003DA5", border: "#DC1C2E", font: "Montserrat" },
  century21: { label: "Century 21",                   primary: "#BEAF87", secondary: "#252526", border: "#BEAF87", font: "Lato" },
  compass:   { label: "Compass",                      primary: "#000000", secondary: "#FFFFFF", border: "#000000", font: "Open Sans" },
  exp:       { label: "eXp Realty",                   primary: "#1E5BA8", secondary: "#0B2A4A", border: "#1E5BA8", font: "Montserrat" },
  sothebys:  { label: "Sotheby's International Realty", primary: "#002349", secondary: "#002349", border: "#B5A47B", font: "Playfair Display" },
  bhhs:      { label: "Berkshire Hathaway HomeServices", primary: "#670A3A", secondary: "#670A3A", border: "#CDA24A", font: "Bodoni Moda" },
};

const DEFAULT_CUSTOM = { primary: "#b8975a", secondary: "#1a1714", border: "#b8975a", font: "Montserrat" };

module.exports = { FONTS, THEMES, DEFAULT_CUSTOM };

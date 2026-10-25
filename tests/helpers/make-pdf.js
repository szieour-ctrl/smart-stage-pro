// Builds a text PDF from page strings (one text line per line), for tests.
"use strict";
const PDFDocument = require("pdfkit");
function pdfFromPages(pages) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 20, size: [900, 800] });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c)); doc.on("end", () => resolve(Buffer.concat(chunks)));
    pages.forEach((p, i) => { if (i) doc.addPage(); doc.fontSize(6); let y = 20; p.split("\n").forEach((line) => { doc.text(line, 20, y, { lineBreak: false }); y += 9; }); });
    doc.end();
  });
}
module.exports = { pdfFromPages };

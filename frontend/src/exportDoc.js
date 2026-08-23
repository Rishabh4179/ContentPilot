/** Build and download/print a standalone, styled document from a generated article. */

const PRINT_CSS = `
  *{box-sizing:border-box}
  body{font-family:Georgia,"Times New Roman",serif;max-width:760px;margin:2.5rem auto;
    padding:0 1.25rem;color:#1a1a1a;line-height:1.7}
  h1{font-size:2rem;line-height:1.2;margin:0 0 .5rem}
  h2{font-size:1.4rem;margin:2rem 0 .5rem;border-bottom:1px solid #e5e5e5;padding-bottom:.25rem}
  h3{font-size:1.15rem;margin:1.5rem 0 .4rem}
  p{margin:0 0 1rem}
  ul,ol{margin:0 0 1rem 1.25rem}
  li{margin:.25rem 0}
  a{color:#2563eb;text-decoration:none}
  strong{color:#111}
  img{max-width:100%;border-radius:8px}
  blockquote{border-left:3px solid #ddd;margin:1rem 0;padding:.25rem 1rem;color:#555}
  code{background:#f3f4f6;padding:.1rem .3rem;border-radius:4px;font-size:.9em}
  pre{background:#f6f8fa;padding:1rem;border-radius:8px;overflow:auto}
  .doc-meta{color:#666;font-style:italic;margin:0 0 2rem;font-size:1.02rem}
  .doc-cover{width:100%;border-radius:10px;margin:0 0 1.5rem}
  @media print{body{margin:0;max-width:none}a{color:#1a1a1a}}
`;

export function slugify(text, fallback = "article") {
  return (
    (text || fallback)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback
  );
}

function escapeHtml(s) {
  return (s || "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

function absoluteUrl(url) {
  try {
    return new URL(url, window.location.origin).href;
  } catch {
    return url;
  }
}

/** Build a complete, self-contained HTML document (sanitized article HTML expected). */
export function buildExportHtml({ title, metaDescription, articleHtml, coverUrl }) {
  const cover = coverUrl
    ? `<img class="doc-cover" src="${escapeHtml(absoluteUrl(coverUrl))}" alt="">`
    : "";
  let body = articleHtml || "";
  if (metaDescription) {
    const lead = `<p class="doc-meta">${escapeHtml(metaDescription)}</p>`;
    body = body.includes("</h1>") ? body.replace("</h1>", `</h1>\n${lead}`) : lead + body;
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${escapeHtml(metaDescription || "")}">
<title>${escapeHtml(title || "Article")}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
${cover}
${body}
</body>
</html>`;
}

export function downloadHtmlFile(filename, html) {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Open the document in a new window and trigger the browser print dialog (Save as PDF). */
export function openPrintWindow(html) {
  const win = window.open("", "_blank");
  if (!win) return false;
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.onload = () => {
    win.focus();
    win.print();
  };
  return true;
}

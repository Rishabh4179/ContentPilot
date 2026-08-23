/**
 * ArticlePreview — a readable full-article modal with export + light editing.
 *
 * Read-only by default. When an `onUpdate` callback is passed (and the article is
 * saved, i.e. has an id) two editing tools light up:
 *   • Paragraph rewrite — hover any paragraph and click "↻ Rewrite" to regenerate
 *     just that block via /api/rewrite.
 *   • Internal links — suggests links to the user's OTHER related articles (RAG)
 *     and splices a Markdown link over a matching phrase.
 * Changes are persisted via updateArticle and bubbled up through onUpdate.
 *
 * Closes on Esc, backdrop click, or the × button.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  buildExportHtml,
  downloadHtmlFile,
  openPrintWindow,
  slugify,
} from "./exportDoc";
import { rewriteSection, suggestInternalLinks, updateArticle } from "./api";

marked.setOptions({ breaks: true });

function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

// Drop the leading H1 so we can render our own styled title header without
// duplicating it in the body.
function stripLeadingH1(md) {
  return (md || "").replace(/^\s{0,3}#\s+.*(?:\r?\n)+/, "");
}

// Remove any leading Markdown heading line from rewritten paragraph text — the
// block being rewritten is prose only, so a heading here would duplicate the
// section's real heading above it.
function stripLeadingHeading(md) {
  return (md || "").replace(/^\s{0,3}#{1,6}\s+.*(?:\r?\n)+/, "").trim();
}

// Split markdown into top-level blocks (separated by blank lines). Each block is
// tagged with whether it's the leading H1 (shown as the title) and whether it's a
// plain paragraph that can be rewritten inline. Normalises CRLF/CR first so blank
// lines split correctly regardless of the source's line endings.
function splitBlocks(md) {
  const normalized = (md || "").replace(/\r\n?/g, "\n");
  return normalized.split(/\n{2,}/).map((raw) => {
    const t = raw.trim();
    const isH1 = /^#\s/.test(t);
    const editable =
      t.length > 2 &&
      !/^#{1,6}\s/.test(t) && // headings
      !/^!\[/.test(t) && // standalone image
      !/^\|/.test(t) && // table row
      !/^```/.test(t) && // code fence
      !/^(#{1,6}\s*)?\[/.test(t); // pure link/anchor line
    return { raw, isH1, editable };
  });
}

function renderBlock(raw) {
  return DOMPurify.sanitize(marked.parse(raw || ""));
}

function countWords(md) {
  const words = (md || "")
    .replace(/[#>*_`~[\]()!-]/g, " ")
    .match(/\b[\w'-]+\b/g);
  return words ? words.length : 0;
}

function downloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const EXPORT_OPTIONS = [
  { id: "pdf", icon: "🖨", label: "PDF (print)" },
  { id: "html", icon: "🌐", label: "HTML" },
  { id: "markdown", icon: "📝", label: "Markdown" },
  { id: "word", icon: "📄", label: "Word (.doc)" },
];

export default function ArticlePreview({ article, onClose, onUpdate }) {
  const navigate = useNavigate();
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef(null);

  // Editing state (only active when onUpdate + a saved article id are present).
  const editable = typeof onUpdate === "function" && !!article?.id;
  const [rewriteBusy, setRewriteBusy] = useState(null); // block index or null
  const [saving, setSaving] = useState(false);
  const [toolError, setToolError] = useState("");
  const [linksOpen, setLinksOpen] = useState(false);
  const [linksLoading, setLinksLoading] = useState(false);
  const [links, setLinks] = useState(null); // null = not fetched yet
  const [linksMsg, setLinksMsg] = useState("");

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose?.();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  // Close the export menu on outside click.
  useEffect(() => {
    if (!exportOpen) return undefined;
    const onDown = (e) => {
      if (exportRef.current && !exportRef.current.contains(e.target)) {
        setExportOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [exportOpen]);

  // Body shown in the read-only view (title stripped, rendered once as a header).
  const html = useMemo(
    () =>
      article
        ? DOMPurify.sanitize(marked.parse(stripLeadingH1(article.markdown)))
        : "",
    [article]
  );

  // Blocks for the editable view (recomputes whenever the article changes).
  const blocks = useMemo(
    () => (article ? splitBlocks(article.markdown) : []),
    [article]
  );

  if (!article) return null;
  const title = article.title || article.topic || "Untitled";

  async function persist(newMarkdown) {
    const wc = countWords(newMarkdown);
    let updated = { ...article, markdown: newMarkdown, word_count: wc };
    if (article.id) {
      setSaving(true);
      try {
        updated = await updateArticle(article.id, {
          markdown: newMarkdown,
          word_count: wc,
        });
      } catch {
        /* keep the local update even if the save fails */
      } finally {
        setSaving(false);
      }
    }
    onUpdate?.(updated);
  }

  async function handleRewriteBlock(i) {
    if (rewriteBusy !== null) return;
    setRewriteBusy(i);
    setToolError("");
    try {
      const { markdown: newText } = await rewriteSection({
        section: blocks[i].raw,
        topic: article.topic || article.title || "",
        tone: article.tone || "informative",
        audience: article.audience || "a general audience",
        instruction:
          "Rewrite ONLY this paragraph's prose. Do NOT add any Markdown heading, "
          + "title, bullet list, or label — return a single rewritten paragraph of "
          + "plain prose with the same meaning.",
      });
      const next = blocks.map((b, idx) =>
        idx === i ? { ...b, raw: stripLeadingHeading(newText) } : b
      );
      await persist(next.map((b) => b.raw).join("\n\n"));
    } catch (e) {
      setToolError(e.message || "Rewrite failed.");
    } finally {
      setRewriteBusy(null);
    }
  }

  async function handleFetchLinks() {
    setLinksOpen(true);
    if (links !== null || linksLoading) return;
    setLinksLoading(true);
    setToolError("");
    setLinksMsg("");
    try {
      const data = await suggestInternalLinks(article.id, { maxSuggestions: 5 });
      const found = data.suggestions || [];
      setLinks(found);
      if (found.length === 0) {
        setLinksMsg(
          "No related articles to link yet — write more on similar topics."
        );
      }
    } catch (e) {
      setToolError(e.message || "Could not suggest links.");
      setLinks([]);
    } finally {
      setLinksLoading(false);
    }
  }

  function handleInsertLink(s) {
    const md = article.markdown || "";
    const idx = md.toLowerCase().indexOf(s.anchor_text.toLowerCase());
    if (idx === -1) {
      setToolError("That phrase is no longer in the article.");
      return;
    }
    const orig = md.slice(idx, idx + s.anchor_text.length);
    const linkMd = `[${orig}](/articles/${s.target_id})`;
    const newMarkdown =
      md.slice(0, idx) + linkMd + md.slice(idx + s.anchor_text.length);
    persist(newMarkdown);
    setLinks((prev) => (prev || []).filter((x) => x !== s));
  }

  function handleExport(format) {
    setExportOpen(false);
    const base = slugify(title);
    if (format === "markdown") {
      downloadTextFile(`${base}.md`, article.markdown || "", "text/markdown;charset=utf-8");
      return;
    }
    // For PDF / HTML / Word we render the FULL markdown (keeps the H1 title).
    const fullHtml = DOMPurify.sanitize(marked.parse(article.markdown || ""));
    const doc = buildExportHtml({
      title,
      metaDescription: article.meta_description,
      articleHtml: fullHtml,
      coverUrl: article.cover_url,
    });
    if (format === "pdf") {
      if (!openPrintWindow(doc)) {
        alert("Please allow pop-ups to export as PDF.");
      }
    } else if (format === "html") {
      downloadHtmlFile(`${base}.html`, doc);
    } else if (format === "word") {
      // Word opens an HTML document saved with a .doc extension.
      downloadTextFile(`${base}.doc`, doc, "application/msword");
    }
  }

  return (
    <div className="preview-backdrop" onClick={onClose} role="presentation">
      <div
        className="preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Article preview"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="preview-toolbar">
          <div className="preview-toolbar-left">
            <div className="preview-export" ref={exportRef}>
              <button
                type="button"
                className="preview-export-btn"
                onClick={() => setExportOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={exportOpen}
              >
                ⬇ Export
                <span className="preview-caret" aria-hidden="true">
                  ▾
                </span>
              </button>
              {exportOpen && (
                <div className="preview-export-menu" role="menu">
                  {EXPORT_OPTIONS.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      role="menuitem"
                      className="preview-export-item"
                      onClick={() => handleExport(o.id)}
                    >
                      <span aria-hidden="true">{o.icon}</span>
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {article.id && (
              <button
                type="button"
                className="preview-export-btn"
                onClick={() => {
                  onClose?.();
                  navigate(`/?article=${article.id}`);
                }}
                title="Open in Generator to create images, social posts, export, etc."
              >
                ⚡ Open in Generator
              </button>
            )}
            {editable && (
              <button
                type="button"
                className={`preview-export-btn ${linksOpen ? "is-active" : ""}`}
                onClick={() => (linksOpen ? setLinksOpen(false) : handleFetchLinks())}
                aria-expanded={linksOpen}
              >
                🔗 Internal links
              </button>
            )}
            {saving && <span className="preview-saving">Saving…</span>}
          </div>
          <button
            type="button"
            className="preview-close"
            onClick={onClose}
            aria-label="Close preview"
          >
            ×
          </button>
        </div>

        {toolError && <div className="preview-tool-error">{toolError}</div>}

        {editable && linksOpen && (
          <div className="preview-links-panel">
            <div className="preview-links-head">
              <span className="preview-links-title">
                🔗 Suggested internal links
              </span>
              <button
                type="button"
                className="preview-links-close"
                onClick={() => setLinksOpen(false)}
                aria-label="Hide suggestions"
              >
                ×
              </button>
            </div>
            {linksLoading ? (
              <p className="preview-links-msg">Finding related articles…</p>
            ) : linksMsg ? (
              <p className="preview-links-msg">{linksMsg}</p>
            ) : (
              <ul className="preview-links-list">
                {(links || []).map((s, i) => (
                  <li key={`${s.target_id}-${i}`} className="preview-link-item">
                    <div className="preview-link-info">
                      <span className="preview-link-anchor">“{s.anchor_text}”</span>
                      <span className="preview-link-arrow">→</span>
                      <span className="preview-link-target">{s.target_title}</span>
                      {s.reason && (
                        <span className="preview-link-reason">{s.reason}</span>
                      )}
                    </div>
                    <button
                      type="button"
                      className="preview-link-add"
                      onClick={() => handleInsertLink(s)}
                    >
                      + Insert
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <article className="preview-doc">
          {article.cover_url && (
            <img className="preview-cover" src={article.cover_url} alt="" />
          )}
          <h1 className="preview-title">{title}</h1>
          {article.meta_description && (
            <p className="preview-meta">{article.meta_description}</p>
          )}
          <div className="preview-stats">
            <span>📄 {article.word_count || 0} words</span>
            {article.created_at && <span>🗓 {formatDate(article.created_at)}</span>}
            {article.tone && <span>🎨 {article.tone}</span>}
          </div>
          {editable ? (
            <div className="article-body preview-body preview-body-edit">
              <p className="preview-edit-hint">
                ✍️ Editing on — click <strong>↻ Rewrite</strong> on any paragraph to
                regenerate just that part.
              </p>
              {blocks.map((b, i) =>
                b.isH1 ? null : (
                  <div
                    key={i}
                    className={`preview-block ${b.editable ? "is-editable" : ""}`}
                  >
                    <div
                      className="preview-block-html"
                      dangerouslySetInnerHTML={{ __html: renderBlock(b.raw) }}
                    />
                    {b.editable && (
                      <button
                        type="button"
                        className="preview-block-rewrite"
                        onClick={() => handleRewriteBlock(i)}
                        disabled={rewriteBusy !== null}
                        title="Regenerate just this paragraph"
                      >
                        {rewriteBusy === i ? "…" : "↻ Rewrite"}
                      </button>
                    )}
                  </div>
                )
              )}
            </div>
          ) : (
            <div
              className="article-body preview-body"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </article>
      </div>
    </div>
  );
}

/**
 * Library page — browse every article the signed-in user has ever generated.
 * Uses the same /api/articles list endpoint the generator's history drawer hits,
 * but presented as a full grid with search + open/delete.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { deleteArticle, listArticles, clearArticles } from "../api";
import { useAuthState } from "../AuthGate";
import ArticlePreview from "../ArticlePreview";

function formatDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

export default function Library() {
  const navigate = useNavigate();
  const { ready: authReady, signedIn, userId } = useAuthState();
  const [articles, setArticles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [previewArticle, setPreviewArticle] = useState(null);

  useEffect(() => {
    if (!authReady) return;
    if (!signedIn) {
      setArticles([]);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    listArticles()
      .then((rows) => {
        if (!active) return;
        setArticles(rows || []);
        setError("");
      })
      .catch((err) => {
        if (!active) return;
        setError(err.message);
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [authReady, signedIn, userId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return articles;
    return articles.filter((a) => {
      const hay = [a.title, a.topic, (a.keywords || []).join(" "), a.meta_description]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [articles, search]);

  const totalWords = useMemo(
    () => articles.reduce((sum, a) => sum + (a.word_count || 0), 0),
    [articles]
  );

  async function handleDelete(id) {
    if (!id) return;
    if (!window.confirm("Delete this article? This cannot be undone.")) return;
    setBusyId(id);
    try {
      await deleteArticle(id);
      setArticles((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function handleClearAll() {
    if (!articles.length) return;
    if (
      !window.confirm(
        `Delete ALL ${articles.length} article${articles.length === 1 ? "" : "s"}? This cannot be undone.`
      )
    )
      return;
    try {
      await clearArticles();
      setArticles([]);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <main className="library-page">
      <header className="library-head">
        <div>
          <h1>📚 Your library</h1>
          <p className="library-subtitle">
            {loading
              ? "Loading…"
              : articles.length === 0
              ? "No articles yet. Generate your first one."
              : `${articles.length} article${articles.length === 1 ? "" : "s"} · ${totalWords.toLocaleString()} words total`}
          </p>
        </div>
        <div className="library-head-actions">
          <button
            type="button"
            className="generate"
            onClick={() => navigate("/")}
          >
            ✨ New article
          </button>
          {articles.length > 0 && (
            <button
              type="button"
              className="ghost"
              onClick={handleClearAll}
              title="Delete every saved article"
            >
              🗑 Clear all
            </button>
          )}
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      {articles.length > 0 && (
        <div className="library-search">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by title, topic, or keyword…"
            aria-label="Search library"
          />
          {search && (
            <span className="library-search-count">
              {filtered.length} match{filtered.length === 1 ? "" : "es"}
            </span>
          )}
        </div>
      )}

      {!loading && filtered.length === 0 && articles.length > 0 && (
        <p className="library-empty">No articles match “{search}”.</p>
      )}

      <div className="library-grid">
        {filtered.map((a) => (
          <article key={a.id} className="library-card card">
            {a.cover_url && (
              <img className="library-card-cover" src={a.cover_url} alt="" />
            )}
            <div className="library-card-body">
              <h3 className="library-card-title">{a.title || a.topic || "(untitled)"}</h3>
              {a.meta_description && (
                <p className="library-card-meta">{a.meta_description}</p>
              )}
              <div className="library-card-stats">
                <span>📄 {a.word_count || 0} words</span>
                <span>🗓 {formatDate(a.created_at)}</span>
              </div>
              {a.keywords?.length > 0 && (
                <div className="library-card-tags">
                  {a.keywords.slice(0, 5).map((k) => (
                    <span key={k} className="library-card-tag">
                      {k}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="library-card-actions">
              <button
                type="button"
                className="generate"
                onClick={() => navigate(`/?article=${a.id}`)}
                title="Load into Generator (generate cover image, section images, social posts, export)"
              >
                ⚡ Generator
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => setPreviewArticle(a)}
              >
                📖 Read
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => navigate(`/agent?article=${a.id}`)}
                title="Open this article in the agent"
              >
                🤖 Agent
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => handleDelete(a.id)}
                disabled={busyId === a.id}
              >
                {busyId === a.id ? "Deleting…" : "🗑 Delete"}
              </button>
            </div>
          </article>
        ))}
      </div>

      {previewArticle && (
        <ArticlePreview
          article={previewArticle}
          onClose={() => setPreviewArticle(null)}
          onUpdate={(updated) => {
            setPreviewArticle(updated);
            setArticles((prev) =>
              prev.map((a) => (a.id === updated.id ? { ...a, ...updated } : a))
            );
          }}
        />
      )}
    </main>
  );
}

/**
 * Dashboard — library analytics from /api/stats.
 * Lightweight charts built with CSS/SVG (no external chart dependency).
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getStats, sendDigestEmail, getSubscription, setSubscription } from "../api";
import { useAuthState, useUserEmail, useDisplayName } from "../AuthGate";

function formatNumber(n) {
  return (n || 0).toLocaleString();
}

// 0=Monday … 6=Sunday, matching Python's weekday() used on the backend.
const DAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

// The browser's IANA timezone (e.g. "Asia/Kolkata"), used to schedule sends
// in the user's own local time.
function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// "9:00 AM", "2:00 PM" … for a 0–23 hour.
function formatHour(h) {
  const hour = ((h % 24) + 24) % 24;
  const period = hour < 12 ? "AM" : "PM";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:00 ${period}`;
}

// A soft palette for the distribution bars, cycled per item.
const SERIES_COLORS = [
  "var(--accent)",
  "var(--accent-2)",
  "#22c55e",
  "#eab308",
  "#f97316",
  "#ec4899",
  "#06b6d4",
  "#a855f7",
];

function StatCard({ icon, label, value, sub, trend, variant }) {
  const isText = variant === "text";
  return (
    <div className="dash-stat card">
      <div className="dash-stat-icon" aria-hidden="true">
        {icon}
      </div>
      <div className="dash-stat-body">
        <div className={`dash-stat-value${isText ? " dash-stat-value-text" : ""}`}>
          {isText ? (
            <span title={typeof value === "string" ? value : undefined}>{value}</span>
          ) : (
            <>
              {value}
              {trend && (
                <span className={`dash-stat-trend dash-trend-${trend.dir}`}>
                  {trend.dir === "up" ? "▲" : trend.dir === "down" ? "▼" : "•"}{" "}
                  {trend.text}
                </span>
              )}
            </>
          )}
        </div>
        <div className="dash-stat-label">{label}</div>
        {sub && <div className="dash-stat-sub">{sub}</div>}
      </div>
    </div>
  );
}

function ActivityChart({ points }) {
  const maxCount = useMemo(
    () => Math.max(1, ...points.map((p) => p.count)),
    [points]
  );
  const hasAny = points.some((p) => p.count > 0);

  return (
    <div className="dash-panel card">
      <div className="dash-panel-head">
        <h2>Activity</h2>
        <span className="dash-panel-sub">Last {points.length} days</span>
      </div>
      {!hasAny ? (
        <p className="dash-empty">No articles created in this window yet.</p>
      ) : (
        <div className="dash-chart">
          {points.map((p, i) => {
            const h = p.count === 0 ? 0 : Math.max(6, (p.count / maxCount) * 100);
            return (
              <div className="dash-bar-col" key={i}>
                <div className="dash-bar-track">
                  <div
                    className={`dash-bar${p.count ? "" : " dash-bar-empty"}`}
                    style={{ height: `${h}%` }}
                    title={`${p.label}: ${p.count} article${p.count === 1 ? "" : "s"} · ${formatNumber(p.words)} words`}
                  />
                </div>
                {/* Only label every 5th tick to avoid crowding. */}
                <span className="dash-bar-label">
                  {i % 5 === 0 || i === points.length - 1 ? p.label : ""}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DistributionPanel({ title, items, emptyText }) {
  const total = useMemo(
    () => items.reduce((sum, it) => sum + it.count, 0),
    [items]
  );
  return (
    <div className="dash-panel card">
      <div className="dash-panel-head">
        <h2>{title}</h2>
      </div>
      {items.length === 0 ? (
        <p className="dash-empty">{emptyText}</p>
      ) : (
        <ul className="dash-dist">
          {items.map((it, i) => {
            const pct = total ? Math.round((it.count / total) * 100) : 0;
            return (
              <li key={it.name} className="dash-dist-row">
                <span className="dash-dist-name" title={it.name}>
                  {it.name}
                </span>
                <span className="dash-dist-track">
                  <span
                    className="dash-dist-fill"
                    style={{
                      width: `${pct}%`,
                      background: SERIES_COLORS[i % SERIES_COLORS.length],
                    }}
                  />
                </span>
                <span className="dash-dist-count">
                  {it.count} <span className="dash-dist-pct">({pct}%)</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function KeywordCloud({ items }) {
  const maxCount = useMemo(
    () => Math.max(1, ...items.map((it) => it.count)),
    [items]
  );
  return (
    <div className="dash-panel card">
      <div className="dash-panel-head">
        <h2>Top keywords</h2>
      </div>
      {items.length === 0 ? (
        <p className="dash-empty">
          No keywords yet. Add keywords when generating to see them here.
        </p>
      ) : (
        <div className="dash-cloud">
          {items.map((it) => {
            // Scale font size 0.85rem → 1.6rem by frequency.
            const scale = 0.85 + (it.count / maxCount) * 0.75;
            return (
              <span
                key={it.name}
                className="dash-cloud-tag"
                style={{ fontSize: `${scale}rem` }}
                title={`${it.count} article${it.count === 1 ? "" : "s"}`}
              >
                {it.name}
                <span className="dash-cloud-count">{it.count}</span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { ready: authReady, signedIn, userId } = useAuthState();
  const userEmail = useUserEmail();
  const displayName = useDisplayName();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [digestBusy, setDigestBusy] = useState(false);
  const [digestMsg, setDigestMsg] = useState(null); // { kind: "ok"|"err"|"preview", text, html }
  const [sub, setSub] = useState(null); // { enabled, email, email_configured, last_sent_at }
  const [subBusy, setSubBusy] = useState(false);

  useEffect(() => {
    if (!authReady) return;
    if (!signedIn) {
      setStats(null);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    getStats()
      .then((data) => {
        if (!active) return;
        setStats(data);
        setError("");
      })
      .catch((err) => active && setError(err.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [authReady, signedIn, userId]);

  // Load the weekly-digest subscription state.
  useEffect(() => {
    if (!authReady || !signedIn) return;
    let active = true;
    getSubscription()
      .then((data) => active && setSub(data))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [authReady, signedIn, userId]);

  async function handleToggleSubscription() {
    // Determine the recipient email (Clerk email, else prompt once).
    let email = sub?.email || userEmail;
    const nextEnabled = !(sub?.enabled);
    if (nextEnabled && !email) {
      email = (window.prompt("Which email should the weekly digest go to?") || "").trim();
      if (!email) return;
    }
    setSubBusy(true);
    setDigestMsg(null);
    try {
      const res = await setSubscription({
        email: email || "unknown@example.com",
        name: displayName || "",
        enabled: nextEnabled,
        sendDay: sub?.send_day ?? 0,
        sendHour: sub?.send_hour ?? 9,
        // Capture the real browser timezone when (re)subscribing.
        timezone: nextEnabled ? browserTimezone() : sub?.timezone || browserTimezone(),
      });
      setSub(res);
      setDigestMsg({
        kind: "ok",
        text: nextEnabled
          ? `Subscribed — you’ll get a digest every ${DAY_NAMES[res.send_day] || "Monday"} at ${formatHour(res.send_hour)} (${res.timezone}).`
          : "Unsubscribed from the weekly digest.",
      });
    } catch (err) {
      setDigestMsg({ kind: "err", text: err.message });
    } finally {
      setSubBusy(false);
    }
  }

  async function handleChangeDay(nextDay) {
    if (!sub?.enabled) return;
    setSubBusy(true);
    setDigestMsg(null);
    try {
      const res = await setSubscription({
        email: sub.email || userEmail || "unknown@example.com",
        name: displayName || "",
        enabled: true,
        sendDay: Number(nextDay),
        sendHour: sub.send_hour ?? 9,
        timezone: sub.timezone || browserTimezone(),
      });
      setSub(res);
      setDigestMsg({
        kind: "ok",
        text: `Digest day set to ${DAY_NAMES[res.send_day] || "Monday"}.`,
      });
    } catch (err) {
      setDigestMsg({ kind: "err", text: err.message });
    } finally {
      setSubBusy(false);
    }
  }

  async function handleChangeTime(nextHour) {
    if (!sub?.enabled) return;
    setSubBusy(true);
    setDigestMsg(null);
    try {
      const res = await setSubscription({
        email: sub.email || userEmail || "unknown@example.com",
        name: displayName || "",
        enabled: true,
        sendDay: sub.send_day ?? 0,
        sendHour: Number(nextHour),
        // Re-detect tz so the chosen time is anchored to where they are now.
        timezone: browserTimezone(),
      });
      setSub(res);
      setDigestMsg({
        kind: "ok",
        text: `Digest time set to ${formatHour(res.send_hour)} (${res.timezone}).`,
      });
    } catch (err) {
      setDigestMsg({ kind: "err", text: err.message });
    } finally {
      setSubBusy(false);
    }
  }

  async function handleEmailDigest() {
    // Use the signed-in user's email when available; otherwise ask for one.
    let email = userEmail;
    if (!email) {
      email = window.prompt("Send the digest to which email address?") || "";
      email = email.trim();
      if (!email) return;
    }
    setDigestBusy(true);
    setDigestMsg(null);
    try {
      const res = await sendDigestEmail(email, { name: displayName || "" });
      if (res.sent) {
        setDigestMsg({ kind: "ok", text: res.message || `Sent to ${email}.` });
      } else if (res.preview) {
        // Server email not configured yet — offer the rendered preview.
        setDigestMsg({
          kind: "preview",
          text:
            res.message ||
            "Email isn’t configured on the server yet. You can preview the digest.",
          html: res.html,
        });
      }
    } catch (err) {
      setDigestMsg({ kind: "err", text: err.message });
    } finally {
      setDigestBusy(false);
    }
  }

  function openDigestPreview(htmlStr) {
    const w = window.open("", "_blank");
    if (w) {
      w.document.write(htmlStr);
      w.document.close();
    }
  }

  // Derived quick-insight metrics (computed from the stats we already have).
  // NOTE: declared before any early return so hook order stays stable.
  const insights = useMemo(() => {
    if (!stats) return null;
    const readingMin = stats.total_words
      ? Math.max(1, Math.round(stats.total_words / 200))
      : 0;
    const perActiveDay = stats.active_days
      ? Math.round((stats.total_articles / stats.active_days) * 10) / 10
      : 0;
    // Busiest day from the activity series.
    let busiest = null;
    for (const p of stats.over_time || []) {
      if (p.count > 0 && (!busiest || p.count > busiest.count)) busiest = p;
    }
    // Week-over-week trend for "This week".
    const thisW = stats.articles_this_week || 0;
    const prevW = stats.articles_prev_week || 0;
    const delta = thisW - prevW;
    const trend =
      delta > 0
        ? { dir: "up", text: `+${delta}` }
        : delta < 0
        ? { dir: "down", text: `${delta}` }
        : { dir: "flat", text: "0" };
    const topTone = stats.tones?.[0] || null;
    const topKeyword = stats.top_keywords?.[0] || null;
    return { readingMin, perActiveDay, busiest, trend, topTone, topKeyword };
  }, [stats]);

  if (loading) {
    return (
      <main className="dash-page">
        <div className="dash-loading">
          <span className="spinner spinner-lg" />
          <p>Crunching your numbers…</p>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="dash-page">
        <div className="error-banner">{error}</div>
      </main>
    );
  }

  const empty = !stats || stats.total_articles === 0;

  return (
    <main className="dash-page">
      <header className="dash-head">
        <div>
          <h1>📊 Dashboard</h1>
          <p className="dash-subtitle">Insights across your entire library</p>
        </div>
        <div className="dash-head-actions">
          {!empty && (
            <button
              type="button"
              className="ghost dash-digest-btn"
              onClick={handleEmailDigest}
              disabled={digestBusy}
              title="Email yourself a summary of your library"
            >
              {digestBusy ? "Sending…" : "📧 Email me this digest"}
            </button>
          )}
          <button type="button" className="generate" onClick={() => navigate("/")}>
            ✨ New article
          </button>
        </div>
      </header>

      {sub && (
        <div className="dash-sub-row card">
          <div className="dash-sub-info">
            <span className="dash-sub-title">📬 Weekly email digest</span>
            <span className="dash-sub-desc">
              {sub.enabled
                ? `On — emailed every ${DAY_NAMES[sub.send_day] || "Monday"} at ${formatHour(sub.send_hour ?? 9)}${sub.timezone ? ` (${sub.timezone})` : ""}${sub.email ? ` to ${sub.email}` : ""}.`
                : "Off — get a stats summary emailed to you every week."}
              {!sub.email_configured && (
                <span className="dash-sub-warn">
                  {" "}
                  (server email isn’t configured yet, so delivery is paused)
                </span>
              )}
            </span>
          </div>
          <div className="dash-sub-controls">
            {sub.enabled && (
              <>
                <label className="dash-sub-day">
                  <span>Every</span>
                  <select
                    value={sub.send_day ?? 0}
                    onChange={(e) => handleChangeDay(e.target.value)}
                    disabled={subBusy}
                    aria-label="Day of week to receive the digest"
                  >
                    {DAY_NAMES.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="dash-sub-day">
                  <span>at</span>
                  <select
                    value={sub.send_hour ?? 9}
                    onChange={(e) => handleChangeTime(e.target.value)}
                    disabled={subBusy}
                    aria-label="Time of day to receive the digest"
                  >
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>
                        {formatHour(h)}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <button
              type="button"
              className={`dash-toggle${sub.enabled ? " on" : ""}`}
              role="switch"
              aria-checked={sub.enabled}
              onClick={handleToggleSubscription}
              disabled={subBusy}
              title={sub.enabled ? "Unsubscribe" : "Subscribe"}
            >
              <span className="dash-toggle-knob" />
            </button>
          </div>
        </div>
      )}

      {digestMsg && (
        <div className={`dash-digest-msg dash-digest-${digestMsg.kind}`}>
          <span>{digestMsg.text}</span>
          {digestMsg.kind === "preview" && digestMsg.html && (
            <button
              type="button"
              className="ghost"
              onClick={() => openDigestPreview(digestMsg.html)}
            >
              Open preview
            </button>
          )}
          <button
            type="button"
            className="dash-digest-dismiss"
            onClick={() => setDigestMsg(null)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {empty ? (
        <div className="dash-empty-state card">
          <div className="dash-empty-mark">📊</div>
          <h2>No data yet</h2>
          <p>Generate your first article and your stats will show up here.</p>
          <button
            type="button"
            className="generate"
            onClick={() => navigate("/")}
          >
            ✨ Generate an article
          </button>
        </div>
      ) : (
        <>
          <section className="dash-stats-grid">
            <StatCard
              icon="📄"
              label="Articles"
              value={formatNumber(stats.total_articles)}
              sub={`across ${stats.active_days} active day${stats.active_days === 1 ? "" : "s"}`}
            />
            <StatCard
              icon="✍️"
              label="Total words"
              value={formatNumber(stats.total_words)}
              sub={`avg ${formatNumber(stats.avg_words)} / article`}
            />
            <StatCard
              icon="🔥"
              label="This week"
              value={formatNumber(stats.articles_this_week)}
              sub={`${formatNumber(stats.words_this_week)} words · vs ${formatNumber(
                stats.articles_prev_week
              )} last week`}
              trend={insights?.trend}
            />
            <StatCard
              icon="🏆"
              label="Longest article"
              value={formatNumber(stats.longest_words)}
              sub="words"
            />
            <StatCard
              icon="⏱️"
              label="Reading time"
              value={`${formatNumber(insights?.readingMin || 0)} min`}
              sub="to read your library"
            />
            <StatCard
              icon="📈"
              label="Per active day"
              value={insights?.perActiveDay ?? 0}
              sub="articles / day written"
            />
            {insights?.busiest && (
              <StatCard
                icon="📅"
                label="Busiest day"
                value={insights.busiest.label}
                variant="text"
                sub={`${insights.busiest.count} article${insights.busiest.count === 1 ? "" : "s"} · ${formatNumber(insights.busiest.words)} words`}
              />
            )}
            {insights?.topTone && (
              <StatCard
                icon="🎨"
                label="Go-to tone"
                value={
                  insights.topTone.name.charAt(0).toUpperCase() +
                  insights.topTone.name.slice(1)
                }
                variant="text"
                sub={`${insights.topTone.count} of ${stats.total_articles} articles`}
              />
            )}
            {insights?.topKeyword && (
              <StatCard
                icon="🏷️"
                label="Top keyword"
                value={insights.topKeyword.name}
                variant="text"
                sub={`used in ${insights.topKeyword.count} article${insights.topKeyword.count === 1 ? "" : "s"}`}
              />
            )}
          </section>

          <ActivityChart points={stats.over_time || []} />

          <section className="dash-two-col">
            <DistributionPanel
              title="Audiences"
              items={stats.audiences || []}
              emptyText="No audience data."
            />
            <DistributionPanel
              title="Tones"
              items={stats.tones || []}
              emptyText="No tone data."
            />
          </section>

          <section className="dash-two-col">
            <DistributionPanel
              title="Lengths"
              items={stats.lengths || []}
              emptyText="No length data."
            />
            <KeywordCloud items={stats.top_keywords || []} />
          </section>
        </>
      )}
    </main>
  );
}

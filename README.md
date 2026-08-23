# ✍️ ContentPilot

An AI content platform: generate SEO‑ready articles, refine them with an agent, chat with
your whole library, track analytics, and get scheduled email digests.

- **Backend:** Python + FastAPI + SQLModel
- **Frontend:** React 18 + Vite + React Router
- **Database:** Neon Postgres
- **Auth:** Clerk (optional — falls back to single‑user local mode)
- **AI:** Groq (primary) → Google Gemini (fallback); Gemini embeddings for RAG;
  Pollinations / Cloudflare FLUX / Gemini for images

---

## Features

**Generate**
- Streaming article generation with tone / length / audience controls
- Web‑grounded generation (live search) via Groq compound / Gemini grounding
- Outline‑first workflow and section‑by‑section rewrite
- AI cover image + per‑section images

**Enhance**
- SEO analysis + one‑click SEO rewrite
- Translate to any language, FAQ generator, social pack (X thread / LinkedIn / newsletter)
- Competitor SERP scan (top pages, gaps, suggested sections)
- Export to PDF / standalone HTML

**Organize**
- Saved‑article **Library** (search, open, delete)
- **Dashboard** analytics — totals, week‑over‑week trend, activity chart, reading time,
  busiest day, tone/audience distributions, keyword cloud
- 8 built‑in **themes** (Midnight, Ocean, Forest, Sunset, Rose, Nord, Mono, Daylight)

**Pilot — the AI agent**
- Plans and executes tools from plain English (edit, SEO, translate, images, social, FAQ,
  competitors, export) with per‑step status cards
- Clarification loop: asks with clickable options when a request is ambiguous
- **Two independent modes**, each with ChatGPT‑style multi‑session history saved to the DB:
  - 💬 **Article** — task chat scoped to one article
  - 📚 **Library (RAG)** — question‑answering across your entire library with citations

**Email**
- Weekly digest email (Resend HTTP API, or SMTP fallback)
- Per‑user schedule: pick day + time in your own timezone; one‑click unsubscribe

---

## Project structure

```
main/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI app, generation + agent routes, scheduler
│   │   ├── config.py            # env-based settings
│   │   ├── db.py                # engine, session, lightweight migrations
│   │   ├── models.py            # SQLModel tables (Article, ChatSession, …)
│   │   ├── schemas.py           # request/response models
│   │   ├── auth.py              # Clerk JWT verification (+ local fallback)
│   │   ├── routers/
│   │   │   ├── articles.py      # saved-article CRUD
│   │   │   ├── stats.py         # dashboard analytics
│   │   │   ├── library.py       # RAG "chat with your library"
│   │   │   ├── chat.py          # persisted chat sessions (history)
│   │   │   └── notify.py        # email digest + subscription + scheduler job
│   │   └── services/
│   │       ├── generator.py     # LLM chain, embeddings, agent planner
│   │       └── mailer.py        # Resend (HTTP) + SMTP sender
│   └── requirements.txt
└── frontend/
    ├── src/
    │   ├── App.jsx              # generator page
    │   ├── Layout.jsx           # nav + theme switcher + auth gate
    │   ├── AgentContext.jsx     # cross-tab chat/session state
    │   ├── AuthGate.jsx         # Clerk wrapper (+ local mode)
    │   ├── theme.js / ThemeSwitcher.jsx
    │   ├── pages/
    │   │   ├── Library.jsx
    │   │   ├── Dashboard.jsx
    │   │   └── Agent.jsx        # Pilot: Article + Library chat, history drawer
    │   ├── api.js               # backend client
    │   └── styles.css
    ├── index.html
    ├── package.json
    └── vite.config.js
```

---

## 1. Run the backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
# create backend/.env (see "Environment variables" below)
uvicorn app.main:app --reload
```

Backend runs at **http://localhost:8000** (interactive docs at `/docs`).

At minimum you need **one LLM key** (Groq or Gemini). Everything else (Postgres, Clerk,
email) is optional and has sensible local defaults.

---

## 2. Run the frontend

In a second terminal:

```powershell
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**. The Vite dev server proxies `/api` calls to the backend.

---

## Environment variables

Create `backend/.env`. Only the LLM key is required to start.

```ini
# --- LLM providers (at least one) -------------------------------------------
GROQ_API_KEY=            # primary text provider — https://console.groq.com/keys
GROQ_MODEL=llama-3.3-70b-versatile
GEMINI_API_KEY=          # fallback + embeddings + images — https://aistudio.google.com/apikey
GEMINI_MODEL=gemini-2.5-flash          # use a "flash" model (pro = 0 free quota)
GEMINI_EMBEDDING_MODEL=gemini-embedding-001   # used for library RAG search

# --- Images -----------------------------------------------------------------
IMAGE_PROVIDER=pollinations            # "pollinations" (free) | "cloudflare" (free FLUX) | "gemini"
POLLINATIONS_MODEL=flux
POLLINATIONS_ENHANCE=true               # LLM prompt enhancer — sharper, on-topic images (free)
POLLINATIONS_TOKEN=                     # optional, unlocks better models (e.g. gptimage)
# Cloudflare Workers AI — best free quality (FLUX.1-schnell). Free token + account id at
# dash.cloudflare.com → Workers AI. Set IMAGE_PROVIDER=cloudflare to use it.
CLOUDFLARE_ACCOUNT_ID=                   # your Cloudflare account id
CLOUDFLARE_API_TOKEN=                    # Workers AI token
CLOUDFLARE_IMAGE_MODEL=@cf/black-forest-labs/flux-1-schnell
CLOUDFLARE_IMAGE_STEPS=8                 # 1–8; higher = more detail

# --- Image storage (Supabase Storage) ---------------------------------------
# Generated images are uploaded to Supabase Storage and served from its public
# URL, so they survive redeploys and work on serverless hosts (Vercel). No card
# required. At supabase.com: create a project, add a PUBLIC bucket named "images",
# then grab the URL + service_role key from Project Settings → API.
SUPABASE_URL=                            # e.g. https://xxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY=                    # service_role key (keep secret, server-side only)
SUPABASE_BUCKET=images

# --- Database (required — Neon/Postgres, no SQLite) --------------------------
# Paste your Neon connection string — a raw postgresql:// URL is auto-upgraded
# to the psycopg driver.
DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require

# --- Auth (optional; omit for single-user "local" mode) ---------------------
CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=

# --- Email (optional) -------------------------------------------------------
# PREFERRED: Resend HTTP API — works on any host (sends over HTTPS, never blocked
# like SMTP ports). Free key at resend.com. RESEND_FROM needs a verified domain,
# or use onboarding@resend.dev to test against your own account email.
RESEND_API_KEY=
RESEND_FROM=ContentPilot <onboarding@resend.dev>
# FALLBACK: raw SMTP (used only when RESEND_API_KEY is empty). Good for local dev.
# Many hosts block outbound SMTP, so prefer Resend in production.
SMTP_HOST=                # e.g. smtp.gmail.com (use an App Password)
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=                # defaults to SMTP_USER
SMTP_FROM_NAME=ContentPilot
SMTP_USE_TLS=true
APP_BASE_URL=http://localhost:5173     # used in email links (set to your live URL on deploy)
API_BASE_URL=http://localhost:8000     # used for one-click unsubscribe links

ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

For the frontend, to enable Clerk auth create `frontend/.env`:

```ini
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
```

Without it, the app runs in single‑user local mode (no sign‑in required).

> Restart the backend after editing `.env` — settings load at startup and `--reload`
> only watches `.py` files.

---

## API overview

Full interactive docs at **http://localhost:8000/docs**. Highlights:

| Area | Endpoints |
|------|-----------|
| Generate | `POST /api/generate`, `/api/generate/stream`, `/api/generate/grounded[/stream]`, `/api/outline`, `/api/rewrite` |
| Enhance | `/api/seo/improve`, `/api/translate`, `/api/faq`, `/api/social`, `/api/competitors`, `/api/articles/{id}/cover`, `/api/articles/{id}/section-images` |
| Agent | `POST /api/edit/chat`, `POST /api/agent/plan` |
| Library | `GET/POST/PUT/DELETE /api/articles`, `POST /api/library/ask` (RAG) |
| Chat history | `GET/POST/PUT/PATCH/DELETE /api/chat/sessions` |
| Analytics | `GET /api/stats` |
| Email | `/api/notify/status`, `/api/notify/test`, `/api/notify/digest`, `/api/notify/subscription`, `/api/notify/unsubscribe` |
| Health | `GET /api/health` |

Example — `POST /api/generate`:

```json
{
  "topic": "Benefits of remote work",
  "keywords": ["remote work", "productivity"],
  "tone": "informative",
  "length": "medium",
  "audience": "startup founders"
}
```

---

## Architecture notes

- **Provider chain:** text generation tries **Groq** first, falls back to **Gemini**.
  Web grounding and images use Gemini/Pollinations (Groq supports neither). Embeddings
  for RAG use Gemini `gemini-embedding-001`.
- **RAG:** article embeddings are cached in a separate table and computed lazily (only for
  new/edited articles). Similarity search runs in Python — fine for a personal library;
  swap in pgvector for large scale.
- **Chat history:** each mode + article is an independent set of sessions stored as JSON
  blobs (`ChatSession`), so rich message shapes (tool steps, sources) round‑trip intact.
- **Scheduler:** an in‑process APScheduler job runs hourly and emails subscribers whose
  chosen local day + hour is due. It only fires while the backend is running — deploy the
  backend somewhere always‑on for reliable delivery.

---

## Notes

- Use a Gemini **flash** model — `-pro` models have 0 free‑tier quota and 429 on the first
  request.
- Never commit `.env`. Type secrets (API keys, SMTP app passwords) directly into the file.

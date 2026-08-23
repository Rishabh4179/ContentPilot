"""FastAPI application exposing the AI article generation API."""
import re
from contextlib import asynccontextmanager

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlmodel import Session

from .auth import get_current_user_id
from .config import get_settings
from .db import get_session, init_db
from .models import Article, ArticleRead
from .routers import articles, chat, library, notify, stats
from .routers.notify import deliver_digests
from .schemas import (
    AgentPlanRequest,
    AgentPlanResponse,
    ClarifyRequest,
    ClarifyResponse,
    CompetitorRequest,
    CompetitorResponse,
    EditChatRequest,
    EditChatResponse,
    FaqRequest,
    FaqResponse,
    GenerateRequest,
    GenerateResponse,
    HealthResponse,
    KeywordSuggestRequest,
    KeywordSuggestResponse,
    OutlineExpandRequest,
    OutlineResponse,
    RewriteRequest,
    RewriteResponse,
    SectionImagesResponse,
    SeoImproveRequest,
    SeoImproveResponse,
    SocialRequest,
    SocialResponse,
    SuggestRequest,
    TranslateRequest,
    TranslateResponse,
)
from .services.generator import ArticleGenerator
from .services.storage import SupabaseStorage

settings = get_settings()

# In-process scheduler for the recurring digest email.
_scheduler = BackgroundScheduler(daemon=True)


def _digest_dispatch_job() -> None:
    """Runs hourly; sends to subscribers whose local day+hour is now."""
    try:
        summary = deliver_digests()
        print(f"[digest] hourly dispatch: {summary}")
    except Exception as exc:  # noqa: BLE001 - a scheduler job must not crash the loop
        print(f"[digest] hourly dispatch failed: {exc}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    # Run at the top of every hour; the job matches each subscriber's chosen
    # weekday + hour in their own timezone. Idempotent across reloads.
    _scheduler.add_job(
        _digest_dispatch_job,
        CronTrigger(minute=0),
        id="digest_dispatch",
        replace_existing=True,
        misfire_grace_time=1800,
    )
    if not _scheduler.running:
        _scheduler.start()
    try:
        yield
    finally:
        _scheduler.shutdown(wait=False)


app = FastAPI(title="ContentPilot", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(articles.router)
app.include_router(stats.router)
app.include_router(notify.router)
app.include_router(library.router)
app.include_router(chat.router)

# Generated images are stored in Supabase Storage so they persist across
# redeploys and work on serverless hosts. No local disk is used.
storage = SupabaseStorage(settings)

generator = ArticleGenerator(settings)


@app.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    provider = "groq" if settings.groq_api_key else "gemini"
    return HealthResponse(status="ok", provider=provider)


@app.post("/api/clarify", response_model=ClarifyResponse)
def clarify(
    req: ClarifyRequest,
    user_id: str = Depends(get_current_user_id),
) -> ClarifyResponse:
    try:
        return generator.clarify_topic(req.topic)
    except Exception:  # noqa: BLE001 - clarify must never block generation
        return ClarifyResponse(ambiguous=False)


@app.post("/api/generate", response_model=GenerateResponse)
def generate(
    req: GenerateRequest,
    user_id: str = Depends(get_current_user_id),
) -> GenerateResponse:
    try:
        return generator.generate(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        status = getattr(exc, "status_code", None)
        if status == 429:
            raise HTTPException(
                status_code=429,
                detail=(
                    "Gemini quota/rate limit exceeded. On the free tier use gemini-2.5-flash — "
                    "other models (e.g. gemini-2.0-flash, gemini-2.5-pro) can have a 0 free-tier quota."
                ),
            ) from exc
        if status in (401, 403):
            raise HTTPException(
                status_code=401,
                detail="Gemini rejected the API key. Verify GEMINI_API_KEY in backend/.env.",
            ) from exc
        raise HTTPException(status_code=502, detail=f"Generation failed: {exc}") from exc


@app.post("/api/generate/grounded", response_model=GenerateResponse)
def generate_grounded(
    req: GenerateRequest,
    user_id: str = Depends(get_current_user_id),
) -> GenerateResponse:
    try:
        return generator.generate_grounded(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        status = getattr(exc, "status_code", None)
        if status == 429:
            raise HTTPException(
                status_code=429,
                detail="Gemini quota/rate limit exceeded. On the free tier use gemini-2.5-flash.",
            ) from exc
        raise HTTPException(
            status_code=502, detail=f"Grounded generation failed: {exc}"
        ) from exc


@app.post("/api/generate/grounded/stream")
def generate_grounded_stream(
    req: GenerateRequest,
    user_id: str = Depends(get_current_user_id),
) -> StreamingResponse:
    chunks = generator.stream_generate_grounded(req)
    try:
        first = next(chunks)
    except StopIteration:
        first = ""
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        status = getattr(exc, "status_code", None)
        if status == 429:
            raise HTTPException(
                status_code=429,
                detail="Gemini quota/rate limit exceeded. On the free tier use gemini-2.5-flash.",
            ) from exc
        raise HTTPException(
            status_code=502, detail=f"Grounded generation failed: {exc}"
        ) from exc

    def body():
        if first:
            yield first
        try:
            yield from chunks
        except Exception as exc:  # noqa: BLE001
            yield f"\n\n[[STREAM_ERROR]] {exc}"

    return StreamingResponse(body(), media_type="text/plain; charset=utf-8")


@app.post("/api/generate/stream")
def generate_stream(
    req: GenerateRequest,
    user_id: str = Depends(get_current_user_id),
) -> StreamingResponse:
    chunks = generator.stream_generate(req)
    try:
        first = next(chunks)
    except StopIteration:
        first = ""
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        status = getattr(exc, "status_code", None)
        if status == 429:
            raise HTTPException(
                status_code=429,
                detail="Gemini quota/rate limit exceeded. On the free tier use gemini-2.5-flash.",
            ) from exc
        raise HTTPException(status_code=502, detail=f"Generation failed: {exc}") from exc

    def body():
        if first:
            yield first
        try:
            yield from chunks
        except Exception as exc:  # noqa: BLE001
            yield f"\n\n[[STREAM_ERROR]] {exc}"

    return StreamingResponse(body(), media_type="text/plain; charset=utf-8")


@app.post("/api/rewrite", response_model=RewriteResponse)
def rewrite(
    req: RewriteRequest,
    user_id: str = Depends(get_current_user_id),
) -> RewriteResponse:
    try:
        return generator.rewrite_section(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        status = getattr(exc, "status_code", None)
        if status == 429:
            raise HTTPException(
                status_code=429,
                detail="Gemini quota/rate limit exceeded. On the free tier use gemini-2.5-flash.",
            ) from exc
        raise HTTPException(status_code=502, detail=f"Rewrite failed: {exc}") from exc


@app.post("/api/outline", response_model=OutlineResponse)
def outline(
    req: GenerateRequest,
    user_id: str = Depends(get_current_user_id),
) -> OutlineResponse:
    try:
        return generator.generate_outline(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        status = getattr(exc, "status_code", None)
        if status == 429:
            raise HTTPException(
                status_code=429,
                detail="Gemini quota/rate limit exceeded. On the free tier use gemini-2.5-flash.",
            ) from exc
        raise HTTPException(status_code=502, detail=f"Outline failed: {exc}") from exc


@app.post("/api/outline/suggest", response_model=OutlineResponse)
def suggest(
    req: SuggestRequest,
    user_id: str = Depends(get_current_user_id),
) -> OutlineResponse:
    try:
        return generator.suggest_sections(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        status = getattr(exc, "status_code", None)
        if status == 429:
            raise HTTPException(
                status_code=429,
                detail="Gemini quota/rate limit exceeded. On the free tier use gemini-2.5-flash.",
            ) from exc
        raise HTTPException(status_code=502, detail=f"Suggestion failed: {exc}") from exc


@app.post("/api/keywords/suggest", response_model=KeywordSuggestResponse)
def suggest_keywords(
    req: KeywordSuggestRequest,
    user_id: str = Depends(get_current_user_id),
) -> KeywordSuggestResponse:
    try:
        return generator.suggest_keywords(req)
    except Exception:  # noqa: BLE001 - keyword hints must never hard-fail the form
        return KeywordSuggestResponse(keywords=[])


@app.post("/api/articles/{article_id}/cover", response_model=ArticleRead)
def make_cover(
    article_id: int,
    user_id: str = Depends(get_current_user_id),
    session: Session = Depends(get_session),
) -> Article:
    article = session.get(Article, article_id)
    if not article or article.user_id != user_id:
        raise HTTPException(status_code=404, detail="Article not found")

    if not storage.configured:
        raise HTTPException(
            status_code=503,
            detail="Image storage (Supabase) is not configured on the server.",
        )

    prompt = generator.build_cover_prompt(
        title=article.title,
        topic=article.topic,
        keywords=article.keywords,
        content=article.markdown,
    )
    try:
        data, mime = generator.generate_cover_image(prompt)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        status = getattr(exc, "status_code", None)
        if status == 429:
            raise HTTPException(
                status_code=429,
                detail="Image quota/rate limit exceeded. Try again shortly.",
            ) from exc
        raise HTTPException(status_code=502, detail=f"Cover generation failed: {exc}") from exc

    try:
        article.cover_url = storage.upload(
            data,
            mime,
            name_hint=f"{article.title or article.topic}-cover",
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Image upload failed: {exc}") from exc
    session.add(article)
    session.commit()
    session.refresh(article)
    return article


@app.post("/api/articles/{article_id}/section-images", response_model=SectionImagesResponse)
def make_section_images(
    article_id: int,
    user_id: str = Depends(get_current_user_id),
    session: Session = Depends(get_session),
) -> SectionImagesResponse:
    article = session.get(Article, article_id)
    if not article or article.user_id != user_id:
        raise HTTPException(status_code=404, detail="Article not found")
    if not storage.configured:
        raise HTTPException(
            status_code=503,
            detail="Image storage (Supabase) is not configured on the server.",
        )
    try:
        new_markdown, image_urls = generator.generate_section_images(
            title=article.title,
            topic=article.topic,
            keywords=article.keywords,
            markdown=article.markdown,
            upload=storage.upload,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        status = getattr(exc, "status_code", None)
        if status == 429:
            raise HTTPException(
                status_code=429, detail="Image quota/rate limit exceeded. Try again shortly."
            ) from exc
        raise HTTPException(
            status_code=502, detail=f"Section images failed: {exc}"
        ) from exc
    if not image_urls:
        raise HTTPException(status_code=400, detail="No sections were suitable for images.")
    article.markdown = new_markdown
    article.word_count = len(re.findall(r"\b\w+\b", new_markdown))
    session.add(article)
    session.commit()
    session.refresh(article)
    return SectionImagesResponse(
        markdown=new_markdown,
        word_count=article.word_count,
        image_urls=image_urls,
    )


@app.post("/api/faq", response_model=FaqResponse)
def faq(
    req: FaqRequest,
    user_id: str = Depends(get_current_user_id),
) -> FaqResponse:
    try:
        return generator.generate_faq(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        status = getattr(exc, "status_code", None)
        if status == 429:
            raise HTTPException(
                status_code=429, detail="Rate limit exceeded. Try again shortly."
            ) from exc
        raise HTTPException(status_code=502, detail=f"FAQ generation failed: {exc}") from exc


@app.post("/api/social", response_model=SocialResponse)
def social(
    req: SocialRequest,
    user_id: str = Depends(get_current_user_id),
) -> SocialResponse:
    try:
        return generator.generate_social(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        status = getattr(exc, "status_code", None)
        if status == 429:
            raise HTTPException(
                status_code=429, detail="Rate limit exceeded. Try again shortly."
            ) from exc
        raise HTTPException(status_code=502, detail=f"Social generation failed: {exc}") from exc


@app.post("/api/seo/improve", response_model=SeoImproveResponse)
def improve_seo(
    req: SeoImproveRequest,
    user_id: str = Depends(get_current_user_id),
) -> SeoImproveResponse:
    try:
        return generator.improve_seo(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        status = getattr(exc, "status_code", None)
        if status == 429:
            raise HTTPException(
                status_code=429, detail="Rate limit exceeded. Try again shortly."
            ) from exc
        raise HTTPException(status_code=502, detail=f"SEO improve failed: {exc}") from exc


@app.post("/api/translate", response_model=TranslateResponse)
def translate(
    req: TranslateRequest,
    user_id: str = Depends(get_current_user_id),
) -> TranslateResponse:
    try:
        return generator.translate(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        status = getattr(exc, "status_code", None)
        if status == 429:
            raise HTTPException(
                status_code=429, detail="Rate limit exceeded. Try again shortly."
            ) from exc
        raise HTTPException(status_code=502, detail=f"Translation failed: {exc}") from exc


@app.post("/api/competitors", response_model=CompetitorResponse)
def competitors(
    req: CompetitorRequest,
    user_id: str = Depends(get_current_user_id),
) -> CompetitorResponse:
    try:
        return generator.analyze_competitors(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        status = getattr(exc, "status_code", None)
        if status == 429:
            raise HTTPException(
                status_code=429, detail="Rate limit exceeded. Try again shortly."
            ) from exc
        raise HTTPException(
            status_code=502, detail=f"Competitor analysis failed: {exc}"
        ) from exc


@app.post("/api/edit/chat", response_model=EditChatResponse)
def edit_chat(
    req: EditChatRequest,
    user_id: str = Depends(get_current_user_id),
) -> EditChatResponse:
    try:
        return generator.edit_chat(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        status = getattr(exc, "status_code", None)
        if status == 429:
            raise HTTPException(
                status_code=429, detail="Rate limit exceeded. Try again shortly."
            ) from exc
        raise HTTPException(status_code=502, detail=f"Editor chat failed: {exc}") from exc


@app.post("/api/agent/plan", response_model=AgentPlanResponse)
def agent_plan(
    req: AgentPlanRequest,
    user_id: str = Depends(get_current_user_id),
) -> AgentPlanResponse:
    """Route a chat message to a natural-language reply + optional tool calls
    the frontend will execute (translate, improve_seo, section_images, social,
    faq, competitors, edit)."""
    try:
        return generator.plan_agent_actions(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        status = getattr(exc, "status_code", None)
        if status == 429:
            raise HTTPException(
                status_code=429, detail="Rate limit exceeded. Try again shortly."
            ) from exc
        raise HTTPException(status_code=502, detail=f"Agent planning failed: {exc}") from exc


@app.post("/api/expand/stream")
def expand_stream(
    req: OutlineExpandRequest,
    user_id: str = Depends(get_current_user_id),
) -> StreamingResponse:
    chunks = generator.stream_generate_from_outline(req)
    try:
        first = next(chunks)
    except StopIteration:
        first = ""
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        status = getattr(exc, "status_code", None)
        if status == 429:
            raise HTTPException(
                status_code=429,
                detail="Gemini quota/rate limit exceeded. On the free tier use gemini-2.5-flash.",
            ) from exc
        raise HTTPException(status_code=502, detail=f"Generation failed: {exc}") from exc

    def body():
        if first:
            yield first
        try:
            yield from chunks
        except Exception as exc:  # noqa: BLE001
            yield f"\n\n[[STREAM_ERROR]] {exc}"

    return StreamingResponse(body(), media_type="text/plain; charset=utf-8")

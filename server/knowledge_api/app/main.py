import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.config import settings
from app.db import init_db, insert_chunks, search_chunks
from app.embed import chunk_text, embed_texts


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


api_app = FastAPI(title="Bambook Knowledge API", version="0.1.0", lifespan=lifespan)


def _parse_origins() -> list[str]:
    raw = settings.allowed_origins.strip()
    if raw == "*":
        return ["*"]
    return [o.strip() for o in raw.split(",") if o.strip()]


api_app.add_middleware(
    CORSMiddleware,
    allow_origins=_parse_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class IngestBody(BaseModel):
    title: str | None = None
    text: str = Field(..., min_length=1)
    metadata: dict[str, Any] = Field(default_factory=dict)


class SearchBody(BaseModel):
    query: str = Field(..., min_length=1)
    top_k: int | None = None


class ChatBody(BaseModel):
    message: str = Field(..., min_length=1)


def verify_bearer(authorization: Annotated[str | None, Header()] = None) -> None:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    if token != settings.api_key:
        raise HTTPException(status_code=401, detail="Invalid API key")


@api_app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


_HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
}


@api_app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def main_data_proxy(path: str, request: Request):
    """Proxy /bambook/api/* to the Node main data API on 8081."""
    target = f"{settings.main_data_api_base.rstrip('/')}/api/{path}"
    if request.url.query:
        target = f"{target}?{request.url.query}"

    headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in _HOP_BY_HOP_HEADERS
    }
    body = await request.body()
    client = httpx.AsyncClient(timeout=None)
    upstream = await client.send(
        client.build_request(request.method, target, headers=headers, content=body),
        stream=True,
    )

    response_headers = {
        key: value
        for key, value in upstream.headers.items()
        if key.lower() not in _HOP_BY_HOP_HEADERS
    }

    async def stream():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        stream(),
        status_code=upstream.status_code,
        headers=response_headers,
        media_type=upstream.headers.get("content-type"),
    )


@api_app.post("/v1/knowledge/ingest")
async def ingest(
    body: IngestBody,
    _: None = Depends(verify_bearer),
) -> dict[str, Any]:
    chunks = chunk_text(body.text, settings.chunk_max_chars)
    if not chunks:
        raise HTTPException(status_code=400, detail="Empty text after chunking")
    vectors = await embed_texts(chunks)
    rows: list[tuple[str | None, str, dict[str, Any], list[float]]] = []
    for i, (chunk, vec) in enumerate(zip(chunks, vectors, strict=True)):
        meta = dict(body.metadata)
        meta["chunk_index"] = i
        rows.append((body.title, chunk, meta, vec))
    n = insert_chunks(rows)
    return {"inserted_chunks": n}


@api_app.post("/v1/knowledge/search")
async def search(
    body: SearchBody,
    _: None = Depends(verify_bearer),
) -> dict[str, Any]:
    k = body.top_k if body.top_k is not None else settings.rag_top_k
    k = max(1, min(k, 50))
    qvec = (await embed_texts([body.query]))[0]
    hits = search_chunks(qvec, k)
    return {"results": hits}


async def _deepseek_stream(messages: list[dict[str, str]]) -> AsyncIterator[str]:
    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream(
            "POST",
            f"{settings.deepseek_base.rstrip('/')}/chat/completions",
            headers={"Authorization": f"Bearer {settings.deepseek_api_key}"},
            json={
                "model": settings.deepseek_model,
                "messages": messages,
                "stream": True,
            },
        ) as resp:
            if resp.status_code >= 400:
                body = await resp.aread()
                raise HTTPException(
                    status_code=502,
                    detail=f"DeepSeek error {resp.status_code}: {body.decode(errors='replace')[:500]}",
                )
            async for line in resp.aiter_lines():
                if not line or line.startswith(":"):
                    continue
                if not line.startswith("data: "):
                    continue
                payload = line.removeprefix("data: ").strip()
                if payload == "[DONE]":
                    break
                try:
                    obj = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                choices = obj.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
                content = delta.get("content")
                if content:
                    yield content


@api_app.post("/v1/chat")
async def chat(
    body: ChatBody,
    _: None = Depends(verify_bearer),
):
    if not settings.deepseek_api_key.strip():
        raise HTTPException(
            status_code=503,
            detail="DEEPSEEK_API_KEY is not configured on the server",
        )
    k = settings.rag_top_k
    qvec = (await embed_texts([body.message]))[0]
    hits = search_chunks(qvec, k)
    context_blocks = []
    for h in hits:
        title = h.get("source_title") or ""
        prefix = f"[{title}]\n" if title else ""
        context_blocks.append(prefix + (h.get("content") or ""))
    context = "\n\n---\n\n".join(context_blocks).strip()
    system = (
        "你是公司内部助手。请优先依据「资料片段」回答；若资料不足，明确说明并给出安全的一般建议。"
    )
    user = f"资料片段：\n{context}\n\n用户问题：\n{body.message}"
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]

    async def gen():
        async for piece in _deepseek_stream(messages):
            yield piece

    return StreamingResponse(gen(), media_type="text/plain; charset=utf-8")


@api_app.post("/v1/chat/debug-context")
async def chat_debug_context(
    body: ChatBody,
    _: None = Depends(verify_bearer),
) -> dict[str, Any]:
    """Return retrieved chunks without calling LLM (for latency testing)."""
    k = settings.rag_top_k
    qvec = (await embed_texts([body.message]))[0]
    hits = search_chunks(qvec, k)
    return {"results": hits}


_mount = settings.url_mount_path.strip()
if not _mount.startswith("/"):
    _mount = "/" + _mount

app = FastAPI()
app.mount(_mount, api_app)

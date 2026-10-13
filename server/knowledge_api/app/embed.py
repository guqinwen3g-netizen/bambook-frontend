import httpx

from app.config import settings


async def embed_texts(texts: list[str]) -> list[list[float]]:
    """Call Ollama /api/embeddings for each text (small batches acceptable)."""
    out: list[list[float]] = []
    async with httpx.AsyncClient(timeout=120.0) as client:
        for t in texts:
            r = await client.post(
                f"{settings.ollama_base}/api/embeddings",
                json={"model": settings.embed_model, "prompt": t},
            )
            r.raise_for_status()
            data = r.json()
            vec = data.get("embedding")
            if not vec:
                raise RuntimeError("Ollama returned no embedding")
            out.append(vec)
    return out


def chunk_text(text: str, max_chars: int) -> list[str]:
    """Fixed-size chunks for MVP; overlap can be added later."""
    text = text.strip()
    if not text:
        return []
    return [text[i : i + max_chars] for i in range(0, len(text), max_chars)]

import json
from typing import Any

import psycopg2
from pgvector.psycopg2 import register_vector

from app.config import settings


def _vec_literal(values: list[float]) -> str:
    return "[" + ",".join(f"{float(x):.8g}" for x in values) + "]"


def get_conn():
    conn = psycopg2.connect(settings.database_url)
    register_vector(conn)
    return conn


def init_db() -> None:
    dim = int(settings.embed_dim)
    conn = psycopg2.connect(settings.database_url)
    conn.autocommit = True
    register_vector(conn)
    try:
        with conn.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
            cur.execute(
                f"""
                CREATE TABLE IF NOT EXISTS kb_chunks (
                  id BIGSERIAL PRIMARY KEY,
                  source_title TEXT,
                  content TEXT NOT NULL,
                  metadata JSONB NOT NULL DEFAULT '{{}}',
                  embedding vector({dim}) NOT NULL,
                  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            cur.execute(
                """
                CREATE INDEX IF NOT EXISTS kb_chunks_hnsw_idx
                ON kb_chunks USING hnsw (embedding vector_cosine_ops)
                """
            )
    finally:
        conn.close()


def insert_chunks(
    rows: list[tuple[str | None, str, dict[str, Any], list[float]]],
) -> int:
    """rows: (source_title, content, metadata, embedding)"""
    if not rows:
        return 0
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO kb_chunks (source_title, content, metadata, embedding)
                VALUES (%s, %s, %s::jsonb, %s)
                """,
                [
                    (
                        title,
                        content,
                        json.dumps(meta, ensure_ascii=False),
                        embedding,
                    )
                    for title, content, meta, embedding in rows
                ],
            )
        conn.commit()
    return len(rows)


def search_chunks(query_embedding: list[float], top_k: int) -> list[dict[str, Any]]:
    qlit = _vec_literal(query_embedding)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, source_title, content, metadata,
                       1 - (embedding <=> (%s)::vector) AS score
                FROM kb_chunks
                ORDER BY embedding <=> (%s)::vector
                LIMIT %s
                """,
                (qlit, qlit, top_k),
            )
            rows = cur.fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        out.append(
            {
                "id": r[0],
                "source_title": r[1],
                "content": r[2],
                "metadata": r[3],
                "score": float(r[4]) if r[4] is not None else 0.0,
            }
        )
    return out

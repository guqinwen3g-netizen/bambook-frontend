#!/usr/bin/env python3
"""
ingest-content-v2.py — 将 content/ 下的领域知识 Markdown 源文件灌入 v2 RAG (pgvector + bge-m3)。

适配 v2 API：
  POST /v2/knowledge/ingest  (text 模式, content_hash 自动去重)

v2 category 枚举映射（七域 → v2）:
  fabric → fabric_knowledge
  garments → general
  trade-process → process
  trade-compliance → standard
  customers-market → general
  suppliers → general
  company → policy

用法（在 Mac mini 本机）:
  KB_API_KEY=xxx python3 ingest-content-v2.py
  KB_API_KEY=xxx python3 ingest-content-v2.py --dry-run
"""
import argparse
import hashlib
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

CONTENT_DIR = Path(__file__).resolve().parent.parent / "content"

CATEGORY_MAP = {
    "fabric": "fabric_knowledge",
    "garments": "general",
    "trade-process": "process",
    "trade-compliance": "standard",
    "customers-market": "general",
    "suppliers": "general",
    "company": "policy",
}

SCOPE_MAP = {
    "fabric": "internal",
    "garments": "internal",
    "trade-process": "internal",
    "trade-compliance": "internal",
    "customers-market": "confidential",
    "suppliers": "confidential",
    "company": "internal",
}


def parse_frontmatter(text):
    if not text.startswith("---"):
        return {}, text
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text
    raw_meta, body = parts[1], parts[2]
    meta = {}
    for line in raw_meta.strip().splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()
        if value.startswith("[") and value.endswith("]"):
            inner = value[1:-1].strip()
            meta[key] = [x.strip().strip("'\"") for x in inner.split(",") if x.strip()]
        else:
            meta[key] = value.strip().strip("'\"")
    return meta, body.strip()


def ingest_v2(base, api_key, title, text, category, scope, tags, path):
    url = base.rstrip("/") + "/v2/knowledge/ingest"
    payload = {
        "source_type": "manual",
        "text": text,
        "title": title,
        "category": category,
        "scope": scope,
        "meta": {"tags": tags, "path": path, "sourceType": "curated"},
    }
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--content", default=str(CONTENT_DIR))
    ap.add_argument("--base", default=os.environ.get("KB_API_BASE", "http://127.0.0.1:8091/bambook/kb"))
    ap.add_argument("--key", default=os.environ.get("KB_API_KEY", ""))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    content_dir = Path(args.content)
    md_files = sorted(p for p in content_dir.rglob("*.md") if p.name != "_taxonomy.md")
    if not md_files:
        print("未找到 .md 文件")
        return 1

    if args.dry_run:
        print(f"[dry-run] 待灌入 {len(md_files)} 个文件:")
        for p in md_files:
            meta, _ = parse_frontmatter(p.read_text("utf-8"))
            cat = CATEGORY_MAP.get(meta.get("category", "company"), "general")
            print(f"  {p.relative_to(content_dir)}  →  category={cat}")
        return 0

    if not args.key:
        print("缺少 KB_API_KEY", file=sys.stderr)
        return 2

    ok = fail = deduped = 0
    for path in md_files:
        text = path.read_text("utf-8")
        meta, body = parse_frontmatter(text)
        domain = meta.get("category", "company")
        category = CATEGORY_MAP.get(domain, "general")
        scope = SCOPE_MAP.get(domain, "internal")
        title = meta.get("title", path.stem)
        tags = meta.get("tags", [])
        rel = str(path.relative_to(content_dir))
        try:
            result = ingest_v2(args.base, args.key, title, body, category, scope, tags, rel)
            if result.get("deduped"):
                print(f"  = {rel}  → 去重跳过 (已存在)")
                deduped += 1
            else:
                print(f"  + {rel}  → doc#{result.get('document_id')} chunks={result.get('inserted_chunks')}")
                ok += 1
        except Exception as e:
            print(f"  x {rel}  → 失败: {e}", file=sys.stderr)
            fail += 1

    print(f"\n完成: 新增 {ok}, 去重 {deduped}, 失败 {fail}")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

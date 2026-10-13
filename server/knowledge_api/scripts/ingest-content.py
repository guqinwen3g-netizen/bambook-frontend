#!/usr/bin/env python3
"""
ingest-content.py — 将 content/ 下的领域知识 Markdown 源文件灌入 Python RAG（pgvector）。

用法（在 Mac mini 本机，或任意能访问公网 base 的机器）：
    python ingest-content.py                      # 默认灌入本机 http://127.0.0.1:8091/bambook/kb
    python ingest-content.py --base https://jiangsupanda.com/bambook/kb
    python ingest-content.py --dry-run            # 只统计，不真正入库
    python ingest-content.py --force              # 忽略本地状态，全部重灌（会重复入库，慎用）

环境变量：
    KB_API_BASE   默认 http://127.0.0.1:8091/bambook/kb
    KB_API_KEY    RAG 的 Bearer API Key（必填，除非 --dry-run）

幂等性：
    首次运行后会在 content 目录下写入 .ingested-state.json，记录每个文件的 checksum。
    再次运行只灌 checksum 变化的文件，避免重复入库（RAG /ingest 本身不去重）。
    若单文件内容变更，会重复新增该文件的分块——如需完全重建，可先在 RAG 端清空该来源再灌。

依赖：仅 Python 3 标准库（urllib）。无需额外 pip 安装。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

CONTENT_DIR = Path(__file__).resolve().parent.parent / "content"
STATE_FILE = CONTENT_DIR / ".ingested-state.json"
CATEGORIES = {"fabric", "garments", "trade-process", "trade-compliance",
              "customers-market", "suppliers", "company"}


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """解析极简 YAML frontmatter（key: value / key: [a, b]），返回 (meta, body)。"""
    if not text.startswith("---"):
        return {}, text
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text
    raw_meta, body = parts[1], parts[2]
    meta: dict = {}
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


def checksum(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text("utf-8"))
        except json.JSONDecodeError:
            return {}
    return {}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), "utf-8")


def ingest(base: str, api_key: str, title: str, text: str, metadata: dict) -> dict:
    url = base.rstrip("/") + "/v1/knowledge/ingest"
    payload = json.dumps({"title": title, "text": text, "metadata": metadata},
                         ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, data=payload, method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser(description="Ingest domain knowledge Markdown into the Bambook RAG.")
    ap.add_argument("--content", default=str(CONTENT_DIR), help="content 目录路径")
    ap.add_argument("--base", default=os.environ.get("KB_API_BASE", "http://127.0.0.1:8091/bambook/kb"))
    ap.add_argument("--key", default=os.environ.get("KB_API_KEY", ""))
    ap.add_argument("--dry-run", action="store_true", help="只统计，不入库")
    ap.add_argument("--force", action="store_true", help="忽略状态，全部重灌（会重复入库）")
    args = ap.parse_args()

    content_dir = Path(args.content)
    if not content_dir.is_dir():
        print(f"内容目录不存在: {content_dir}", file=sys.stderr)
        return 1

    md_files = sorted(p for p in content_dir.rglob("*.md") if p.name != "_taxonomy.md")
    if not md_files:
        print("未找到可灌入的 .md 内容文件。")
        return 1

    state = {} if args.force else load_state()
    changed: list[Path] = []
    skipped = 0
    for path in md_files:
        text = path.read_text("utf-8")
        digest = checksum(text)
        rel = str(path.relative_to(content_dir))
        if not args.force and state.get(rel) == digest:
            skipped += 1
            continue
        changed.append(path)

    if args.dry_run:
        print(f"[dry-run] 内容目录: {content_dir}")
        print(f"[dry-run] 待灌入文件: {len(changed)} 个，跳过未变更: {skipped} 个")
        for path in changed:
            print(f"  - {path.relative_to(content_dir)}")
        return 0

    if not args.key:
        print("缺少 API Key：请设置环境变量 KB_API_KEY 或传 --key（--dry-run 除外）。", file=sys.stderr)
        return 2

    ok = fail = 0
    for path in changed:
        text = path.read_text("utf-8")
        meta, body = parse_frontmatter(text)
        category = meta.get("category", "company")
        if category not in CATEGORIES:
            leaf = path.relative_to(content_dir).parts[0]
            category = leaf if leaf in CATEGORIES else "company"
        title = meta.get("title", path.stem)
        metadata = {
            "category": category,
            "tags": meta.get("tags", []),
            "sourceType": meta.get("sourceType", "curated"),
            "status": meta.get("status", "stable"),
            "path": str(path.relative_to(content_dir)),
        }
        try:
            result = ingest(args.base, args.key, title, body, metadata)
            rel = str(path.relative_to(content_dir))
            state[rel] = checksum(text)
            print(f"  ✓ {rel}  → {result}")
            ok += 1
        except Exception as e:  # noqa: BLE001
            print(f"  ✗ {path.relative_to(content_dir)}  → 失败: {e}", file=sys.stderr)
            fail += 1

    save_state(state)
    print(f"\n完成：成功 {ok}，失败 {fail}，跳过 {skipped}。")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
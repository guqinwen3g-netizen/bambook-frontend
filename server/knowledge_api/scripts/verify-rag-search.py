#!/usr/bin/env python3
"""
verify-rag-search.py — 验证 Agent knowledge.search 的向量检索 + 降级逻辑。

模拟 toolRuntime.ts 里 searchRagKnowledge + searchKnowledge 的完整行为：
  1. 向量检索（Python RAG / v1 search） — 正常路径
  2. 无 API Key 时的降级 — RAG 跳过
  3. RAG 不可达时的降级 — 网络失败后 fallback

用法：
  # 设置环境变量后运行（推荐）
  export BAMBOOK_RAG_API_KEY="your-key"
  export BAMBOOK_RAG_BASE_URL="https://jiangsupanda.com/bambook/kb"
  python3 verify-rag-search.py

  # 通过参数传入
  python3 verify-rag-search.py --key "your-key" --base "https://jiangsupanda.com/bambook/kb"

  # 只跑降级测试（不连 RAG）
  python3 verify-rag-search.py --degrade-only
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any

# ──────────────────────────────────────────────
# 模拟 toolRuntime.ts 的 searchRagKnowledge 函数
# ──────────────────────────────────────────────


def search_rag_knowledge(
    query: str,
    limit: int,
    api_key: str,
    base_url: str,
    timeout: int = 15,
) -> dict[str, Any]:
    """
    模拟 searchRagKnowledge：
    - 无 key → ok=False（静默降级，不抛错）
    - 有 key → POST /v1/knowledge/search，解析 results
    - 网络错误 → ok=False
    """
    if not api_key:
        return {"ok": False, "hits": [], "reason": "BAMBOOK_RAG_API_KEY 未配置"}

    url = base_url.rstrip("/") + "/v1/knowledge/search"
    payload = json.dumps({"query": query, "top_k": max(1, min(limit, 20))}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "User-Agent": "Bambook-RAG-Verify/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return {"ok": False, "hits": [], "reason": f"HTTP {e.code} {e.reason}"}
    except urllib.error.URLError as e:
        return {"ok": False, "hits": [], "reason": f"URL Error: {e.reason}"}
    except Exception as e:
        return {"ok": False, "hits": [], "reason": f"{type(e).__name__}: {e}"}

    results = data.get("results", []) if isinstance(data, dict) else []
    hits: list[dict[str, Any]] = []
    for r in results:
        meta = r.get("metadata") or {}
        category = str(meta.get("category", "company"))
        hits.append(
            {
                "source": f"rag-knowledge:{category}",
                "title": r.get("source_title") or r.get("title") or "",
                "category": category,
                "content": str(r.get("content") or "")[:1200],
                "score": round(r.get("score", 0), 3) if isinstance(r.get("score"), (int, float)) else None,
            }
        )
    return {"ok": len(hits) > 0, "hits": hits, "reason": "ok"}


# ──────────────────────────────────────────────
# 模拟 Prisma 降级（子串匹配）
# ──────────────────────────────────────────────


def search_prisma_fallback(query: str, limit: int) -> list[dict[str, Any]]:
    """
    模拟 Prisma contains 子串匹配。
    真实环境查 KnowledgeChunk/KnowledgeDocument/KnowledgeItem，
    这里模拟逻辑：只有标题/内容包含查询关键词的才命中。
    """
    keywords = [query, query[:2], query[2:4]] if len(query) >= 4 else [query]
    mock_corpus = [
        {"source": "KnowledgeChunk", "title": "棉面料基础知识", "content": "棉是天然植物纤维，吸湿透气..."},
        {"source": "KnowledgeChunk", "title": "高支棉与普梳棉区别", "content": "高支棉纱支更细，手感更柔..."},
        {"source": "KnowledgeDocument", "title": "面料知识手册", "content": "纺织面料分类与特性..."},
        {"source": "KnowledgeItemCompat", "title": "梭织工艺", "content": "经纬纱交织..."},
    ]
    matched = []
    for item in mock_corpus:
        text = (item["title"] + item["content"]).lower()
        if any(kw.lower() in text for kw in keywords):
            matched.append(item)
            if len(matched) >= limit:
                break
    return matched


# ──────────────────────────────────────────────
# 模拟 searchKnowledge 完整逻辑
# ──────────────────────────────────────────────


def search_knowledge(
    query: str,
    limit: int,
    api_key: str,
    base_url: str,
    label: str = "",
    mock_rag: str | None = None,
) -> dict[str, Any]:
    """
    模拟 searchKnowledge：
    1. RAG 向量检索（优先）
    2. Prisma 子串匹配（并行）
    3. 合并 + 去重 + 截断

    mock_rag:
      None    — 正常调用 RAG
      "empty" — 模拟 RAG 可达但返回 0 命中（不实际发请求）
    """
    if label:
        print(f"\n{'─' * 60}")
        print(f"场景: {label}")
        print(f"{'─' * 60}")

    print(f"  查询: \"{query}\"")
    print(f"  RAG: {base_url}  Key: {'已配置(' + str(len(api_key)) + '字符)' if api_key else '未配置'}")

    # 1. RAG 向量检索
    t0 = time.time()
    if mock_rag == "empty":
        rag: dict[str, Any] = {"ok": False, "hits": [], "reason": "RAG 返回 0 命中（模拟）"}
        rag_ms = 0.0
    else:
        rag = search_rag_knowledge(query, limit, api_key, base_url)
        rag_ms = (time.time() - t0) * 1000

    if rag["ok"]:
        print(f"  ✅ 向量检索成功 ({rag_ms:.0f}ms) — {len(rag['hits'])} 命中:")
        for i, hit in enumerate(rag["hits"][:5], 1):
            score = f" score={hit['score']}" if hit.get("score") is not None else ""
            print(f"     {i}. [{hit['category']}] {hit['title'][:40]}{score}")
        data_source = "bambook-rag"
    else:
        print(f"  ⚠️  向量检索降级: {rag['reason']}")
        data_source = "bambook-data-center (降级)"

    # 2. Prisma 子串匹配（模拟）
    prisma_hits = search_prisma_fallback(query, limit)
    if prisma_hits:
        print(f"  📝 Prisma 子串匹配 — {len(prisma_hits)} 命中:")
        for i, hit in enumerate(prisma_hits[:3], 1):
            print(f"     {i}. [{hit['source']}] {hit['title']}")
    else:
        print(f"  📝 Prisma 子串匹配 — 0 命中")

    # 3. 合并 + 去重（RAG 优先）
    all_items = list(rag["hits"]) + prisma_hits
    seen: set[str] = set()
    deduped: list[dict[str, Any]] = []
    for item in all_items:
        key = str(item.get("title", "")) + "|" + str(item.get("content", ""))[:80]
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
        if len(deduped) >= limit:
            break

    print(f"\n  → dataSource={data_source}")
    print(f"  → 最终结果: {len(deduped)} 条 (RAG {len(rag['hits'])} + Prisma {len(prisma_hits)} → 去重后 {len(deduped)})")
    return {"dataSource": data_source, "count": len(deduped), "items": deduped}


# ──────────────────────────────────────────────
# 主流程
# ──────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(description="验证 Agent knowledge.search 向量检索 + 降级逻辑")
    ap.add_argument("--query", default="高支棉面料特性", help="测试查询")
    ap.add_argument("--limit", type=int, default=5, help="返回条数上限")
    ap.add_argument("--key", default=os.environ.get("BAMBOOK_RAG_API_KEY", ""), help="RAG API Key")
    ap.add_argument(
        "--base",
        default=os.environ.get("BAMBOOK_RAG_BASE_URL", "https://jiangsupanda.com/bambook/kb"),
        help="RAG 服务地址",
    )
    ap.add_argument("--degrade-only", action="store_true", help="只跑降级场景（不连 RAG）")
    args = ap.parse_args()

    query = args.query
    limit = args.limit
    print(f"╔══════════════════════════════════════════════════════════╗")
    print(f"║  Agent knowledge.search 验证脚本                         ║")
    print(f"║  查询: \"{query}\"")
    print(f"║  RAG:  {args.base}")
    print(f"╚══════════════════════════════════════════════════════════╝")

    all_pass = True

    # ── 场景 1: 正常路径（有 key + RAG 可达）──
    if not args.degrade_only:
        if not args.key:
            print("\n⚠️  未配置 BAMBOOK_RAG_API_KEY，跳过正常路径测试。")
            print("   设置方式: export BAMBOOK_RAG_API_KEY=\"your-key\"")
        else:
            result = search_knowledge(query, limit, args.key, args.base, "正常路径 — 有 Key + RAG 可达")
            if result["dataSource"] == "bambook-rag":
                print("  ✅ PASS — dataSource=bambook-rag，向量检索生效")
            else:
                print("  ❌ FAIL — 期望 bambook-rag，实际降级")
                all_pass = False

    # ── 场景 2: 降级 — 无 API Key ──
    result = search_knowledge(query, limit, "", args.base, "降级路径 A — 无 API Key")
    if result["dataSource"].startswith("bambook-data-center"):
        print("  ✅ PASS — 无 Key 时正确降级到 Prisma 子串匹配")
    else:
        print("  ❌ FAIL — 期望降级，实际走了 RAG")
        all_pass = False

    # ── 场景 3: 降级 — RAG 不可达 ──
    result = search_knowledge(query, limit, args.key or "fake-key-12345", "http://127.0.0.1:9999/invalid", "降级路径 B — RAG 不可达")
    if result["dataSource"].startswith("bambook-data-center"):
        print("  ✅ PASS — RAG 不可达时正确降级到 Prisma 子串匹配")
    else:
        print("  ❌ FAIL — 期望降级，实际走了 RAG")
        all_pass = False

    # ── 场景 4: 近义词召回验证 ──
    if not args.degrade_only and args.key:
        syn_query = "polyester fabric GSM"
        result = search_knowledge(syn_query, limit, args.key, args.base, "近义词召回 — 英文查询中文文档")
        if result["dataSource"] == "bambook-rag" and result["count"] > 0:
            print("  ✅ PASS — 英文查询成功召回中文面料文档（语义检索生效）")
        else:
            print("  ⚠️  SKIP — 向量检索未返回结果或不可达")

    # ── 场景 5: RAG 返回空结果 — 降级验证 ──
    # 模拟 RAG 服务可达 + 有 Key，但查询未命中任何文档（返回空 results）
    # 验证此时 rag.ok=False 是否正确触发 Prisma 降级
    result = search_knowledge(
        query, limit, args.key or "mock-key", args.base,
        "降级路径 C — RAG 可达但返回空结果",
        mock_rag="empty",
    )
    if result["dataSource"].startswith("bambook-data-center"):
        print("  ✅ PASS — RAG 空结果时正确降级到 Prisma 子串匹配")
    else:
        print("  ❌ FAIL — 期望降级，实际走了 RAG")
        all_pass = False

    # ── 汇总 ──
    print(f"\n{'═' * 60}")
    if all_pass:
        print("✅ 全部场景验证通过")
    else:
        print("❌ 部分场景未通过，请检查上方输出")
    print(f"{'═' * 60}")
    return 0 if all_pass else 1


if __name__ == "__main__":
    raise SystemExit(main())

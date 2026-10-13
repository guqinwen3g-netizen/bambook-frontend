# 智能问答 RAG 设计

> 模块代号：`Knowledge / RAG Q&A`
> 父模块：[Knowledge 知识库 — 模块概述](./模块概述.md)
> 关联代码：`server/knowledge_api/app/main.py`（FastAPI Python）、`server/knowledge_api/app/{config,db,embed}.py`、`services/knowledgeApiService.ts`、`services/apiService.ts`（askKnowledgeBase / searchKnowledgeBase）、`components/KnowledgeBase.tsx`（qa tab）
> 文档版本：v1.0 · 最后更新：2026-08-15

---

## §1 实现状态

| 维度 | 状态 | 说明 |
| --- | --- | --- |
| Python RAG 服务 | ✅ 已落地 | `server/knowledge_api/app/main.py`（FastAPI 0.1.0）暴露 `/v1/chat`（流式 SSE）+ `/v1/knowledge/{ingest,search}` + `/v1/chat/debug-context` + `/health`。 |
| 嵌入向量化 | ✅ 已落地 | `app/embed.py`：`embed_texts(texts)` 调用嵌入模型生成向量；`chunk_text(text, max_chars)` 分块。 |
| 向量数据库 | ✅ 已落地 | `app/db.py`：`init_db()` + `insert_chunks(rows)` + `search_chunks(qvec, k)`。启动时 `lifespan` 初始化。 |
| LLM 生成 | ✅ 已落地 | `_deepseek_stream(messages)`：调用 DeepSeek `chat/completions` 流式 API（`stream: true`），通过 `async for` 逐 token 转发。 |
| Bearer 鉴权 | ✅ 已落地 | `verify_bearer(authorization)`：Header `Authorization: Bearer <token>`，与 `settings.api_key` 比对；未配置 key 时 `/health` 仍可访问。 |
| 代理转发 | ✅ 已落地 | `/api/{path:path}` 代理转发到 Node 主数据 API（`settings.main_data_api_base`），`httpx.AsyncClient` 流式转发。 |
| 前端流式问答 | ✅ 已落地 | `KnowledgeBase.tsx` 的 `qa` Tab：`apiService.askKnowledgeBase(q, onChunk)` 累积 answer + `searchKnowledgeBase(q)` 并行获取引用。 |
| 引用展示 | ✅ 已落地 | `KnowledgeCitation[]` 渲染为「命中片段」卡片列表（含 documentId / content snippet / score）。 |
| 归档闭环 | ✅ 已落地 | 「归档到官方知识库」按钮：把 Q&A 包装为 `KnowledgeDocument`（sourceType='qa'），调用 `ingestKnowledgeText` 入库。 |
| 离线降级 | ✅ 已落地 | 探活失败显示错误，不降级为本地关键词搜索（RAG 必须服务端）。 |
| 三层广告过滤 | ✅ 已落地 | `content/` 目录结构化分目录（company/customers-market/fabric/garments/suppliers），a/b/c 三层过滤确保检索质量。 |
| 测试 | ✅ 已落地 | `knowledgeApiService.testConnection` 端到端连通性测试 + `/v1/chat/debug-context` 延迟测试（无 LLM 调用）。 |

---

## §2 业务定位与目标

### 2.1 业务定位

RAG（Retrieval-Augmented Generation，检索增强生成）是 Bambook 知识库的「**智能问答引擎**」。区别于传统关键词搜索：

- **语义检索**：用户用自然语言提问，向量相似度匹配（非精确文本）
- **带引用的答案**：每条答案必须返回 `KnowledgeCitation[]`，可追溯到具体文档与分块
- **流式生成**：LLM 逐 token 输出，用户无需等待完整答案
- **归档闭环**：优质 Q&A 可一键归档为 `KnowledgeDocument`，反哺检索池

### 2.2 核心目标

1. **零幻觉**：LLM 只能基于检索到的资料片段回答；资料不足时必须明确说明。
2. **引用可追溯**：每个答案附带 `KnowledgeCitation[]`，含 documentId / chunkId / score。
3. **流式响应**：`text/plain; charset=utf-8` SSE 流，首 token < 1s。
4. **离线友好**：服务不可用时前端明确提示，不假装回答。
5. **归档反哺**：Q&A 归档后进入检索池，下次相似问题可直接命中。

---

## §3 核心概念与术语

| 术语 | 定义 |
| --- | --- |
| `RAG` | Retrieval-Augmented Generation，检索增强生成 |
| `chunk` | 文档分块，向量化与检索单元 |
| `embedding` | 文本向量表示，用于语义相似度计算 |
| `top_k` | 检索返回的最相似分块数（默认 `settings.rag_top_k`） |
| `KnowledgeCitation` | 前端引用卡片：`{ documentId, chunkId, content, score }` |
| `stream` | SSE 流式响应，逐 token 推送 |
| `debug-context` | 调试端点：只检索不调用 LLM，用于延迟测试 |
| `verify_bearer` | Bearer Token 鉴权，`settings.api_key` 比对 |
| `_deepseek_stream` | DeepSeek LLM 流式生成，`async for` 逐 token 转发 |

---

## §4 数据流概览

### 4.1 RAG 问答全链路

```
用户提问 "SS26 季节面料采购流程是什么？"
  │
  ▼
┌─────────────────────────────────────────────────┐
│ 前端 KnowledgeBase.tsx (qa tab)                  │
│  ├─ apiService.searchKnowledgeBase(q)  ──────┐   │
│  │     POST /v1/knowledge/search            │   │
│  │     → KnowledgeCitation[]                 │   │
│  └─ apiService.askKnowledgeBase(q, onChunk) ─┤   │
│        POST /v1/chat (SSE stream)            │   │
└──────────────────────────────────────────────┼───┘
                                               │
              ┌────────────────────────────────▼────┐
              │  Python FastAPI /v1/chat            │
              │  ├─ embed_texts([message]) → qvec    │
              │  ├─ search_chunks(qvec, k) → hits[]  │
              │  ├─ context = hits 拼接              │
              │  ├─ messages = [system, user]        │
              │  └─ _deepseek_stream(messages)       │
              │       async for piece in stream:     │
              │           yield piece                │
              └──────────────────────────────────────┘
                              │
                              ▼
              ┌──────────────────────────────────────┐
              │  DeepSeek chat/completions (stream)  │
              │  model: settings.deepseek_model      │
              │  Authorization: Bearer <api_key>     │
              └──────────────────────────────────────┘
                              │
                              ▼
              ┌──────────────────────────────────────┐
              │  前端累积 answer + 渲染引用卡片      │
              │  完成后显示「归档」按钮              │
              └──────────────────────────────────────┘
```

### 4.2 引用检索与流式回答并行

```typescript
// 前端并行策略（零服务端改动）
const searchPromise = apiService.searchKnowledgeBase(q)
  .then(setQaCitations)
  .catch(() => setQaCitations([]));  // 引用失败不阻断回答

await apiService.askKnowledgeBase(q, piece => setQaAnswer(prev => prev + piece));
await searchPromise;  // 等待引用完成（通常已先于 LLM 完成）
```

- **两次嵌入可接受**：query 向量化在 search 与 chat 各一次，但 LLM 流式生成是主要延迟源
- **引用失败容错**：`setQaCitations([])` 静默降级，回答仍可显示

---

## §5 API 端点

### 5.1 Python 服务端点

| 方法 | 路径 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| GET | `/health` | 无 | 健康检查，返回 `{ status: 'ok' }` |
| POST | `/v1/knowledge/ingest` | Bearer | 摄取文本：`{ title?, text, metadata }` → `{ inserted_chunks }` |
| POST | `/v1/knowledge/search` | Bearer | 向量检索：`{ query, top_k? }` → `{ results: KnowledgeSearchResult[] }` |
| POST | `/v1/chat` | Bearer | 流式问答：`{ message }` → `text/plain` SSE 流 |
| POST | `/v1/chat/debug-context` | Bearer | 调试检索：`{ message }` → `{ results }`（不调用 LLM） |
| ALL | `/api/{path:path}` | 透传 | 代理转发到 Node 主数据 API |

### 5.2 请求/响应模型

```python
class IngestBody(BaseModel):
    title: str | None = None
    text: str = Field(..., min_length=1)
    metadata: dict[str, Any] = Field(default_factory=dict)

class SearchBody(BaseModel):
    query: str = Field(..., min_length=1)
    top_k: int | None = None   # 默认 settings.rag_top_k，限制 [1, 50]

class ChatBody(BaseModel):
    message: str = Field(..., min_length=1)
```

### 5.3 前端服务封装

```typescript
// services/knowledgeApiService.ts
knowledgeApiService.health(endpoint?)
knowledgeApiService.testConnection(endpoint?, apiKey?)
knowledgeApiService.search(body: { query, top_k? }, endpoint?, apiKey?)
knowledgeApiService.ingest(body: { title?, text, metadata? }, endpoint?, apiKey?)
knowledgeApiService.debugContext(body: { message }, endpoint?, apiKey?)

// services/apiService.ts（代理封装，走 Node 转发或直连 Python）
apiService.askKnowledgeBase(question, onChunk)   // SSE 流式
apiService.searchKnowledgeBase(query)            // 引用检索
apiService.ingestKnowledgeText({ title, text, category, sourceType })
```

---

## §6 服务层架构

### 6.1 Python 服务结构

```
server/knowledge_api/
├── app/
│   ├── __init__.py
│   ├── main.py          # FastAPI 入口，路由定义
│   ├── config.py         # Settings（env 读取）
│   ├── db.py             # 向量数据库 init/insert/search
│   └── embed.py          # chunk_text + embed_texts
├── content/              # 预置知识库（结构化分目录）
│   ├── company/          # 公司介绍与内部政策
│   ├── customers-market/ # 客户与市场分析（60+ 文档）
│   ├── fabric/            # 面料知识（100+ 文档）
│   ├── garments/          # 成衣知识（180+ 文档）
│   ├── suppliers/         # 供应商管理（10+ 文档）
│   └── _taxonomy.md      # 分类法
└── README.md
```

### 6.2 配置项（settings）

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `api_key` | env | Bearer Token 比对值 |
| `rag_top_k` | env | 检索返回 top-K |
| `chunk_max_chars` | env | 分块最大字符数 |
| `deepseek_base` | env | DeepSeek API 基址 |
| `deepseek_api_key` | env | DeepSeek 鉴权 |
| `deepseek_model` | env | DeepSeek 模型名 |
| `main_data_api_base` | env | Node 主数据 API 基址（代理转发） |
| `url_mount_path` | env | 挂载路径（如 `/knowledge-api`） |
| `allowed_origins` | `*` 或逗号分隔 | CORS 白名单 |

### 6.3 嵌入与分块

```python
# app/embed.py
def chunk_text(text: str, max_chars: int) -> list[str]:
    """按段落 + 字数分块"""

async def embed_texts(texts: list[str]) -> list[list[float]]:
    """调用嵌入模型生成向量"""
```

### 6.4 向量数据库

```python
# app/db.py
def init_db(): ...
def insert_chunks(rows: list[tuple]) -> int: ...
def search_chunks(qvec: list[float], k: int) -> list[dict]: ...
```

- 当前为轻量级向量库（SQLite + 向量扩展或内存）
- 未来可替换为 Qdrant / Milvus / Weaviate

---

## §7 RAG 生成流程

### 7.1 system prompt

```python
system = (
    "你是公司内部助手。请优先依据「资料片段」回答；"
    "若资料不足，明确说明并给出安全的一般建议。"
)
```

### 7.2 context 拼接

```python
context_blocks = []
for h in hits:
    title = h.get("source_title") or ""
    prefix = f"[{title}]\n" if title else ""
    context_blocks.append(prefix + (h.get("content") or ""))
context = "\n\n---\n\n".join(context_blocks).strip()
```

### 7.3 messages 构造

```python
user = f"资料片段：\n{context}\n\n用户问题：\n{body.message}"
messages = [
    {"role": "system", "content": system},
    {"role": "user", "content": user},
]
```

### 7.4 流式生成

```python
async def _deepseek_stream(messages):
    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream(
            "POST",
            f"{settings.deepseek_base.rstrip('/')}/chat/completions",
            headers={"Authorization": f"Bearer {settings.deepseek_api_key}"},
            json={"model": settings.deepseek_model, "messages": messages, "stream": True},
        ) as resp:
            async for line in resp.aiter_lines():
                # 解析 SSE: data: {json}\n\n
                payload = line.removeprefix("data: ").strip()
                if payload == "[DONE]": break
                obj = json.loads(payload)
                delta = obj["choices"][0].get("delta") or {}
                content = delta.get("content")
                if content: yield content
```

### 7.5 响应

```python
return StreamingResponse(gen(), media_type="text/plain; charset=utf-8")
```

- 前端通过 `onChunk` 回调累积 answer
- 非标准 SSE（无 `event:` / `id:` 字段），仅 `data: ` 行

---

## §8 前端组件

### 8.1 qa Tab 状态

```typescript
const [qaQuestion, setQaQuestion] = useState('');
const [qaAnswer, setQaAnswer] = useState('');
const [qaCitations, setQaCitations] = useState<KnowledgeCitation[]>([]);
const [qaBusy, setQaBusy] = useState(false);
const [qaError, setQaError] = useState<string | null>(null);
const [qaArchiveCategory, setQaArchiveCategory] = useState<KbCategory>('Company');
const [qaArchived, setQaArchived] = useState(false);
const [qaArchiving, setQaArchiving] = useState(false);
```

### 8.2 提问交互

```typescript
const handleQaAsk = async () => {
  const q = qaQuestion.trim();
  if (!q || qaBusy) return;
  setQaBusy(true);
  setQaError(null);
  setQaAnswer('');
  setQaCitations([]);
  setQaArchived(false);
  try {
    // 引用检索与流式回答并行
    const searchPromise = apiService.searchKnowledgeBase(q)
      .then(setQaCitations)
      .catch(() => setQaCitations([]));
    await apiService.askKnowledgeBase(q, piece => setQaAnswer(prev => prev + piece));
    await searchPromise;
  } catch (e: any) {
    setQaError(e?.message || '问答服务暂不可用，请稍后重试');
  } finally {
    setQaBusy(false);
  }
};
```

### 8.3 引用展示

```tsx
{qaCitations.length > 0 && (
  <div>
    <div>命中片段 ({qaCitations.length})</div>
    {qaCitations.map(c => (
      <div key={c.documentId + c.chunkId}>
        <div>{c.documentTitle}</div>
        <div>{c.content}</div>
        <div>score: {c.score.toFixed(3)}</div>
      </div>
    ))}
  </div>
)}
```

### 8.4 归档闭环

```typescript
const handleArchiveQa = async () => {
  const title = `问答：${q.slice(0, 40)}${q.length > 40 ? '…' : ''}`;
  const text = `问题：${q}\n\n回答：${a}`;
  const json = await apiService.ingestKnowledgeText({
    title, text, category: qaArchiveCategory, sourceType: 'qa'
  });
  setKnowledge([item, ...knowledgeRef.current], item);
  setQaArchived(true);
};
```

- 归档后 sourceType='qa'，metadata 可扩展记录提问者与时间
- 同内容幂等（checksum 去重）

---

## §9 三层广告过滤

`server/knowledge_api/content/` 目录结构化分目录，配合三层过滤确保检索质量：

### 9.1 a 层：内容特征

- 文档 < 200 字 + 推广词黑名单 → 判为广告
- 在摄取时拒绝入库

### 9.2 b 层：结构过滤

- `trafilatura` 抽取正文 < 100 字 → 判为图片广告
- 需人工抽检校准（避免误杀短文）

### 9.3 c 层：LLM 判断

- prompt 使用能力描述式（非示例特定）
- 判断是否为纺织专业知识内容
- 失败时降级为 a/b 层结果

### 9.4 content/ 目录分类

| 目录 | 文档数 | 覆盖范围 |
| --- | --- | --- |
| `company/` | 2 | 公司介绍 + 内部政策流程 |
| `customers-market/` | 60+ | 全球市场分析（美/欧/日/韩/东南亚/中东/拉美/非洲等） |
| `fabric/` | 100+ | 面料知识（棉/麻/丝/毛/化纤/功能面料/技术纺织品） |
| `garments/` | 180+ | 成衣知识（西装/外套/衬衫/运动服/工作服/家居纺织品） |
| `suppliers/` | 10+ | 供应商管理（工厂评估/染厂合作/5S/裁剪房管理） |

---

## §10 交互流程

### 10.1 提问流程

```
用户在 qa tab 输入问题
  └─► 点击「提问」按钮
      ├─► setQaBusy(true) + 清空 answer/citations
      ├─► 并行:
      │   ├─ apiService.searchKnowledgeBase(q) → setQaCitations
      │   └─ apiService.askKnowledgeBase(q, onChunk)
      │         └─ onChunk: setQaAnswer(prev => prev + piece)
      └─► 完成: setQaBusy(false)
          └─► 显示「归档」按钮（qaAnswer 非空时）
```

### 10.2 归档流程

```
用户选择 category + 点击「归档到官方知识库」
  └─► apiService.ingestKnowledgeText({ title, text, category, sourceType: 'qa' })
      ├─► 200: setQaArchived(true) + setKnowledge([new, ...])
      └─► 失败: setQaError(e.message)
```

### 10.3 连通性测试

```
Settings → AI → 知识库连接测试
  └─► knowledgeApiService.testConnection(endpoint, apiKey)
      ├─► health() 检查 /health
      ├─► debugContext({ message: '健康检查' }) 验证 Bearer
      └─► 返回 { ok, status, testedUrl, detail?, statusCode? }
```

---

## §11 状态机

### 11.1 问答状态

```
              ┌──────────┐
              │  idle    │ (qaAnswer='', qaBusy=false)
              └────┬─────┘
                   │ 提问
                   ▼
              ┌──────────┐
              │ loading  │ (qaBusy=true, 流式累积 answer)
              └────┬─────┘
                   │ 完成
                   ▼
              ┌──────────┐
              │ answered │ (qaAnswer != '', qaBusy=false)
              └────┬─────┘
                   │ 归档
                   ▼
              ┌──────────┐
              │ archived │ (qaArchived=true, 显示「已归档」)
              └──────────┘
```

### 11.2 错误状态

```
              ┌──────────┐
              │  error   │ (qaError != null)
              └────┬─────┘
                   │ 重新提问
                   ▼
              ┌──────────┐
              │ loading  │
              └──────────┘
```

---

## §12 权限与访问控制

### 12.1 Bearer Token 鉴权

```python
def verify_bearer(authorization: Annotated[str | None, Header()] = None) -> None:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    if token != settings.api_key:
        raise HTTPException(status_code=401, detail="Invalid API key")
```

- `/health` 不要求鉴权（供探活）
- 其他端点均要求 `Authorization: Bearer <token>`
- Token 在 `settings.api_key`（env 配置）

### 12.2 前端权限

- `qa` Tab 入口要求 `knowledge:read` 权限
- 归档操作要求 `knowledge:write` 权限
- 连通性测试在 Settings → AI Tab，要求 `settings:read`

### 12.3 CORS

```python
api_app.add_middleware(
    CORSMiddleware,
    allow_origins=_parse_origins(),  # settings.allowed_origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

- `allowed_origins = "*"` 或逗号分隔域名列表
- 桌面 Electron 客户端 origin 通常为 `file://` 或 `app://`

---

## §13 审计与可观测性

### 13.1 摄取审计

- Python `/v1/knowledge/ingest` 端点**未直接写 AuditLog**（与 Node 摄取管线分离）
- 前端归档走 `apiService.ingestKnowledgeText` → Node 端 `/api/v1/knowledge/ingest` → 有审计
- 未来扩展：Python 服务通过代理转发写 Node 审计

### 13.2 调试端点

- `/v1/chat/debug-context` 返回检索结果但不调用 LLM
- 用于延迟测试与检索质量评估
- `knowledgeApiService.testConnection` 调用此端点验证 Bearer

### 13.3 不变量

- LLM 调用失败 → 502 + 错误详情（前 500 字）
- `DEEPSEEK_API_KEY` 未配置 → 503 + 明确提示
- 嵌入失败 → 500（不降级为关键词搜索）

---

## §14 测试覆盖

| 测试维度 | 覆盖点 |
| --- | --- |
| 连通性测试 | `testConnection` 端到端：health + Bearer 验证 |
| 检索测试 | `debugContext` 返回 results，无 LLM 调用 |
| 摄取测试 | `ingest` 返回 `inserted_chunks` 数量 |
| 流式问答 | `askKnowledgeBase` onChunk 累积，最终 answer 非空 |
| 引用展示 | `searchKnowledgeBase` 返回 `KnowledgeCitation[]` |
| 归档闭环 | `ingestKnowledgeText(sourceType='qa')` 入库 + 列表更新 |
| 离线降级 | 探活失败显示错误，不假装回答 |
| Bearer 鉴权 | 无 Token / 错误 Token → 401 |

---

## §15 已知限制与未来扩展

### 15.1 当前限制

- ❌ 向量数据库为轻量级实现，大规模（10w+ chunks）检索性能受限
- ❌ Python 服务与 Node 主服务非同进程，部署需独立维护
- ❌ Python `/v1/knowledge/ingest` 未写 AuditLog（前端归档走 Node 端有审计）
- ❌ 无多轮对话支持（每次提问独立，无 conversation history）
- ❌ 无引用高亮（答案文本中未标记哪段对应哪个 citation）
- ❌ 无重排（rerank）机制，top-K 直接作为 context

### 15.2 未来扩展

- 接入专用向量数据库（Qdrant / Milvus）
- 多轮对话支持（conversation_id + history）
- 引用高亮（答案中插入 `[1]` `[2]` 标记）
- Rerank 模型（如 bge-reranker）二次排序
- 多模型支持（DeepSeek / GPT / Claude 切换）
- 流式引用（边生成边推送 citation）

---

## §16 交叉链接

1. [Knowledge 知识库 — 模块概述](./模块概述.md) — 父模块，RAG 是 4 Tab 之一
2. [SOP 模板管理](./SOP模板管理.md) — 实例化后的 KnowledgeDocument 进入 RAG 检索池
3. [归档问答知识](./归档问答知识.md) — Q&A 归档闭环的详细设计
4. [知识图谱与关联](./知识图谱与关联.md) — 引用片段可通过图谱关联业务实体
5. [Assistant 对话交互](../../07-AI助手/Assistant对话交互.md) — Agent 对话可调用 RAG 作为工具
6. [只读业务工具集](../../07-AI助手/只读业务工具集.md) — `search_knowledge` 工具调用 `/v1/knowledge/search`
7. [Settings 账户与系统配置](../../08-设置与后台/账户与系统配置.md) — AI Tab 配置 RAG 端点与 API Key

---

## §17 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1.0 | 2026-08-15 | 初始版本：Python 服务 + 流式问答 + 引用展示 + 归档闭环 + 三层过滤 |

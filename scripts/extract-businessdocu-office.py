#!/usr/bin/env python3
"""从 BusinessDocu 抽 xlsx / docx 的文本（不依赖第三方库，只用标准库 zipfile+xml）。

用法：python3 scripts/extract-businessdocu-office.py [输出目录]
"""
import io
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

ROOT = "/Users/qinwengu/WorkBuddy/Claw/BusinessDocu"
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/businessdocu-office"
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}


def xlsx_text(path):
    """读 sharedStrings + 每个 sheet，按行拼成 TSV 风格文本。"""
    out = []
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in root.findall("m:si", NS):
                shared.append("".join(t.text or "" for t in si.iter(
                    "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t")))
        sheets = sorted(n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n))
        for name in sheets:
            root = ET.fromstring(z.read(name))
            out.append(f"--- {name} ---")
            for row in root.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}row"):
                cells = []
                for c in row.findall("m:c", NS):
                    t = c.get("t")
                    v = c.find("m:v", NS)
                    isel = c.find("m:is", NS)
                    if t == "s" and v is not None:
                        idx = int(v.text or "0")
                        cells.append(shared[idx] if idx < len(shared) else "")
                    elif t == "inlineStr" and isel is not None:
                        cells.append("".join(x.text or "" for x in isel.iter(
                            "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t")))
                    else:
                        cells.append(v.text if v is not None else "")
                if any(x.strip() for x in cells):
                    out.append("\t".join(cells))
    return "\n".join(out)


def docx_text(path):
    """读 word/document.xml，把段落按行输出（含表格单元格）。"""
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    lines = []
    for p in root.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p"):
        txt = "".join(t.text or "" for t in p.iter(
            "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t"))
        if txt.strip():
            lines.append(txt)
    return "\n".join(lines)


def walk(dirpath):
    acc = []
    for dir_, _dirs, files in os.walk(dirpath):
        for f in files:
            if f.startswith("._") or f == ".DS_Store":
                continue
            if f.lower().endswith((".xls", ".xlsx", ".docx")):
                acc.append(os.path.join(dir_, f))
    return acc


os.makedirs(OUT, exist_ok=True)
files = walk(ROOT)
index = []
for f in files:
    rel = os.path.relpath(f, ROOT)
    try:
        if f.lower().endswith(".docx"):
            text = docx_text(f)
        else:
            text = xlsx_text(f)
    except Exception as e:  # noqa: BLE001
        text = f"<抽取失败: {e}>"
    safe = re.sub(r"[/\\#:]", "_", rel)
    with io.open(os.path.join(OUT, safe + ".txt"), "w", encoding="utf-8") as fh:
        fh.write(text)
    index.append({"rel": rel, "chars": len(text.strip())})

index.sort(key=lambda x: -x["chars"])
with io.open(os.path.join(OUT, "_index.json"), "w", encoding="utf-8") as fh:
    json.dump({"total": len(files), "index": index}, fh, ensure_ascii=False, indent=2)

print(f"文件总数 {len(files)} · 输出 {OUT}")
for x in index[:12]:
    print(f"  {x['chars']:6d} 字  {x['rel']}")

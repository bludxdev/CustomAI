#!/usr/bin/env python3
"""One-off: download self-hosted woff2 subsets into ../fonts and emit ../fonts/fonts.css."""
import os
import re
import urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fonts")
URL = (
    "https://fonts.googleapis.com/css2?"
    "family=Onest:wght@400..700&family=JetBrains+Mono:wght@400;500&family=Lora:ital,wght@1,500&display=swap"
)
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
KEEP = {"latin", "latin-ext", "cyrillic", "cyrillic-ext"}

os.makedirs(ROOT, exist_ok=True)
css = urllib.request.urlopen(urllib.request.Request(URL, headers={"User-Agent": UA}), timeout=30).read().decode()
out = []
total = 0
for subset, block in re.findall(r"/\*\s*([\w-]+)\s*\*/\s*(@font-face\s*\{.*?\})", css, re.S):
    if subset not in KEEP:
        continue
    family = re.search(r"font-family:\s*'([^']+)'", block).group(1)
    style = re.search(r"font-style:\s*(\w+)", block).group(1)
    weight = re.search(r"font-weight:\s*([\d ]+)", block).group(1).strip().replace(" ", "-")
    found = re.search(r"url\((https://[^)]+)\)", block)
    if not found:
        print("skip (no url):", family, subset)
        continue
    src = found.group(1)
    name = "%s-%s-%s-%s.woff2" % (family.lower().replace(" ", "-"), style, weight, subset)
    data = urllib.request.urlopen(urllib.request.Request(src, headers={"User-Agent": UA}), timeout=30).read()
    with open(os.path.join(ROOT, name), "wb") as fh:
        fh.write(data)
    total += len(data)
    out.append("/* %s */\n%s" % (subset, block.replace(src, name)))
with open(os.path.join(ROOT, "fonts.css"), "w", encoding="utf-8") as fh:
    fh.write("\n".join(out) + "\n")
print("files:", len(out), "bytes:", total)

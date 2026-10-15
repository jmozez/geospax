#!/usr/bin/env python3
"""Check every relative link and #anchor in the Markdown docs (GitHub heading-anchor rules).

    python3 scripts/test-docs-links.py [FILES...]      default: README, CHANGELOG, docs/, bench/RESULTS.md

Exits 1 on a missing file or anchor. External (http/https/mailto) links are not fetched.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LINK = re.compile(r"(?<!!)\[(?:[^\]\[]|\[[^\]]*\])*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
FENCE = re.compile(r"^\s*(```|~~~)")


def strip_code(text):
    out, fenced = [], False
    for line in text.splitlines():
        if FENCE.match(line):
            fenced = not fenced
            out.append("")
            continue
        out.append("" if fenced else re.sub(r"`[^`]*`", "", line))
    return out


def anchors(path, cache={}):
    if path not in cache:
        seen, found = {}, set()
        for line in strip_code(path.read_text(encoding="utf-8")):
            m = re.match(r"^(#{1,6})\s+(.*?)\s*#*\s*$", line)
            if not m:
                continue
            title = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", m.group(2))     # [text](url) -> text
            title = re.sub(r"<[^>]+>", "", title).replace("*", "").replace("`", "")
            slug = re.sub(r"[^\w\- ]", "", title.lower(), flags=re.UNICODE).replace(" ", "-")
            n = seen.get(slug, 0)
            seen[slug] = n + 1
            found.add(slug if n == 0 else f"{slug}-{n}")
        for m in re.finditer(r'<a\s+(?:name|id)="([^"]+)"', path.read_text(encoding="utf-8")):
            found.add(m.group(1))
        cache[path] = found
    return cache[path]


def main(files):
    if not files:
        files = [ROOT / "README.md", ROOT / "CHANGELOG.md", ROOT / "bench" / "RESULTS.md", *sorted((ROOT / "docs").glob("*.md"))]
        research = ROOT.parent / "gis-platform-research" / "TECH_STACK.md"
        if research.exists():
            files.append(research)
    links = bad = anchored = 0
    for f in (pathlib.Path(x).resolve() for x in files):
        for lineno, line in enumerate(strip_code(f.read_text(encoding="utf-8")), 1):
            for target in LINK.findall(line):
                if re.match(r"^(https?:|mailto:|data:)", target):
                    continue
                links += 1
                path_part, _, frag = target.partition("#")
                dest = (f.parent / path_part).resolve() if path_part else f.resolve()
                if not dest.exists():
                    print(f"{f.relative_to(ROOT.parent)}:{lineno}: missing {target}")
                    bad += 1
                    continue
                if frag and dest.suffix == ".md":
                    anchored += 1
                    if frag not in anchors(dest):
                        print(f"{f.relative_to(ROOT.parent)}:{lineno}: no anchor #{frag} in {dest.name}")
                        bad += 1
    print(f"{links} relative links ({anchored} with anchors) in {len(files)} files, {bad} broken")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

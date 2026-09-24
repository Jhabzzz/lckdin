#!/usr/bin/env python3
"""Fail if frontend/ uses any color literal not in .github/design-allowlist.txt.

Scans hex (#RGB, #RGBA, #RRGGBB, #RRGGBBAA) and rgb()/rgba()/hsl()/hsla() literals in
frontend/**/*.html, *.css, *.js and manifest.json. CSS variables (var(--x)) are always
fine, which is how new UI is supposed to pick colors.

Run locally:  python3 .github/scripts/design_check.py
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
ALLOWLIST = ROOT / ".github" / "design-allowlist.txt"
FRONTEND = ROOT / "frontend"

# `(?<![&\w])` skips HTML entities like &#10003; and identifiers; the lookahead stops
# matching inside longer tokens such as element ids ("#fb-text") or URL fragments.
HEX = re.compile(r"(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_-])")
FN = re.compile(r"\b(?:rgba?|hsla?)\([^)]*\)", re.I)


def norm_hex(h):
    h = h[1:].upper()
    if len(h) in (3, 4):
        h = "".join(c * 2 for c in h)
    return "#" + h


def norm_fn(f):
    return re.sub(r"\s+", "", f.lower())


def main():
    # Comments are "# ..." (hash + space); bare "#RRGGBB" lines are colors.
    allowed = {
        line.strip()
        for line in ALLOWLIST.read_text().splitlines()
        if line.strip() and not line.startswith("# ")
    }
    files = sorted(
        p for p in FRONTEND.rglob("*")
        if p.is_file() and (p.suffix in {".html", ".css", ".js"} or p.name == "manifest.json")
    )
    violations = []
    for path in files:
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for m in HEX.finditer(line):
                if norm_hex(m.group()) not in allowed:
                    violations.append((path, n, m.group()))
            for m in FN.finditer(line):
                c = norm_fn(m.group())
                if "${" in c or "var(" in c:  # built at runtime from tokens
                    continue
                if c not in allowed:
                    violations.append((path, n, m.group()))

    rel = lambda p: p.relative_to(ROOT)
    if violations:
        print(f"design-check: {len(violations)} off-system color(s) in frontend/\n")
        for path, n, color in violations:
            print(f"  {rel(path)}:{n}  {color}")
            # GitHub Actions annotation, shown inline on the PR diff
            print(f"::error file={rel(path)},line={n}::Off-system color {color}. Use a CSS variable "
                  f"(var(--lime), var(--text3), ...) — see CLAUDE.md > Design system.")
        print("\nFix: use an existing CSS variable. If this color is a deliberate design decision, "
              "add it to .github/design-allowlist.txt in the same PR.")
        return 1
    print(f"design-check: OK — {len(files)} files, all colors on-system ({len(allowed)} allowlisted)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

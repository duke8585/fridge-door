"""Deterministic half of the Asana import (see NORMALIZE.md, "Who decides what").

  python3 -I asana_map.py prepare <asana_dir> <import_dir>
      writes <import_dir>/src/<gid>.json: what the normalizer reads (title, notes, image paths)
  python3 -I asana_map.py merge <asana_dir> <import_dir>
      merges <import_dir>/llm/<gid>.json with board-derived fields into <import_dir>/out/<gid>.json,
      and a task split into several recipes, llm/<gid>-<n>.json, into out/<gid>-<n>.json

Both are rerunnable and write files atomically. merge skips gids without an llm file.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from dataclasses import dataclass, field

User = Literal["max", "partner"]

SECTION_RATING: dict[str, int] = {"GOOD": 5, "OKAYISH": 3, "MEEEH": 2, "COMPOST": 1}
# Tags are group:value (shared/tags.ts). The board decides list:, from:, status: and todo:.
# A section that is no rating puts its tasks on a list named after it, unless named here.
SECTION_LIST: dict[str, str | None] = {"BACKLOG": None, "TODO NEXT": "list:next-up"}
STUB_TAG = "status:stub"
NEEDS_METHOD_TAG = "todo:method"
PART_FILE = re.compile(r"^(\d+)(?:-([1-9]\d{0,2}))?$")
IMAGE_EXT = {"jpeg", "jpg", "png", "webp", "heic"}
PARTNER_PREFIX = re.compile(r"^\s*N n - (\d{2})/(\d{2})/(\d{4}) (\d{2}):(\d{2}):(\d{2})\s*\n?")
URL = re.compile(r"https?://[^\s)>\]]+")
LINK_ONLY_COMMENT = re.compile(r"^\s*(besserer link|attachment link:?)\s*$", re.I)


@dataclass
class Comment:
    user: User
    body_md: str
    created_at: str


@dataclass
class BoardFields:
    source_ref: str
    section: str | None
    ratings: list[dict[str, Any]]
    board_tags: list[str]
    cover: str | None
    comments: list[Comment] = field(default_factory=list)
    source_url_override: str | None = None


def write_atomic(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    os.replace(tmp, path)


def section_of(task: dict[str, Any]) -> str | None:
    return next((m["section"]["name"] for m in task["memberships"] if m.get("section")), None)


def images(task: dict[str, Any]) -> list[str]:
    out = []
    for a in task["attachments"]:
        ext = a["name"].rsplit(".", 1)[-1].lower()
        if ext in IMAGE_EXT:
            out.append(f"{task['gid']}/{a['gid']}.{ext}")
    return out


def split_comment(text: str, created_at: str) -> tuple[Comment | None, str | None]:
    """Returns (comment, better_source_url). A link-only comment yields no comment, only a url."""
    user: User = "max"
    m = PARTNER_PREFIX.match(text)
    if m:
        mo, d, y, hh, mi, ss = m.groups()
        user = "partner"
        created_at = datetime(int(y), int(mo), int(d), int(hh), int(mi), int(ss)).isoformat() + "Z"
        text = text[m.end():]
    urls = URL.findall(text)
    rest = URL.sub("", text).strip()
    if urls and LINK_ONLY_COMMENT.match(rest):
        return None, urls[0]
    return Comment(user=user, body_md=text.strip(), created_at=created_at), None


def list_tag(name: str) -> str:
    """"Summer BBQ" -> "list:summer-bbq"."""
    value = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    if not value:
        raise SystemExit(f"{name!r} gives no list name")
    return f"list:{value}"


def section_tags(section: str | None) -> list[str]:
    if section is None or section in SECTION_RATING:
        return []
    tag = SECTION_LIST[section] if section in SECTION_LIST else list_tag(section)
    return [tag] if tag else []


def board_fields(task: dict[str, Any]) -> BoardFields:
    sec = section_of(task)
    stars = SECTION_RATING.get(sec or "")
    # Every Asana tag on the board was a list.
    tags = section_tags(sec) + [list_tag(t["name"]) for t in task["tags"]]
    imgs = images(task)
    bf = BoardFields(
        source_ref=f"asana:{task['gid']}",
        section=sec,
        ratings=[{"user": u, "stars": stars} for u in ("max", "partner")] if stars else [],
        board_tags=tags,
        cover=imgs[0].rsplit(".", 1)[0] + ".jpg" if imgs else None,  # covers/ holds JPEG copies, see make_covers.sh
    )
    for s in task["stories"]:
        comment, url = split_comment(s["text"], s["created_at"])
        if comment:
            bf.comments.append(comment)
        if url:
            bf.source_url_override = url
    return bf


def prepare(asana: Path, out: Path) -> None:
    n = 0
    for f in sorted((asana / "tasks").glob("*.json")):
        t = json.loads(f.read_text())
        txt = [a for a in t["attachments"] if a["name"].lower().endswith(".txt")]
        write_atomic(
            out / "src" / f"{t['gid']}.json",
            {
                "gid": t["gid"],
                "title": t["name"],
                "notes": t["notes"],
                "text_attachments": [(asana / "files" / t["gid"] / f"{a['gid']}.txt").read_text(errors="replace") for a in txt],
                "images": [str(asana / "files" / p) for p in images(t)],
                "better_source_url": board_fields(t).source_url_override,
            },
        )
        n += 1
    print(f"prepared {n} tasks into {out / 'src'}")


def skipped(out: Path) -> set[str]:
    """Gids listed in <import_dir>/skip.txt (one per line, # comments): never merged, so never loaded."""
    f = out / "skip.txt"
    lines = f.read_text().splitlines() if f.exists() else []
    return {l.split("#", 1)[0].strip() for l in lines} - {""}


def merge(asana: Path, out: Path) -> None:
    done = 0
    skip = skipped(out)
    for gid in skip:
        (out / "out" / f"{gid}.json").unlink(missing_ok=True)
    for f in sorted((out / "llm").glob("*.json")):
        if f.stem in skip:
            continue
        m = PART_FILE.match(f.stem)
        if not m:
            raise SystemExit(f"{f}: expected <gid>.json or <gid>-<n>.json")
        gid, part = m.group(1), m.group(2)
        task = json.loads((asana / "tasks" / f"{gid}.json").read_text())
        llm = json.loads(f.read_text())
        bf = board_fields(task)
        recipe = llm["recipe"]
        if bf.source_url_override:
            recipe["source_url"] = bf.source_url_override
        stub = "stub" in llm["review"]
        no_method = not stub and not recipe["steps_md"].strip()
        extra = bf.board_tags + ([STUB_TAG] if stub else []) + ([NEEDS_METHOD_TAG] if no_method else [])
        recipe["tags"] = list(dict.fromkeys(recipe["tags"] + extra))
        write_atomic(
            out / "out" / f"{f.stem}.json",
            {
                "source_ref": f"{bf.source_ref}:{part}" if part else bf.source_ref,
                "status": "stub" if stub else "full",
                "section": bf.section,
                # a split task's parts share its ratings and comments; the cover goes on part 1 only
                "cover": bf.cover if part in (None, "1") else None,
                "ratings": bf.ratings,
                "comments": [c.__dict__ for c in bf.comments],
                "recipe": recipe,
                "review": llm["review"],
            },
        )
        done += 1
    print(f"merged {done} records into {out / 'out'}")


if __name__ == "__main__":
    cmd, asana_dir, import_dir = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    {"prepare": prepare, "merge": merge}[cmd](asana_dir, import_dir)

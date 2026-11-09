"""Read-only Asana export: project, sections, tags, custom fields, tasks, stories, attachment metadata.

Usage: python3 -I asana_export.py <token_file> <project_gid> <out_dir>
Writes <out_dir>/project.json, sections.json, tasks/<gid>.json. Rerunnable: overwrites by gid.
"""

import http.client
import json
import time
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

BASE = "https://app.asana.com/api/1.0"
TASK_FIELDS = ",".join(
    [
        "name", "completed", "notes", "html_notes", "created_at", "modified_at", "permalink_url",
        "memberships.section.name", "memberships.project.gid",
        "tags.name", "custom_fields.name", "custom_fields.display_value",
        "num_subtasks", "assignee.name", "created_by.name",
    ]
)


def get(token: str, path: str) -> Any:
    req = urllib.request.Request(BASE + path, headers={"Authorization": f"Bearer {token}"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read())
        except (http.client.IncompleteRead, urllib.error.URLError, TimeoutError):
            if attempt == 4:
                raise
            time.sleep(2 ** attempt)


def paged(token: str, path: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    sep = "&" if "?" in path else "?"
    offset = ""
    while True:
        page = get(token, f"{path}{sep}limit=50{offset}")
        out.extend(page["data"])
        nxt = page.get("next_page")
        if not nxt:
            return out
        offset = f"&offset={nxt['offset']}"


def write_atomic(path: Path, data: Any) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    os.replace(tmp, path)


def main() -> None:
    token_file, project, out = sys.argv[1], sys.argv[2], Path(sys.argv[3])
    token = Path(token_file).read_text().strip()
    (out / "tasks").mkdir(parents=True, exist_ok=True)

    write_atomic(out / "project.json", get(token, f"/projects/{project}?opt_fields=name,notes,workspace.gid")["data"])
    try:
        fields = paged(token, f"/projects/{project}/custom_field_settings?opt_fields=custom_field.name,custom_field.type,custom_field.enum_options.name")
    except urllib.error.HTTPError as e:
        if e.code != 402:
            raise
        fields = []  # custom fields are a paid Asana feature
    write_atomic(out / "custom_fields.json", fields)
    write_atomic(out / "sections.json", paged(token, f"/projects/{project}/sections?opt_fields=name"))

    tasks = paged(token, f"/projects/{project}/tasks?opt_fields={TASK_FIELDS}")
    for t in tasks:
        gid = t["gid"]
        t["stories"] = [
            s for s in paged(token, f"/tasks/{gid}/stories?opt_fields=type,text,created_by.name,created_at")
            if s.get("type") == "comment"
        ]
        t["attachments"] = paged(token, f"/tasks/{gid}/attachments?opt_fields=name,resource_subtype,host,size,view_url")
        if t.get("num_subtasks"):
            t["subtasks"] = paged(token, f"/tasks/{gid}/subtasks?opt_fields=name,notes,completed")
        write_atomic(out / "tasks" / f"{gid}.json", t)
    print(f"exported {len(tasks)} tasks to {out}")


if __name__ == "__main__":
    main()

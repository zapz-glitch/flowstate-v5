#!/usr/bin/env python3
"""Provision the Flowstate Slack->Devin pipeline in a Devin Cloud org.

Creates/updates the three role playbooks and the six pipeline automations via the
Devin v3 API, validates trigger condition fields against the live event-schemas
endpoint, captures the build-webhook credentials, and uploads them as org secrets.

Usage:
    export DEVIN_API_KEY=cog_...            # service user (ManageOrgAutomations);
                                            # falls back to the devin CLI credential
    export DEVIN_ORG_ID=org-...             # optional; defaults to the org below
    python3 devin/apply.py [--dry-run] [--config devin/pipeline.config.json]

run_as is auto-detected: service-user keys create organization-run automations,
user/session keys create creator-run automations.

Config file (devin/pipeline.config.json):
    {
      "repo": "zapz-glitch/flowstate-v5",
      "base_branch": "main",
      "slack_channel_id": "C0123ABC",
      "slack_team_id": "T0123ABC"
    }

The script is idempotent: playbooks and automations are matched by name and
updated in place. Re-running preserves the existing webhook secret.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

DEVIN_DIR = Path(__file__).resolve().parent
DEFAULT_ORG = "org-6c0122ecb67544ccb259ae9b1e9cc4dc"
API = "https://api.devin.ai/v3"
DEVIN_CLI = "/home/lucke/.local/share/devin/cli/_versions/3000.10.21/bin/devin"

PLAYBOOKS = {
    "PLANNER": ("flowstate/PLANNER", DEVIN_DIR / "playbooks" / "PLANNER.md"),
    "BUILDER": ("flowstate/BUILDER", DEVIN_DIR / "playbooks" / "BUILDER.md"),
    "EVAL": ("flowstate/EVAL", DEVIN_DIR / "playbooks" / "EVAL.md"),
}

# Created in this order: build first (mints the webhook the plan stage needs),
# then the GitHub stages, then plan last so ${DEVIN_BUILD_WEBHOOK_*} tokens
# resolve against already-uploaded org secrets.
AUTOMATION_FILES = [
    "02_build.json",
    "03_eval.json",
    "04_repair.json",
    "05_ci_fix.json",
    "06_main_verify.json",
    "01_plan.json",
]

SECRETS_FILE = DEVIN_DIR / ".pipeline-secrets.json"


def load_key() -> str:
    """DEVIN_API_KEY env, else the devin CLI's stored credential."""
    if os.environ.get("DEVIN_API_KEY"):
        return os.environ["DEVIN_API_KEY"]
    creds = Path.home() / ".local/share/devin/credentials.toml"
    if creds.exists():
        import re
        m = re.search(r'windsurf_api_key = "([^"]+)"', creds.read_text())
        if m:
            return m.group(1)
    raise SystemExit(
        "DEVIN_API_KEY is required (service user with ManageOrgAutomations; "
        "service-user keys start cog_). No devin CLI credential found either.")


def api(method: str, path: str, key: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        f"{API}{path}",
        method=method,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:800]
        raise SystemExit(f"API {method} {path} -> {e.code}: {detail}")


def paged(key: str, path: str) -> list[dict]:
    items, after = [], None
    while True:
        q = f"?after={after}" if after else ""
        page = api("GET", f"{path}{q}", key)
        items.extend(page.get("items", []))
        if not page.get("has_next_page"):
            return items
        after = page.get("end_cursor")


def load_config(path: Path) -> dict:
    cfg = json.loads(path.read_text())
    for k in ("repo", "base_branch", "slack_channel_id", "slack_team_id"):
        if k not in cfg:
            raise SystemExit(f"config missing '{k}'")
    return cfg


def validate_fields(key: str, org: str, defs: list[dict]) -> None:
    """Check condition fields + required fields against live event schemas."""
    try:
        schemas = api("GET", f"/organizations/{org}/automations/schemas", key)
    except SystemExit:
        print("WARN: schemas endpoint unavailable; skipping field validation")
        return
    sources = schemas.get("sources", {})
    fields_by_event: dict[str, dict] = {}
    for category, events in sources.items():
        for name, ev in events.items():
            fields_by_event[f"{category}:{name}"] = ev.get("fields") or {}
    if not fields_by_event:
        print("WARN: schemas endpoint returned no field metadata; skipping validation")
        return
    problems = []
    for d in defs:
        for trig in d.get("triggers", []):
            et = trig["event_type"]
            known = fields_by_event.get(et)
            if known is None:
                problems.append(f"{d['_file']}: unknown event_type '{et}'. "
                                f"Valid: {sorted(fields_by_event)}")
                continue
            used = set()
            conds = trig.get("conditions") or {}
            for group in conds.get("any", []):
                for c in group.get("all", []):
                    f = c.get("field")
                    used.add(f)
                    if f not in known:
                        problems.append(
                            f"{d['_file']}: {et} field '{f}' not in schema. "
                            f"Valid: {sorted(known)}")
            for f, spec in known.items():
                if spec.get("required") and f not in used:
                    problems.append(
                        f"{d['_file']}: {et} requires condition on '{f}'")
    if problems:
        for p in problems:
            print(f"FIELD-ERROR: {p}")
        raise SystemExit("Fix condition field names to match the schema above.")


def upsert_playbook(key: str, org: str, title: str, body: str, dry: bool) -> str:
    for pb in paged(key, f"/organizations/{org}/playbooks"):
        if pb.get("title") == title:
            pid = pb["playbook_id"]
            if not dry:
                api("PUT", f"/organizations/{org}/playbooks/{pid}", key,
                    {"title": title, "body": body})
            print(f"playbook {title}: updated {pid}")
            return pid
    if dry:
        print(f"playbook {title}: would create")
        return f"dry-{title}"
    resp = api("POST", f"/organizations/{org}/playbooks", key,
               {"title": title, "body": body})
    print(f"playbook {title}: created {resp['playbook_id']}")
    return resp["playbook_id"]


def upsert_automation(key: str, org: str, definition: dict, dry: bool,
                      existing: dict) -> dict:
    name = definition["name"]
    if name in existing:
        aid = existing[name]["automation_id"]
        if not dry:
            api("PATCH", f"/organizations/{org}/automations/{aid}", key, definition)
        print(f"automation {name}: updated {aid}")
        return existing[name]
    if dry:
        print(f"automation {name}: would create")
        return {}
    resp = api("POST", f"/organizations/{org}/automations", key, definition)
    print(f"automation {name}: created {resp['automation_id']}")
    return resp


def strip_slack(d: dict) -> dict:
    """Remove Slack-bound sections when no real channel is configured."""
    d = json.loads(json.dumps(d))
    d.pop("tools", None)
    d.pop("notifications", None)
    for a in d.get("actions", []):
        (a.get("session") or {}).pop("notifications", None)
    return d


def upload_secret(key_name: str, value: str) -> bool:
    """Upload via the local devin CLI so the value never hits argv."""
    if not Path(DEVIN_CLI).exists():
        return False
    with tempfile.NamedTemporaryFile("w", delete=False) as f:
        f.write(value)
        tmp = f.name
    try:
        os.chmod(tmp, 0o600)
        r = subprocess.run(
            [DEVIN_CLI, "cloud", "drs", "secret-create",
             "--key", key_name, "--from-file", tmp],
            capture_output=True, text=True, timeout=60,
        )
        if r.returncode == 0:
            print(f"secret {key_name}: uploaded to org secrets")
            return True
        print(f"WARN: secret {key_name} upload failed: {r.stderr.strip()[:200]}")
        return False
    finally:
        Path(tmp).unlink(missing_ok=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(DEVIN_DIR / "pipeline.config.json"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    key = load_key()
    org = os.environ.get("DEVIN_ORG_ID", DEFAULT_ORG)
    cfg = load_config(Path(args.config))
    if "REPLACE_ME" in (cfg["slack_channel_id"], cfg["slack_team_id"]):
        print("WARN: slack channel/team IDs still placeholders — "
              "slack-bound fields will not resolve correctly")

    # run_as: service-user keys must use organization; user keys use creator.
    me = api("GET", "/self", key)
    run_as = ({"type": "organization"}
              if me.get("principal_type") == "service_user"
              else {"type": "creator"})
    print(f"authenticated as {me.get('service_user_name') or me.get('user_name')} "
          f"({me.get('principal_type')}) -> run_as={run_as['type']}")

    # Playbooks first: automation prompts reference @playbook:<id>.
    pb_ids = {}
    for role, (title, path) in PLAYBOOKS.items():
        body = path.read_text().replace("BASE_BRANCH", cfg["base_branch"])
        pb_ids[f"{role}_PLAYBOOK_ID"] = upsert_playbook(
            key, org, title, body, args.dry_run)

    # Load + substitute automation definitions.
    defs = []
    for fname in AUTOMATION_FILES:
        raw = (DEVIN_DIR / "automations" / fname).read_text()
        raw = raw.replace("{{CHANNEL_ID}}", cfg["slack_channel_id"])
        raw = raw.replace("{{TEAM_ID}}", cfg["slack_team_id"])
        raw = raw.replace("{{REPO}}", cfg["repo"])
        raw = raw.replace("{{REPO_AT}}", "@{" + cfg["repo"] + "}")
        raw = raw.replace("{{BASE_BRANCH}}", cfg["base_branch"])
        for token, pid in pb_ids.items():
            raw = raw.replace("{{%s}}" % token, pid)
        d = json.loads(raw)
        d["run_as"] = run_as
        d["_file"] = fname
        defs.append(d)

    validate_fields(key, org, defs)

    slack_ready = "REPLACE_ME" not in (cfg["slack_channel_id"],
                                     cfg["slack_team_id"])
    existing = {a["name"]: a
                for a in paged(key, f"/organizations/{org}/automations")}
    failures = []

    webhook_creds: dict | None = None
    secrets_uploaded = False
    for d in defs:
        fname = d.pop("_file")
        # The plan automation's prompt references ${DEVIN_BUILD_WEBHOOK_*};
        # those tokens are validated at save, so the org secrets must exist
        # before flowstate/plan is created.
        if fname == "01_plan.json" and webhook_creds and not secrets_uploaded:
            SECRETS_FILE.write_text(json.dumps(webhook_creds, indent=1) + "\n")
            os.chmod(SECRETS_FILE, 0o600)
            print(f"Build webhook minted; saved to {SECRETS_FILE} (gitignored).")
            secrets_uploaded = all([
                upload_secret("DEVIN_BUILD_WEBHOOK_URL", webhook_creds["url"]),
                upload_secret("DEVIN_BUILD_WEBHOOK_SECRET",
                              webhook_creds["secret"]),
            ])
            if not secrets_uploaded and not args.dry_run:
                print("WARN: org secrets not uploaded — flowstate/plan creation "
                      "will fail until DEVIN_BUILD_WEBHOOK_URL and "
                      "DEVIN_BUILD_WEBHOOK_SECRET exist in Settings > Secrets. "
                      "Upload them, then re-run apply.py.")
        try:
            resp = upsert_automation(key, org,
                                     d if slack_ready else strip_slack(d),
                                     args.dry_run, existing)
        except SystemExit as e:
            failures.append((d["name"], str(e)))
            print(f"FAILED {d['name']}: {e}")
            continue
        for trig in resp.get("triggers", []):
            wh = trig.get("webhook")
            if wh and wh.get("secret"):
                webhook_creds = {"url": wh["url"], "secret": wh["secret"]}

    if not webhook_creds and not args.dry_run:
        print("\nNo new webhook secret minted (existing automation preserved it).")
    if failures:
        print(f"\n{len(failures)} automation(s) failed — fix and re-run apply.py.")

    print("\nDone. Remaining manual steps: see devin/README.md (Slack channel "
          "invite, Devin Review repo enrollment, secrets verification).")


if __name__ == "__main__":
    main()

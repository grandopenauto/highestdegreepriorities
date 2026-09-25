from __future__ import annotations
import argparse, hashlib, json, os, re, sqlite3, subprocess, sys, urllib.error, urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

VERSION = "0.2.0"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 4321
ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
STAGING = ROOT / "staging"
DB = DATA / "fanout.db"
DOORWAYS_FILE = ROOT / "doorways.json"
ADAPTERS_FILE = ROOT / "adapters.json"
CONTROLS = {
    "publish_mode": "STAGED",
    "auto_publish": False,
    "publish_enabled": False,
    "external_action_allowed": False,
    "agent_mutations_automatic": False,
}


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dirs() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    STAGING.mkdir(parents=True, exist_ok=True)


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def dump_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")


def stable_id(prefix: str, *parts) -> str:
    raw = "|".join(str(x) for x in parts)
    return prefix + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def slugify(value: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", (value or "").lower()).strip("-")
    return (s or "asset")[:90]


def init_db() -> None:
    ensure_dirs()
    with sqlite3.connect(DB) as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS research(
          research_id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          topic TEXT NOT NULL,
          problem TEXT NOT NULL,
          status TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          agent_context_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS plans(
          plan_id TEXT PRIMARY KEY,
          research_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          status TEXT NOT NULL,
          plan_json TEXT NOT NULL,
          publish_allowed INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS assets(
          asset_id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          research_id TEXT NOT NULL,
          doorway_id TEXT NOT NULL,
          asset_type TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          path TEXT NOT NULL,
          manifest_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          publish_allowed INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_plans_research ON plans(research_id);
        CREATE INDEX IF NOT EXISTS idx_assets_research ON assets(research_id);
        CREATE INDEX IF NOT EXISTS idx_assets_plan ON assets(plan_id);
        """)


def http_json(url: str, timeout: float = 4.0):
    req = urllib.request.Request(url, headers={"User-Agent": "HDP-Research-Fanout/0.2"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def probe_adapters() -> list[dict]:
    out = []
    for adapter in load_json(ADAPTERS_FILE, []):
        x = dict(adapter)
        x["reachable"] = False
        x["probe"] = "not_applicable"
        url = adapter.get("health_url")
        if url:
            try:
                body = http_json(url, 2.0)
                x["reachable"] = True
                x["probe"] = body
            except Exception as e:
                x["probe"] = type(e).__name__
        elif adapter.get("path"):
            x["reachable"] = Path(adapter["path"]).exists()
            x["probe"] = "path_exists" if x["reachable"] else "path_missing"
        out.append(x)
    return out


def oie_context() -> dict:
    base = "http://127.0.0.1:3197"
    operations = {
        "demand_status": "/api/demand/status",
        "demand_matches": "/api/demand/matches",
        "demand_acquisition": "/api/demand/acquisition",
        "capabilities": "/api/demand/capabilities",
    }
    result = {"adapter": "oie", "mode": "read_only", "captured_at": utcnow(), "operations": {}}
    for name, path in operations.items():
        try:
            result["operations"][name] = {"ok": True, "data": http_json(base + path, 5.0)}
        except Exception as e:
            result["operations"][name] = {"ok": False, "error": type(e).__name__}
    return result


def ccao_context(payload: dict) -> dict:
    path = Path(r"C:\HDP\CCAO\ccao_gate.py")
    if not path.exists():
        return {"adapter": "ccao", "ok": False, "error": "path_missing"}
    try:
        p = subprocess.run(
            [sys.executable, str(path)], input=json.dumps(payload), text=True,
            capture_output=True, timeout=10, check=False
        )
        if p.returncode != 0:
            return {"adapter": "ccao", "ok": False, "error": "nonzero_exit", "exit_code": p.returncode}
        return {"adapter": "ccao", "ok": True, "data": json.loads(p.stdout.strip())}
    except Exception as e:
        return {"adapter": "ccao", "ok": False, "error": type(e).__name__}


def normalize_research(payload: dict) -> dict:
    p = dict(payload)
    p.setdefault("topic", "")
    p.setdefault("problem", "")
    p.setdefault("evidence", [])
    p.setdefault("affected_buyers", [])
    p.setdefault("search_signals", [])
    p.setdefault("commercial_signals", [])
    p.setdefault("source_campaigns", [])
    p.setdefault("confidence", 0.0)
    p.setdefault("private_entities", [])
    return p


def create_research(payload: dict) -> dict:
    p = normalize_research(payload)
    if not p["topic"] or not p["problem"]:
        raise ValueError("topic_and_problem_required")
    rid = p.get("research_id") or stable_id("RES-", p["topic"], p["problem"], utcnow())
    p["research_id"] = rid
    ts = utcnow()
    with sqlite3.connect(DB) as c:
        old = c.execute("SELECT created_at FROM research WHERE research_id=?", (rid,)).fetchone()
        created = old[0] if old else ts
        c.execute("""INSERT OR REPLACE INTO research
            (research_id,created_at,updated_at,topic,problem,status,payload_json,agent_context_json)
            VALUES(?,?,?,?,?,?,?,COALESCE((SELECT agent_context_json FROM research WHERE research_id=?),'{}'))""",
            (rid, created, ts, p["topic"], p["problem"], "RESEARCHED", json.dumps(p, ensure_ascii=False), rid))
    return p


def get_research(rid: str):
    with sqlite3.connect(DB) as c:
        row = c.execute("SELECT payload_json,agent_context_json,status FROM research WHERE research_id=?", (rid,)).fetchone()
    if not row:
        return None
    p = json.loads(row[0]); p["status"] = row[2]; p["agent_context"] = json.loads(row[1] or "{}")
    return p


def enrich_research(rid: str) -> dict:
    research = get_research(rid)
    if not research:
        raise KeyError(rid)
    context = {
        "captured_at": utcnow(),
        "adapters": probe_adapters(),
        "oie": oie_context(),
        "external_actions_executed": 0,
        "mutating_agent_calls_executed": 0,
    }
    if isinstance(research.get("ccao_input"), dict):
        context["ccao"] = ccao_context(research["ccao_input"])
    else:
        context["ccao"] = {"adapter": "ccao", "ok": None, "reason": "no_ccao_input_supplied"}
    with sqlite3.connect(DB) as c:
        c.execute("UPDATE research SET agent_context_json=?,updated_at=? WHERE research_id=?",
                  (json.dumps(context, ensure_ascii=False), utcnow(), rid))
    return context


def keyword_score(text: str, keywords: list[str]) -> tuple[int, list[str]]:
    t = text.lower()
    hits = [k for k in keywords if k.lower() in t]
    return len(hits), hits


def choose_asset_type(doorway: dict, research: dict, preferred: str | None = None) -> str:
    allowed = doorway.get("allowed_asset_types") or ["article"]
    if preferred in allowed:
        return preferred
    problem = (research.get("problem") or "").lower()
    rules = [
        (("calculate", "cost", "roi", "margin", "throughput", "capacity"), "calculator"),
        (("audit", "readiness", "assess", "assessment"), "assessment"),
        (("compare", "versus", "difference"), "comparison"),
        (("checklist",), "checklist"),
    ]
    for words, asset_type in rules:
        if asset_type in allowed and any(w in problem for w in words):
            return asset_type
    return allowed[0]


def title_for(doorway: dict, research: dict, asset_type: str) -> str:
    base = (research.get("problem") or research.get("topic") or "Research finding").strip().rstrip(".")
    if len(base) > 90:
        base = base[:87].rstrip() + "..."
    labels = {"dataset":"Research Brief", "research_brief":"Research Brief", "resource_followup":"Resource Follow-Up",
              "research_note":"Research Note", "linkedin_post":"LinkedIn Draft", "email_followup":"Email Follow-Up Draft"}
    label = labels.get(asset_type, asset_type.replace("_", " ").title())
    return f"{base} — {doorway['name']} {label}"


def doorway_rankings(research: dict, selected: list[str] | None = None) -> list[tuple[int, dict, list[str]]]:
    doorways = load_json(DOORWAYS_FILE, [])
    selected_set = set(selected or [])
    text = " ".join([
        research.get("topic", ""), research.get("problem", ""),
        " ".join(map(str, research.get("affected_buyers") or [])),
        " ".join(map(str, research.get("search_signals") or [])),
        " ".join(map(str, research.get("commercial_signals") or [])),
        " ".join(map(str, research.get("source_campaigns") or [])),
        json.dumps(research.get("evidence") or [], ensure_ascii=False),
    ])
    ranked = []
    for d in doorways:
        if selected_set and d["doorway_id"] not in selected_set:
            continue
        hits, matched = keyword_score(text, d.get("keywords", []))
        score = int(d.get("base_priority", 1)) + hits * 10
        if d["doorway_id"] == "outreach" and research.get("source_campaigns"):
            score += 12
            matched = list(dict.fromkeys(matched + ["source_campaigns"]))
        ranked.append((score, d, matched))
    ranked.sort(key=lambda x: (-x[0], x[1]["doorway_id"]))
    if not selected_set:
        positives = [r for r in ranked if r[2]]
        return positives[:4] if positives else ranked[:3]
    return ranked


def create_plan(rid: str, options: dict | None = None) -> dict:
    options = options or {}
    research = get_research(rid)
    if not research:
        raise KeyError(rid)
    ranked = doorway_rankings(research, options.get("doorway_ids"))
    if not ranked:
        raise ValueError("no_matching_doorways")
    pid = stable_id("PLAN-", rid, utcnow())
    assets = []
    for score, doorway, matched in ranked:
        atype = choose_asset_type(doorway, research, options.get("preferred_asset_type"))
        aid = stable_id("AST-", pid, doorway["doorway_id"], atype)
        assets.append({
            "asset_id": aid,
            "doorway_id": doorway["doorway_id"],
            "doorway_name": doorway["name"],
            "kind": doorway.get("kind", "site"),
            "asset_type": atype,
            "title": title_for(doorway, research, atype),
            "match_score": score,
            "matched_signals": matched,
            "perspective": doorway.get("perspective", ""),
            "buyer": doorway.get("buyer", ""),
            "commercial_destination": doorway.get("commercial_destination", ""),
            "publisher": doorway.get("publisher", {}),
            "status": "PLANNED_HOLD",
            "publish_allowed": False,
        })
    plan = {
        "plan_id": pid, "research_id": rid, "created_at": utcnow(),
        "status": "PLANNED_HOLD", "decision": "STAGE_AND_VALIDATE",
        "publish_mode": "STAGED", "publish_allowed": False,
        "external_action_allowed": False, "external_actions_executed": 0,
        "assets": assets,
    }
    with sqlite3.connect(DB) as c:
        c.execute("INSERT INTO plans(plan_id,research_id,created_at,status,plan_json,publish_allowed) VALUES(?,?,?,?,?,0)",
                  (pid, rid, plan["created_at"], plan["status"], json.dumps(plan, ensure_ascii=False)))
    return plan


def get_plan(pid: str):
    with sqlite3.connect(DB) as c:
        row = c.execute("SELECT plan_json FROM plans WHERE plan_id=?", (pid,)).fetchone()
    return json.loads(row[0]) if row else None


def draft_markdown(asset: dict, research: dict, doorway: dict) -> str:
    evidence = research.get("evidence") or []
    evidence_lines = []
    for e in evidence:
        if isinstance(e, dict):
            label = e.get("summary") or e.get("claim") or e.get("source") or json.dumps(e, ensure_ascii=False)
        else:
            label = str(e)
        evidence_lines.append("- " + label)
    if not evidence_lines:
        evidence_lines = ["- Evidence must be attached before publication."]
    return "\n".join([
        f"# {asset['title']}", "",
        "> STATUS: STAGED HOLD — NOT APPROVED FOR PUBLICATION", "",
        f"**Research ID:** `{research['research_id']}`  ",
        f"**Asset ID:** `{asset['asset_id']}`  ",
        f"**Doorway:** {doorway['name']}  ",
        f"**Asset type:** {asset['asset_type']}  ",
        f"**Perspective:** {doorway.get('perspective','')}  ", "",
        "## Researched problem", "", research.get("problem", ""), "",
        "## Evidence basis", "", *evidence_lines, "",
        "## Required agent work", "",
        "1. OIE: challenge the problem/demand thesis against current evidence; do not invent demand.",
        "2. CCAO: when company-specific transaction context exists, evaluate the commercial gate/disposition.",
        "3. SEO Agent: validate search intent, demand, competition, cannibalization and internal-link opportunity.",
        "4. Content generator: write from this research lineage and doorway perspective, not from generic topic prompts.",
        "5. WebDev Agent: build only after the content/SEO package is validated.",
        "6. Operator: explicit publication approval remains required.", "",
        "## Original-value requirement", "",
        "Prefer original data, calculation, comparison, assessment, workflow, template or tool when it better solves the intent than prose alone.", "",
        "## CTA hypothesis", "", doorway.get("cta_hypothesis", "Offer the next useful step."), "",
        "## Controls", "", "- `publish_allowed=false`", "- `external_action_allowed=false`",
        "- No GitHub push, email send, LinkedIn post or public deployment is authorized by this staged artifact.", ""
    ])


def task_envelope(asset: dict, research: dict, agent_context: dict) -> dict:
    return {
        "research_id": research["research_id"], "asset_id": asset["asset_id"], "doorway_id": asset["doorway_id"],
        "asset_type": asset["asset_type"], "status": "STAGED_HOLD", "publish_allowed": False,
        "tasks": [
            {"agent": "OIE", "mode": "read_only", "task": "validate evidence/demand thesis", "context_available": bool(agent_context.get("oie"))},
            {"agent": "CCAO", "mode": "local_deterministic", "task": "evaluate commercial disposition when ccao_input exists", "context_available": bool(agent_context.get("ccao", {}).get("ok"))},
            {"agent": "SEOAgent", "mode": "contract_gated", "task": "validate query/intent/competition/cannibalization"},
            {"agent": "ContentGenerator", "mode": "staging_only", "task": "produce doorway-specific useful asset"},
            {"agent": "WebDevAgent", "mode": "contract_gated", "task": "build validated page or tool"},
            {"agent": "Operator", "mode": "required", "task": "approve publication"},
        ],
        "external_actions_executed": 0,
    }


def stage_plan(pid: str) -> dict:
    plan = get_plan(pid)
    if not plan:
        raise KeyError(pid)
    research = get_research(plan["research_id"])
    doorways = {d["doorway_id"]: d for d in load_json(DOORWAYS_FILE, [])}
    artifacts = []
    for asset in plan["assets"]:
        doorway = doorways[asset["doorway_id"]]
        out = STAGING / research["research_id"] / asset["asset_id"]
        out.mkdir(parents=True, exist_ok=True)
        draft = out / "draft.md"
        manifest = out / "manifest.json"
        tasks = out / "agent_tasks.json"
        draft.write_text(draft_markdown(asset, research, doorway), encoding="utf-8")
        m = {
            **asset, "plan_id": pid, "research_id": research["research_id"], "created_at": utcnow(),
            "research_lineage": {"research_id": research["research_id"], "source_campaigns": research.get("source_campaigns", [])},
            "private_entities_included": False,
            "publish_allowed": False, "external_action_allowed": False, "external_actions_executed": 0,
        }
        dump_json(manifest, m)
        dump_json(tasks, task_envelope(asset, research, research.get("agent_context") or {}))
        with sqlite3.connect(DB) as c:
            c.execute("""INSERT OR REPLACE INTO assets
              (asset_id,plan_id,research_id,doorway_id,asset_type,title,status,path,manifest_json,created_at,publish_allowed)
              VALUES(?,?,?,?,?,?,?,?,?,?,0)""",
              (asset["asset_id"], pid, research["research_id"], asset["doorway_id"], asset["asset_type"],
               asset["title"], "STAGED_HOLD", str(out), json.dumps(m, ensure_ascii=False), utcnow()))
        artifacts.append({"asset_id": asset["asset_id"], "path": str(out), "files": [draft.name, manifest.name, tasks.name]})
    plan["status"] = "STAGED_HOLD"
    plan["staged_at"] = utcnow()
    plan["external_actions_executed"] = 0
    with sqlite3.connect(DB) as c:
        c.execute("UPDATE plans SET status=?,plan_json=? WHERE plan_id=?", (plan["status"], json.dumps(plan, ensure_ascii=False), pid))
    return {"plan_id": pid, "research_id": plan["research_id"], "status": "STAGED_HOLD", "artifacts": artifacts,
            "publish_allowed": False, "external_action_allowed": False, "external_actions_executed": 0}


def list_assets() -> list[dict]:
    with sqlite3.connect(DB) as c:
        rows = c.execute("SELECT asset_id,plan_id,research_id,doorway_id,asset_type,title,status,path,created_at,publish_allowed FROM assets ORDER BY created_at DESC").fetchall()
    keys = ["asset_id","plan_id","research_id","doorway_id","asset_type","title","status","path","created_at","publish_allowed"]
    return [dict(zip(keys, row)) for row in rows]


def list_plans() -> list[dict]:
    with sqlite3.connect(DB) as c:
        rows = c.execute("SELECT plan_json FROM plans ORDER BY created_at DESC").fetchall()
    return [json.loads(row[0]) for row in rows]


def state_snapshot() -> dict:
    with sqlite3.connect(DB) as c:
        research_count = c.execute("SELECT COUNT(*) FROM research").fetchone()[0]
    return {
        "version": VERSION, "controls": CONTROLS, "doorways": load_json(DOORWAYS_FILE, []),
        "adapters": probe_adapters(), "research_count": research_count,
        "plans": list_plans(), "assets": list_assets(), "external_actions_executed": 0,
    }


def legacy_create_plan(payload: dict) -> dict:
    p = {
        "topic": payload.get("topic") or "Legacy fanout plan",
        "problem": payload.get("problem") or payload.get("topic") or "Research problem not supplied",
        "evidence": payload.get("evidence") if isinstance(payload.get("evidence"), list) else ([payload.get("evidence")] if payload.get("evidence") else []),
        "affected_buyers": [payload.get("audience")] if payload.get("audience") else [],
        "source_campaigns": payload.get("source_campaigns") or [],
        "confidence": payload.get("confidence", 0),
    }
    research = create_research(p)
    opts = {}
    if payload.get("doorway_id"):
        opts["doorway_ids"] = [payload["doorway_id"]]
    plan = create_plan(research["research_id"], opts)
    return {**plan, "status": "PLANNED_HOLD", "publish_mode": "STAGED", "external_action_allowed": False}


INDEX = """<!doctype html><html><head><meta charset='utf-8'><title>HDP Research Fanout Engine</title>
<style>body{font-family:system-ui;max-width:1100px;margin:40px auto;padding:0 20px;background:#0b1020;color:#e8edf7}.card{background:#131a2c;border:1px solid #26314d;border-radius:16px;padding:20px;margin:14px 0}code{color:#9fd3ff}.ok{color:#8ee3a1}.hold{color:#ffd27d}</style></head>
<body><h1>Research Fanout Engine <small>v0.2.0</small></h1><div class='card'><b class='ok'>LOCAL RUNTIME</b><p>One evidence object → multiple doorway-specific market assets.</p></div><div class='card'><h2>Safety</h2><p class='hold'>Staged only. Auto-publish and external actions are disabled.</p></div><div class='card'><h2>Adapters</h2><p>OIE read-only context and CCAO deterministic evaluation are callable without modifying those agents. SEO/WebDev are contract-gated.</p></div></body></html>"""


class Handler(BaseHTTPRequestHandler):
    server_version = "HDPFanout/0.2"
    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)
    def send_json(self, obj, code=200):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code); self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def body(self):
        n = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        return json.loads(raw.decode("utf-8"))
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/":
            raw = INDEX.encode("utf-8"); self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8"); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw); return
        if path == "/health":
            self.send_json({"ok": True, "service": "hdp-research-fanout-engine", "version": VERSION, "port": DEFAULT_PORT, **CONTROLS, "external_actions_executed": 0}); return
        if path == "/api/state": self.send_json(state_snapshot()); return
        if path == "/api/v1/doorways": self.send_json({"doorways": load_json(DOORWAYS_FILE, []), **CONTROLS}); return
        if path == "/api/v1/adapters": self.send_json({"adapters": probe_adapters(), **CONTROLS}); return
        if path == "/api/v1/assets": self.send_json({"assets": list_assets(), **CONTROLS}); return
        if path == "/api/v1/plans": self.send_json({"plans": list_plans(), **CONTROLS}); return
        m = re.fullmatch(r"/api/v1/research/([^/]+)", path)
        if m:
            r = get_research(m.group(1)); self.send_json(r if r else {"error":"not_found"}, 200 if r else 404); return
        self.send_json({"error": "not_found"}, 404)
    def do_POST(self):
        path = urlparse(self.path).path
        try:
            body = self.body()
            if path == "/api/v1/research":
                r = create_research(body); self.send_json({"status":"RESEARCHED","research":r,"external_actions_executed":0}, 201); return
            m = re.fullmatch(r"/api/v1/research/([^/]+)/enrich", path)
            if m:
                x = enrich_research(m.group(1)); self.send_json({"status":"ENRICHED_READ_ONLY","agent_context":x,"external_actions_executed":0}, 201); return
            m = re.fullmatch(r"/api/v1/research/([^/]+)/fanout", path)
            if m:
                p = create_plan(m.group(1), body); self.send_json({"status":"PLANNED_HOLD","plan":p,"external_actions_executed":0}, 201); return
            m = re.fullmatch(r"/api/v1/plans/([^/]+)/stage", path)
            if m:
                self.send_json(stage_plan(m.group(1)), 201); return
            if path == "/api/plans":
                self.send_json(legacy_create_plan(body), 201); return
            m = re.fullmatch(r"/api/plans/([^/]+)/stage", path)
            if m:
                self.send_json(stage_plan(m.group(1)), 201); return
            self.send_json({"error":"not_found"}, 404)
        except KeyError as e:
            self.send_json({"error":"not_found","id":str(e)}, 404)
        except Exception as e:
            self.send_json({"error":"bad_request","detail":str(e)}, 400)


def self_test() -> None:
    init_db()
    doorways = load_json(DOORWAYS_FILE, [])
    assert len(doorways) == 4
    r = create_research({
        "research_id":"RES-SELFTEST-V2", "topic":"AI agent estate sprawl",
        "problem":"Organizations accumulate overlapping AI agents and workflows with unclear ownership, operating cost and duplicated work.",
        "evidence":["Repeated workflow overlap observed in researched operating environments."],
        "affected_buyers":["COO","CIO","Founder"], "source_campaigns":["outreach-research"], "confidence":0.8
    })
    p = create_plan(r["research_id"], {"doorway_ids":["hdp-core","esf","vmi","outreach"]})
    assert len(p["assets"]) == 4 and p["publish_allowed"] is False
    s = stage_plan(p["plan_id"])
    assert s["status"] == "STAGED_HOLD" and len(s["artifacts"]) == 4 and s["external_actions_executed"] == 0
    assert all(len(a["files"]) == 3 for a in s["artifacts"])
    print(json.dumps({"ok":True,"version":VERSION,"doorways":4,"assets_staged":4,"publish_allowed":False,"external_actions_executed":0}, separators=(",",":")))


def main() -> None:
    ap = argparse.ArgumentParser(); ap.add_argument("--self-test", action="store_true"); ap.add_argument("--host", default=DEFAULT_HOST); ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = ap.parse_args(); init_db()
    if args.self_test:
        self_test(); return
    print(f"HDP Research Fanout Engine {VERSION} listening on {args.host}:{args.port}", flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()

from __future__ import annotations
import json, os, re, sqlite3, hashlib, html, urllib.request, urllib.error
from datetime import datetime, timezone
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

VERSION = "0.1.0"
ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
STAGING = ROOT / "staging"
DB = DATA / "fanout.db"
DOORWAYS_FILE = ROOT / "doorways.json"
ADAPTERS_FILE = ROOT / "adapters.json"

def now():
    return datetime.now(timezone.utc).isoformat()

def ensure_dirs():
    DATA.mkdir(parents=True, exist_ok=True)
    STAGING.mkdir(parents=True, exist_ok=True)

def load_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return default

def init_db():
    ensure_dirs()
    with sqlite3.connect(DB) as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS research(
          research_id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          topic TEXT NOT NULL,
          problem TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'RESEARCHED'
        );
        CREATE TABLE IF NOT EXISTS fanout_plans(
          plan_id TEXT PRIMARY KEY,
          research_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
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
        CREATE INDEX IF NOT EXISTS idx_assets_research ON assets(research_id);
        CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status);
        """)

def slugify(s):
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s.strip().lower()).strip("-")
    return s[:90] or "untitled"

def stable_id(prefix, *parts):
    raw = "|".join(str(x) for x in parts)
    return prefix + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]

def keyword_score(text, keywords):
    t = text.lower()
    hits = [k for k in keywords if k.lower() in t]
    return len(hits), hits

def choose_asset_type(d, p):
    requested = p.get("preferred_asset_type")
    allowed = d.get("allowed_asset_types", [])
    if requested and requested in allowed:
        return requested
    problem = (p.get("problem") or "").lower()
    if any(x in problem for x in ("calculate","cost","throughput","roi","margin","capacity")) and "calculator" in allowed:
        return "calculator"
    if any(x in problem for x in ("checklist","audit","readiness","assess","assessment")) and "assessment" in allowed:
        return "assessment"
    if any(x in problem for x in ("compare","versus","vs.","difference")) and "comparison" in allowed:
        return "comparison"
    return (allowed or ["article"])[0]

def angle_title(d, p, asset_type):
    base = p.get("problem") or p.get("topic") or "Research finding"
    short = base.strip().rstrip(".")
    if len(short) > 92:
        short = short[:89].rstrip() + "..."
    labels = {
        "article":"Guide", "guide":"Guide", "comparison":"Comparison",
        "checklist":"Checklist", "template":"Template", "calculator":"Calculator",
        "assessment":"Assessment", "dataset":"Research Brief", "landing_page":"Solution"
    }
    return f"{short} — {d['name']} {labels.get(asset_type, 'Resource')}"

def render_markdown(asset, research, doorway):
    evidence = research.get("evidence") or []
    buyers = research.get("affected_buyers") or []
    lines = [
        f"# {asset['title']}", "",
        "> STATUS: STAGED DRAFT SCAFFOLD — NOT APPROVED FOR PUBLICATION", "",
        f"**Research ID:** `{research['research_id']}`  ",
        f"**Doorway:** {doorway['name']}  ",
        f"**Asset type:** {asset['asset_type']}  ",
        f"**Perspective:** {doorway.get('perspective','')}  ",
        f"**Commercial destination:** {doorway.get('commercial_destination','')}", "",
        "## Researched problem", "",
        research.get("problem",""), "",
        "## Intended audience", "",
        ", ".join(buyers) if buyers else doorway.get("buyer","General business buyer"), "",
        "## Evidence basis", ""
    ]
    if evidence:
        for e in evidence:
            if isinstance(e, dict):
                label = e.get("summary") or e.get("claim") or e.get("source") or json.dumps(e, ensure_ascii=False)
            else:
                label = str(e)
            lines.append(f"- {label}")
    else:
        lines.append("- Evidence must be attached before publication.")
    lines += [
        "", "## Search / intent work required", "",
        "- SEO Agent: validate query demand, intent, competition, cannibalization, and internal-link target.",
        "- Do not invent volume, rankings, or buyer demand where evidence is missing.", "",
        "## Content structure", "",
        "1. State the operational problem in the doorway's perspective.",
        "2. Explain the evidence and constraints without identifying private prospects.",
        "3. Show the practical decision framework or workflow.",
        "4. Add original HDP value: tool, calculation, checklist, assessment, data, or workflow where appropriate.",
        "5. Connect the useful asset to the doorway's commercial destination without forcing a pitch.", "",
        "## WebDev work required", "",
        "- Build semantically structured page with canonical metadata and schema only after SEO validation.",
        "- Preserve this research ID and asset ID in page metadata for lineage.",
        "- Stage first. Publication remains approval-gated.", "",
        "## CTA hypothesis", "",
        doorway.get("cta_hypothesis","Offer the next useful diagnostic or workflow step."), "",
        "## Publication controls", "",
        "- `publish_allowed=false`",
        "- No GitHub push, social post, email send, or public deployment is authorized by this artifact.",
        ""
    ]
    return "\n".join(lines)

def create_research(payload):
    rid = payload.get("research_id") or stable_id("RES-", payload.get("topic",""), payload.get("problem",""), now())
    p = dict(payload)
    p["research_id"] = rid
    p.setdefault("evidence", [])
    p.setdefault("affected_buyers", [])
    p.setdefault("search_signals", [])
    p.setdefault("commercial_signals", [])
    p.setdefault("source_campaigns", [])
    p.setdefault("confidence", 0.0)
    ts = now()
    with sqlite3.connect(DB) as c:
        c.execute("""INSERT OR REPLACE INTO research
          (research_id,created_at,updated_at,topic,problem,payload_json,status)
          VALUES(?,COALESCE((SELECT created_at FROM research WHERE research_id=?),?),?,?,?,?,?)""",
          (rid,rid,ts,ts,p.get("topic",""),p.get("problem",""),json.dumps(p, ensure_ascii=False),"RESEARCHED"))
    return p

def get_research(rid):
    with sqlite3.connect(DB) as c:
        row = c.execute("SELECT payload_json FROM research WHERE research_id=?", (rid,)).fetchone()
    return json.loads(row[0]) if row else None

def make_plan(rid, options=None):
    options = options or {}
    p = get_research(rid)
    if not p:
        raise KeyError(rid)
    doorways = load_json(DOORWAYS_FILE, [])
    selected = set(options.get("doorway_ids") or [])
    text = " ".join([
        p.get("topic",""), p.get("problem",""),
        " ".join(map(str,p.get("affected_buyers") or [])),
        json.dumps(p.get("evidence") or [], ensure_ascii=False)
    ])
    ranked = []
    for d in doorways:
        hits, matched = keyword_score(text, d.get("keywords", []))
        score = d.get("base_priority", 1) + hits * 10
        if selected and d["doorway_id"] not in selected:
            continue
        ranked.append((score, d, matched))
    if not ranked:
        raise ValueError("No doorways registered")
    ranked.sort(key=lambda x: (-x[0], x[1]["doorway_id"]))
    if not selected:
        positives = [x for x in ranked if x[2]]
        ranked = positives[:3] if positives else ranked[:3]
    plan_id = stable_id("PLAN-", rid, now())
    entries = []
    for score, d, matched in ranked:
        atype = choose_asset_type(d, {**p, **options})
        asset_id = stable_id("AST-", plan_id, d["doorway_id"], atype)
        title = angle_title(d, p, atype)
        entry = {
            "asset_id": asset_id,
            "doorway_id": d["doorway_id"],
            "doorway_name": d["name"],
            "perspective": d.get("perspective",""),
            "buyer": d.get("buyer",""),
            "asset_type": atype,
            "title": title,
            "match_score": score,
            "matched_signals": matched,
            "publisher": d.get("publisher", {}),
            "commercial_destination": d.get("commercial_destination",""),
            "status": "STAGED",
            "publish_allowed": False,
            "required_agent_tasks": [
                {"agent":"OIE","task":"validate_problem_and_evidence","authority":"advisory"},
                {"agent":"SEOAgent","task":"validate_search_intent_demand_competition_cannibalization","authority":"advisory"},
                {"agent":"ContentGenerator","task":"draft_from_research_lineage","authority":"staging-only"},
                {"agent":"WebDevAgent","task":"build_validated_asset","authority":"staging-only"},
                {"agent":"Operator","task":"review_and_approve_publication","authority":"required"}
            ]
        }
        entries.append(entry)
        doorway = next(x for x in doorways if x["doorway_id"] == d["doorway_id"])
        outdir = STAGING / rid / asset_id
        outdir.mkdir(parents=True, exist_ok=True)
        md_path = outdir / "draft.md"
        manifest_path = outdir / "manifest.json"
        md_path.write_text(render_markdown(entry, p, doorway), encoding="utf-8")
        manifest = {
            **entry, "research_id":rid, "plan_id":plan_id,
            "research_lineage": {"research_id":rid,"source_campaigns":p.get("source_campaigns",[])},
            "created_at": now(),
            "external_actions_executed": 0
        }
        manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
        with sqlite3.connect(DB) as c:
            c.execute("""INSERT OR REPLACE INTO assets
              (asset_id,plan_id,research_id,doorway_id,asset_type,title,status,path,manifest_json,created_at,publish_allowed)
              VALUES(?,?,?,?,?,?,?,?,?,?,0)""",
              (asset_id,plan_id,rid,d["doorway_id"],atype,title,"STAGED",str(outdir),
               json.dumps(manifest,ensure_ascii=False),now()))
    plan = {
        "plan_id": plan_id, "research_id": rid, "created_at": now(),
        "assets": entries, "publish_allowed": False,
        "external_actions_executed": 0,
        "decision": "STAGE_AND_VALIDATE"
    }
    with sqlite3.connect(DB) as c:
        c.execute("INSERT INTO fanout_plans(plan_id,research_id,created_at,plan_json,publish_allowed) VALUES(?,?,?,?,0)",
                  (plan_id,rid,now(),json.dumps(plan,ensure_ascii=False)))
    return plan

def list_assets():
    with sqlite3.connect(DB) as c:
        rows=c.execute("""SELECT asset_id,research_id,doorway_id,asset_type,title,status,path,created_at,publish_allowed
                          FROM assets ORDER BY created_at DESC""").fetchall()
    keys=["asset_id","research_id","doorway_id","asset_type","title","status","path","created_at","publish_allowed"]
    return [dict(zip(keys,r)) for r in rows]

def probe_adapters():
    adapters=load_json(ADAPTERS_FILE,[])
    out=[]
    for a in adapters:
        x=dict(a)
        x["reachable"]=False
        x["detail"]="not_probed"
        if a.get("health_url"):
            try:
                with urllib.request.urlopen(a["health_url"], timeout=2) as r:
                    body=r.read(1200).decode("utf-8","replace")
                    x["reachable"]=200 <= r.status < 300
                    x["detail"]=body
            except Exception as e:
                x["detail"]=type(e).__name__
        out.append(x)
    return out

INDEX = """<!doctype html><html><head><meta charset="utf-8"><title>Research Fanout Engine</title>
<style>body{font-family:system-ui;max-width:1100px;margin:40px auto;padding:0 20px;background:#0b1020;color:#e8edf7}
.card{background:#131a2c;border:1px solid #26314d;border-radius:16px;padding:20px;margin:14px 0}
code{color:#9fd3ff}.ok{color:#8ee3a1}.hold{color:#ffd27d}a{color:#9fd3ff}</style></head>
<body><h1>Research Fanout Engine <small>v0.1.0</small></h1>
<div class=card><b class=ok>LOCAL BUILD</b><p>Evidence-to-market-asset orchestration for HDP. Existing specialist agents remain independent.</p></div>
<div class=card><h2>Safety boundary</h2><p class=hold>Publication is disabled. Every generated asset is staged with <code>publish_allowed=false</code>.</p></div>
<div class=card><h2>API</h2><p><code>GET /health</code><br><code>GET /api/v1/doorways</code><br><code>GET /api/v1/adapters</code><br><code>POST /api/v1/research</code><br><code>POST /api/v1/research/&lt;id&gt;/fanout</code><br><code>GET /api/v1/assets</code></p></div>
</body></html>"""

class Handler(BaseHTTPRequestHandler):
    server_version = "HDPFanout/0.1"
    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)
    def send_json(self, obj, code=200):
        raw=json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code); self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Content-Length",str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def read_json(self):
        n=int(self.headers.get("Content-Length","0") or 0)
        raw=self.rfile.read(n) if n else b"{}"
        return json.loads(raw.decode("utf-8"))
    def do_GET(self):
        path=urlparse(self.path).path
        if path=="/":
            raw=INDEX.encode(); self.send_response(200); self.send_header("Content-Type","text/html; charset=utf-8")
            self.send_header("Content-Length",str(len(raw))); self.end_headers(); self.wfile.write(raw); return
        if path=="/health":
            self.send_json({"ok":True,"service":"hdp-research-fanout-engine","version":VERSION,
                            "stage":"BUILD","publish_enabled":False,"external_actions_enabled":False}); return
        if path=="/api/v1/doorways":
            self.send_json({"doorways":load_json(DOORWAYS_FILE,[]),"publish_enabled":False}); return
        if path=="/api/v1/adapters":
            self.send_json({"adapters":probe_adapters(),"invocation_enabled":False}); return
        if path=="/api/v1/assets":
            self.send_json({"assets":list_assets(),"publish_enabled":False}); return
        m=re.fullmatch(r"/api/v1/research/([^/]+)",path)
        if m:
            p=get_research(m.group(1))
            if not p:self.send_json({"error":"not_found"},404)
            else:self.send_json(p)
            return
        self.send_json({"error":"not_found"},404)
    def do_POST(self):
        path=urlparse(self.path).path
        try:
            body=self.read_json()
            if path=="/api/v1/research":
                if not body.get("topic") or not body.get("problem"):
                    self.send_json({"error":"topic_and_problem_required"},400); return
                p=create_research(body); self.send_json({"status":"stored","research":p,
                    "external_actions_executed":0},201); return
            m=re.fullmatch(r"/api/v1/research/([^/]+)/fanout",path)
            if m:
                plan=make_plan(m.group(1),body)
                self.send_json({"status":"staged","plan":plan,"publish_allowed":False,
                                "external_actions_executed":0},201); return
            self.send_json({"error":"not_found"},404)
        except KeyError as e:self.send_json({"error":"research_not_found","id":str(e)},404)
        except Exception as e:self.send_json({"error":"bad_request","detail":str(e)},400)

def self_test():
    init_db()
    ds=load_json(DOORWAYS_FILE,[])
    assert len(ds)>=3
    p=create_research({
      "research_id":"RES-SELFTEST",
      "topic":"AI agent estate sprawl",
      "problem":"Organizations accumulate overlapping AI agents and workflows with unclear ownership and operating cost.",
      "evidence":["Repeated workflow overlap observed across researched organizations."],
      "affected_buyers":["COO","CIO","Founder"],
      "source_campaigns":["selftest"],
      "confidence":0.8
    })
    plan=make_plan(p["research_id"],{"doorway_ids":["esf","hdp","vmi"]})
    assert len(plan["assets"])==3
    assert all(not a["publish_allowed"] for a in plan["assets"])
    assert all((Path(x["path"])/"manifest.json").exists() for x in list_assets() if x["research_id"]=="RES-SELFTEST")
    print(json.dumps({"ok":True,"version":VERSION,"doorways":len(ds),"assets_staged":len(plan["assets"]),
                      "publish_allowed":False,"external_actions_executed":0},separators=(",",":")))

def main():
    import argparse
    ap=argparse.ArgumentParser(); ap.add_argument("--self-test",action="store_true")
    ap.add_argument("--host",default="127.0.0.1"); ap.add_argument("--port",type=int,default=4320)
    args=ap.parse_args(); init_db()
    if args.self_test:return self_test()
    print(f"Research Fanout Engine {VERSION} listening on {args.host}:{args.port}", flush=True)
    ThreadingHTTPServer((args.host,args.port),Handler).serve_forever()

if __name__=="__main__":
    main()

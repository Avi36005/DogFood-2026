#!/usr/bin/env python3
"""T4 checks against a running portal, in the style of the organizers' run.py.

The official checker covers T1 and T2 only. This script checks the stretch tier the same way:
real HTTP requests with the sign-ins from .dogfood.toml, against `docker compose up`. It changes
data: it adds a track, imports two judges, adds a webhook (pointed at the portal's own public
POST /api/verify, so it works with the network off) and publishes the results. Run it after
run.py and t3_check.py on a fresh volume.

    python3 scripts/t4_check.py .dogfood.toml > acceptance-report-t4.txt

Standard library only. Exit status 0 when every check passes.
"""
import json
import sys
import time
import urllib.parse

sys.path.insert(0, __import__("os").path.dirname(__file__))
from t3_check import EVENT, load, request  # noqa: E402  (same helpers, same format)


def as_json(text):
    try:
        return json.loads(text)
    except ValueError:
        return {}


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    cfg = load(argv[1])
    base = cfg["portal"]["base_url"].rstrip("/")
    auth = cfg.get("auth", {})
    org, judge_a, judge_b = (auth.get(k) for k in ("organizer", "judge_a", "judge_b"))
    port = urllib.parse.urlparse(base).port or 80
    stamp = str(int(time.time()))
    results = []

    def check(label, ok, detail=""):
        results.append((label, bool(ok), detail))

    # REST API: every UI action, documented, and answering JSON.
    s, text = request(f"{base}/api/openapi.json")
    spec = as_json(text)
    posts = sum(1 for ops in spec.get("paths", {}).values() for m in ops if m == "post")
    check("REST API: OpenAPI 3.1 for every action", s == 200 and spec.get("openapi") == "3.1.0" and posts >= 44, f"got {s}, openapi {spec.get('openapi')!r}, {posts} POST operations")
    s, text = request(f"{base}/organize/{EVENT}/tracks", org, "POST", {"name": f"T4 check {stamp}"}, accept="application/json")
    check("REST API: a UI action answers JSON", s == 200 and as_json(text).get("ok") is True, f"POST a track as JSON got {s}: {text[:80]}")

    # Bulk import.
    csv = f"name,email,tracks\nT4 Judge One,t4.one.{stamp}@example.org,\nT4 Judge Two,t4.two.{stamp}@example.org,"
    s, text = request(f"{base}/organize/{EVENT}/judges/import", org, "POST", {"csv": csv}, accept="application/json")
    check("bulk import: judges from CSV", s == 201 and as_json(text).get("imported") == 2, f"got {s}: {text[:80]}")
    s, text = request(f"{base}/organize/{EVENT}/judges/import", org, "POST", {"csv": f"Ok,t4.ok.{stamp}@example.org,\nBad,bad.{stamp}@example.org,No such track"}, accept="application/json")
    check("bulk import: one bad line imports nothing", s == 422 and "Nothing was imported" in text, f"got {s}")

    # Webhooks, delivered to the portal's own public endpoint (no outside network needed).
    hook_url = f"http://127.0.0.1:{port}/api/verify"
    s, text = request(f"{base}/organize/{EVENT}/webhooks", org, "POST", {"url": hook_url, "events": ["results.published"]}, accept="application/json")
    hook = as_json(text).get("webhook", {})
    check("webhooks: added, with a signing secret", s == 201 and str(hook.get("secret", "")).startswith("whsec_"), f"got {s}: {text[:80]}")
    request(f"{base}/organize/{EVENT}/webhooks/{hook.get('id')}/ping", org, "POST", {}, accept="application/json")

    def delivered(kind):
        for _ in range(30):
            _, text = request(f"{base}/organize/{EVENT}/webhooks", org, accept="application/json")
            rows = [d for d in as_json(text).get("deliveries", []) if d.get("webhook_id") == hook.get("id") and d.get("type") == kind]
            if rows and rows[0].get("status") == "delivered":
                return True
            time.sleep(1)
        return False

    check("webhooks: a signed test ping is delivered", delivered("webhook.ping"), "no delivered webhook.ping in the log within 30 s")

    s, _ = request(f"{base}/organize/{EVENT}/results/publish", org, "POST", {}, accept="application/json")
    check("webhooks: results.published fires", s == 200 and delivered("results.published"), f"publish got {s}; no delivered results.published")

    # Certificates.
    s, text = request(f"{base}/events/{EVENT}/certificates/prj_01/signed.json")
    certificate = as_json(text)
    vs, vtext = request(f"{base}/api/verify", None, "POST", {k: certificate.get(k) for k in ("document_text", "signature", "public_key")})
    verdict = as_json(vtext)
    check("certificates: signed and verifiable", s == 200 and verdict.get("valid") is True and verdict.get("signed_by_this_instance") is True, f"certificate {s}, verify {vs}: {vtext[:80]}")

    # Verifiable judge records.
    s, text = request(f"{base}/judge/{EVENT}/record.json", judge_a)
    record = as_json(text)
    doc = as_json(record.get("document_text", "{}"))
    vs, vtext = request(f"{base}/api/verify", None, "POST", {k: record.get(k) for k in ("document_text", "signature", "public_key")})
    check("judge records: every review counted", s == 200 and as_json(vtext).get("valid") is True and (doc.get("results") or {}).get("all_counted") is True, f"record {s}, verify {vs}")
    s, _ = request(f"{base}/organize/{EVENT}/judges/jdg_24/record.json", judge_b)
    check("judge records: a peer is refused", s in (401, 403), f"judge_b reading judge_a's record got {s}, wanted 401 or 403")

    # Embeddable widget.
    s, page = request(f"{base}/embed/{EVENT}", accept="text/html")
    check("widget: embeddable gallery", s == 200 and "Glass Signal" in page, f"got {s}")
    ws, wheaders = header_of(f"{base}/embed/{EVENT}")
    ps, pheaders = header_of(f"{base}/projects")
    check("widget: only the widget may be framed", "frame-ancestors *" in wheaders and "frame-ancestors 'none'" in pheaders, f"widget CSP {wheaders[:60]!r}")

    print("Forgeboard T4 evidence report (scripts/t4_check.py; run.py has no T4 checks)")
    print(f"portal: {base}")
    print(f"event: {EVENT}")
    print()
    for label, ok, detail in results:
        print(f"T4  {label} {'.' * max(2, 46 - len(label))} {'PASS' if ok else 'FAIL'}")
        if not ok and detail:
            print(f"       {detail}")
    passed = sum(ok for _, ok, _ in results)
    print()
    print(f"{passed} of {len(results)} T4 checks pass")
    return 0 if passed == len(results) else 1


def header_of(url):
    import urllib.request
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            return resp.status, resp.headers.get("Content-Security-Policy", "")
    except Exception as e:  # noqa: BLE001 - report, never crash
        return 0, str(e)


if __name__ == "__main__":
    sys.exit(main(sys.argv))

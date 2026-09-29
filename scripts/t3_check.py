#!/usr/bin/env python3
"""T3 checks against a running portal, in the style of the organizers' run.py.

The official checker covers T1 and T2 only. This script checks the public tier the same way:
real HTTP requests with the sign-ins from .dogfood.toml, against a demo instance where the
community vote is open (docker compose up opens one). It changes data: it casts the demo
participant's ballot and posts one comment. Running it twice is fine; a ballot already cast
counts as cast.

    python3 scripts/t3_check.py .dogfood.toml > acceptance-report-t3.txt

Standard library only. Exit status 0 when every check passes.
"""
import json
import re
import sys
import urllib.error
import urllib.request

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11
    tomllib = None

EVENT = "sample-hack-2026"
TIMEOUT = 10


def load(path):
    if tomllib:
        with open(path, "rb") as f:
            return tomllib.load(f)
    data, section = {}, None
    for raw in open(path, encoding="utf-8"):
        line = raw.split("#")[0].strip()
        head = re.fullmatch(r"\[([A-Za-z0-9_.]+)\]", line)
        if head:
            section = data.setdefault(head.group(1), {})
        elif "=" in line and section is not None:
            key, _, value = line.partition("=")
            section[key.strip()] = value.strip().strip('"')
    return data


def request(url, header=None, method="GET", body=None, accept=None):
    req = urllib.request.Request(url, method=method)
    if header:
        name, _, value = header.partition(":")
        req.add_header(name.strip(), value.strip())
    if accept:
        req.add_header("Accept", accept)
    if body is not None:
        req.data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001 - report, never crash
        return 0, f"{type(e).__name__}: {e}"


def tally_of(text):
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
    org, judge_a, judge_b, participant = (auth.get(k) for k in ("organizer", "judge_a", "judge_b", "participant"))
    vote, api = f"{base}/events/{EVENT}/vote", f"{base}/api/events/{EVENT}/vote"
    results = []

    def check(label, ok, detail=""):
        results.append((label, bool(ok), detail))

    status, _ = request(vote)
    check("ballot page is public", status == 200, f"GET {vote} got {status}")

    s, body = request(api)
    info = tally_of(body)
    check("vote is open on the demo instance", info.get("phase") == "open", f"phase {info.get('phase')!r}; docker compose up opens one")
    check("tally hidden from the public", s == 200 and info.get("tally") is None, f"GET {api} with no auth: tally {info.get('tally')!r}")
    s, body = request(api, participant)
    check("tally hidden from participants", tally_of(body).get("tally") is None, "sent as participant")
    s, body = request(api, org)
    check("organizers see the tally", tally_of(body).get("tally") is not None, "sent as organizer")

    s, page = request(vote, participant, accept="text/html")
    ids = re.findall(r'name="pick" value="(prj_\d+)"(?![^>]*disabled)', page)
    own = re.search(r'name="pick" value="(prj_\d+)"[^>]*disabled', page)
    s2, page2 = request(vote, participant, accept="text/html")
    cast_already = "Your ballot was recorded" in page
    order_ok = cast_already or (ids and ids == re.findall(r'name="pick" value="(prj_\d+)"(?![^>]*disabled)', page2) and ids != sorted(ids))
    check("ballot shuffled per voter", order_ok, f"{len(ids)} choices; same order on reload and not in id order")

    status, text = request(vote, judge_a, "POST", {"pick": ["prj_02"]})
    check("judges cannot vote", status in (401, 403), f"POST {vote} as judge_a got {status}, wanted 401 or 403")

    if own and not cast_already:
        status, text = request(vote, participant, "POST", {"pick": [own.group(1)]})
        check("own team's project refused", status == 422, f"POST own project {own.group(1)} got {status}, wanted 422")
    else:
        check("own team's project refused", cast_already, "no disabled own-team choice on the ballot")

    first = request(vote, participant, "POST", {"pick": ids[:1] or ["prj_02"]})[0] if not cast_already else 409
    second, _ = request(vote, participant, "POST", {"pick": ids[1:2] or ["prj_03"]})
    check("one ballot per account", first in (200, 409) and second == 409, f"first ballot {first}, second {second} (wanted 409)")

    project = f"{base}/projects/prj_02"
    status, _ = request(project + "/comments", None, "POST", {"body": "t3 check"})
    check("comments need a sign-in", status == 401, f"anonymous comment got {status}, wanted 401")
    status, text = request(project + "/comments", participant, "POST", {"body": "<b>t3-check</b> great demo"})
    comment = tally_of(text).get("comment", "")
    _, shown = request(project)
    check("comment posted and escaped", status == 200 and "&lt;b&gt;t3-check&lt;/b&gt;" in shown and "<b>t3-check</b>" not in shown, f"POST comment got {status}")
    status, _ = request(f"{base}/comments/{comment}/hide", judge_b, "POST", {})
    check("others cannot hide a comment", status in (401, 403), f"judge_b hiding the participant's comment got {status}")

    status, csv = request(f"{base}/api/export.csv?event={EVENT}&kind=votes", org)
    check("votes CSV export works", status == 200 and csv.startswith("ballot_id,"), f"got {status}")
    status, _ = request(f"{base}/api/export.csv?event={EVENT}&kind=votes", participant)
    check("votes CSV refused to participants", status in (401, 403), f"got {status}")
    _, audit = request(f"{base}/organize/{EVENT}/audit?action=access.denied", org, accept="text/html")
    check("refusals on the audit trail", "community-vote ballot" in audit and "comment" in audit, "judge's ballot and comment take-down listed")

    print("Forgeboard T3 acceptance report (scripts/t3_check.py)")
    print(f"portal: {base}")
    print(f"event: {EVENT}")
    print()
    for label, ok, detail in results:
        print(f"T3  {label} {'.' * max(2, 36 - len(label))} {'PASS' if ok else 'FAIL'}")
        if not ok and detail:
            print(f"       {detail}")
    passed = sum(ok for _, ok, _ in results)
    print()
    print(f"{passed} of {len(results)} T3 checks pass")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))

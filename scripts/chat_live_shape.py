#!/usr/bin/env python3
"""Send a chat using the EXACT live web-client transcript shape
(ground truth captured 2026-08-25 from client 23.13.20260824.2240):
  [config, context, user] — user.type='user', value=[[prompt]], +createdAt
Fixes the ref's stale [config, context, title, user-injected] shape.
"""
import json, sys, time, uuid
from datetime import datetime
sys.path.insert(0, "/home/z/my-project/notion-ref")
from notion_onboarding import NotionAppClient

CREDS = json.load(open("/tmp/fresh_creds.json"))
TAIL = json.load(open("/tmp/tail_result.json"))
GT = json.load(open("/tmp/gt_chat.json"))

def main():
    c = NotionAppClient(token_v2=CREDS["tokenV2"], user_id=CREDS["userId"],
                        device_id=CREDS["deviceId"],
                        client_version="23.13.20260824.2240",
                        space_id=TAIL["space_id"])
    c._session.headers["notion-audit-log-platform"] = "web"
    sid, uid, svid = TAIL["space_id"], CREDS["userId"], TAIL["space_view_id"]

    now_local = datetime.now().astimezone().isoformat(timespec="milliseconds")
    cfg = json.loads(json.dumps(GT["transcript"][0]["value"]))  # deep copy live config
    tid = str(uuid.uuid4())
    prompt = "What is 2+2? Answer with just the number."

    transcript = [
        {"id": str(uuid.uuid4()), "type": "config", "value": cfg},
        {"id": str(uuid.uuid4()), "type": "context", "value": {
            "timezone": "America/Los_Angeles",
            "userId": uid,
            "userEmail": CREDS["email"],
            "spaceName": "Onboard Bridge Test",
            "spaceId": sid,
            "spaceViewId": svid,
            "currentDatetime": now_local,
            "surface": "ai_module",
        }},
        {"id": str(uuid.uuid4()), "type": "user", "userId": uid,
         "value": [[prompt]], "createdAt": now_local},
    ]
    body = {
        "traceId": str(uuid.uuid4()),
        "spaceId": sid,
        "transcript": transcript,
        "threadId": tid,
        "threadParentPointer": {"table": "space", "id": sid, "spaceId": sid},
        "createThread": True,
        "debugOverrides": {"emitAgentSearchExtractedResults": True,
                           "cachedInferences": {}, "annotationInferences": {},
                           "emitInferences": False},
        "generateTitle": True,
        "saveAllThreadOperations": True,
        "setUnreadState": True,
        "createdSource": "ai_module",
        "threadType": "workflow",
        "isPartialTranscript": False,
        "asPatchResponse": True,
        "patchResponseVersion": 2,
        "isUserInAnySalesAssistedSpace": False,
        "isSpaceSalesAssisted": False,
        "supportsCustomAgentNudgeTranscriptStep": True,
    }

    # stream the NDJSON response
    print("sending chat (thread", tid[:8], ")...")
    resp = c.post_stream("/api/v3/runInferenceTranscript", body=body, referer="/", timeout=90)
    events = []
    for line in resp.iter_lines(decode_unicode=True):
        if not line:
            continue
        events.append(line)
        try:
            obj = json.loads(line)
        except Exception:
            print("RAW:", line[:200]); continue
        t = obj.get("type")
        if t == "record-map":
            print("event: record-map (thread created)")
        elif t == "patch" or "patch" in str(t).lower():
            print("event:", t, json.dumps(obj)[:200])
        else:
            print("event:", t, json.dumps(obj)[:250])
    print(f"\ntotal events: {len(events)}")
    with open("/tmp/chat_live_events.json", "w") as f:
        f.write("\n".join(e.decode("utf-8", "replace") if isinstance(e, bytes) else e
                          for e in events))

    # check outcome + fetch reply
    time.sleep(6)
    raw = c.post("/api/v3/getInferenceTranscriptsForUser",
                 body={"threadParentPointer": {"table": "space", "id": sid, "spaceId": sid},
                       "limit": 2, "includeWriterChats": False}, referer="/")
    thr = raw.get("recordMap", {}).get("thread", {})
    for rid, row in thr.items():
        v = (row.get("value") or {}).get("value", {})
        if not isinstance(v, dict) or v.get("id") != tid:
            continue
        outcome = (v.get("data") or {}).get("last_turn_outcome") or {}
        print("thread outcome:", json.dumps(outcome))

if __name__ == "__main__":
    main()

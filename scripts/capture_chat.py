#!/usr/bin/env python3
"""Capture the REAL runInferenceTranscript request the web client sends.
Reinstall recorder, open a new chat, type a message, send, dump the body."""
import json, time, urllib.request

DAEMON = "http://127.0.0.1:3000"

def cmd(command, timeout=90):
    body = json.dumps(command).encode()
    req = urllib.request.Request(f"{DAEMON}/api/command", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)

INSTALL = """() => {
  if (window.__cap) return { already: true };
  window.__cap = [];
  const of = window.fetch;
  window.fetch = function(input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const m = (init && init.method) || (input && input.method) || 'GET';
      let body = null;
      if (init && init.body) body = (typeof init.body === 'string') ? init.body : '<<non-string>>';
      if (m !== 'GET' && m !== 'HEAD') window.__cap.push({ url, method: m, body });
    } catch (e) {}
    return of.apply(this, arguments);
  };
  return { installed: true };
}"""

def main():
    tab_id = int(open("/tmp/tab_id.txt").read().strip())
    # navigate to the workspace home fresh (recorder needs a page we won't leave)
    cmd({"type": "tabs.open", "url": "https://app.notion.com/", "active": True})
    time.sleep(9)

    # find the new tab id
    tl = cmd({"type": "tabs.list"})
    tabs = tl.get("tabs", [])
    tab_id = None
    for t in tabs:
        if "app.notion.com" in str(t.get("url", "")) and "/signup" not in str(t.get("url", "")):
            tab_id = t.get("id")
    print("tab:", tab_id)
    open("/tmp/tab_id.txt", "w").write(str(tab_id))

    r = cmd({"type": "eval", "tabId": tab_id, "function": INSTALL})
    print("recorder:", json.dumps(r.get("result", r))[:100])

    # open new chat (bottom-left 'New chat' button with the ⌘O hint)
    c = cmd({"type": "eval", "tabId": tab_id, "function": """() => {
      const els = Array.from(document.querySelectorAll('button,[role=button]'));
      const b = els.find(e => /new chat/i.test(e.getAttribute('aria-label')||'') || /new chat/i.test(e.textContent||''));
      if (!b) return { ok: false };
      b.click(); return { ok: true };
    }"""})
    print("new chat:", json.dumps(c.get("result", c))[:120])
    time.sleep(5)

    # type the message into the chat composer + press Enter
    c2 = cmd({"type": "eval", "tabId": tab_id, "function": """() => {
      const ta = document.querySelector('textarea[placeholder], div[contenteditable=true][data-placeholder], div[contenteditable=true]');
      if (!ta) return { ok: false, why: 'no composer' };
      if (ta.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, 'What is 2+2? Answer with just the number.');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        ta.focus();
        document.execCommand('insertText', false, 'What is 2+2? Answer with just the number.');
      }
      return { ok: true, tag: ta.tagName };
    }"""})
    print("type:", json.dumps(c2.get("result", c2))[:150])
    time.sleep(2)

    c3 = cmd({"type": "eval", "tabId": tab_id, "function": """() => {
      const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
      const ta = document.querySelector('textarea[placeholder], div[contenteditable=true]');
      if (!ta) return { ok: false, why: 'no composer' };
      ta.dispatchEvent(ev);
      return { ok: true };
    }"""})
    print("enter:", json.dumps(c3.get("result", c3))[:150])
    time.sleep(12)

    # dump captured runInferenceTranscript bodies
    d = cmd({"type": "eval", "tabId": tab_id, "function":
        "() => window.__cap.filter(c => String(c.url).includes('runInferenceTranscript'))"})
    caps = d.get("result", d) or []
    if isinstance(caps, dict):
        caps = caps.get("result", [])
    print("captured runInferenceTranscript calls:", len(caps))
    if caps:
        open("/tmp/gt_chat.json", "w").write(caps[-1]["body"])
        print("SAVED /tmp/gt_chat.json", len(caps[-1]["body"]), "bytes")
        b = json.loads(caps[-1]["body"])
        print("top-level keys:", list(b.keys()))
        tr = b.get("transcript", [])
        print("transcript items:", len(tr), "| types:", [i.get("type") for i in tr])
    else:
        d2 = cmd({"type": "eval", "tabId": tab_id, "function": "() => window.__cap.map(c => c.method + ' ' + String(c.url).slice(0,80))"})
        print("all captured:", json.dumps(d2.get("result", d2))[:800])

if __name__ == "__main__":
    main()

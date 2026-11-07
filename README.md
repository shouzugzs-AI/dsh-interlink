# dsh-interlink

**Let your DeepSeek Harness sessions talk to each other — over named links you create by hand, with a plain-text transcript of every AI-to-AI exchange.**

One conversation is one context. A second window is a second context, and until now the two could not talk: `sendMessage` on a subagent only reaches a child the same call created, and nothing at all reaches a sibling session in another tab.

`dsh-interlink` adds exactly that — and makes the reachability rule visible, editable, and auditable instead of implicit.

```text
 ┌──────────────┐   link "review"   ┌──────────────┐
 │ session A    │◄────────────────►│ session B    │
 │ E:\yy        │                  │ G:\os        │
 └──────────────┘                  └──────────────┘
        ▲                                  ▲
        └──────── both on link "review" ────┘
```

---

## Why it exists

Multi-agent work breaks down when the agents cannot talk. The usual workarounds are all bad:

- **Copy-paste between windows** — you become the message bus, and the context is lost in transit.
- **Shared files** — no delivery, no attribution, no way to know it was read.
- **Implicit "same project" grouping** — convenient until it silently connects work that should never have met.

`dsh-interlink` treats a link as a **statement someone made**: nothing is reachable until a link is named. Then it delivers real messages into the recipient's log, and shows you the whole conversation in plain text.

---

## Highlights

- **Named links, off by default.** A session belongs to no link until you create one. Nothing is reachable by accident.
- **Many links per session.** Join three links and you can reach the union of their members; joining never silently drops the others.
- **Plain-text transcript.** Every AI-to-AI message is recorded verbatim — sender, recipient, link, timestamp, full body — and rendered in the header panel. No black box.
- **One reachability gate.** The tools, the standing context line, and the header all consult the same function, so a peer the UI shows is always a peer a send can actually reach.
- **Live delivery.** A running recipient is handed the message immediately; an idle one is resumed, delivered, and kept for the reply.
- **Survives restarts.** Assignments and the transcript persist in `$DSH_HOME/plugin-data/session-link/config.json`, written atomically.

---

## Install

```bash
npm install dsh-interlink
```

Then register it in your DSH profile. The package ships `cordis.patch.yml`, so a bundle install is enough:

```jsonc
// <profile>/package.json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-interlink"]
    }
  }
}
```

Or add the Loader row yourself:

```yaml
# <profile>/cordis.patch.yml
- insert:
    - id: session-link
      name: dsh-interlink
      config:
        autoLinks: false
        linkTools: true
        contextLine: true
        crossProject: false
```

Restart the Host once. After that, link changes and transcript updates apply immediately.

---

## What an agent gets

| tool | what it does |
| --- | --- |
| `send_session_message` | Deliver a message into another session on any shared link. Returns once the recipient accepts it; it does not wait for a reply. |
| `list_session_links` | The current division: this session's links and peers, or every link in the profile. |
| `set_session_link` | Join a named link (keeping the others), or leave every link. |

Plus a **standing runtime-context line** naming the peers, so an agent knows a peer exists without asking. It appears only when there is at least one peer.

A delivered message is recorded with the harness's own first-class source for cross-session input — `{ kind: 'agent-message', form: 'relay', senderSessionId }` — so it is committed to the recipient's log like any other inbox entry, and the Web client renders it as a relayed message rather than as the recipient's own typing.

---

## Editing the scope

### From the session header

Click the header control to:

- **join an existing link** — including one nobody has joined yet;
- **create a new link** by name, which takes effect immediately;
- **leave one link**, keeping any others you hold;
- **read the transcript** — every message between agents, in full.

Every change applies at once. There is no Save button.

### From Settings

Settings → Plugins → Session Link sets the **profile-wide rules**:

| setting | default | effect |
| --- | --- | --- |
| `autoLinks` | **off** | Off: a session is on no link until someone names one. On: sessions opened in the same working directory are grouped automatically. |
| `linkTools` | on | Registers the three tools. Off keeps the context line and the header panel and removes the agent's own ability to send. |
| `contextLine` | on | Adds the standing peer line to the runtime context. |
| `crossProject` | off | Allow relays between sessions whose working directories differ. |
| `headerControl` | on | Serves the link routes and shows the header control. |
| `allowRemoteClients` | off | Accept the link routes from a non-loopback peer. |
| `language` | `auto` | Wording language: follow the host locale, or force `en` / `zh`. |
| `maxMessageChars` | 8000 | Longest single relayed message. |

---

## The linking rules

For one session, in order:

1. **A recorded assignment** — whatever you (or `set_session_link`) wrote for it.
2. **The directory rule**, when `autoLinks` is on — every session opened in the same working directory shares a link id derived from that directory. A session with no directory is never merged by this rule.
3. **No link** — the resting state. A session nobody named has no link, so it has no peers at all.

The result is deterministic from (session, directory, recorded assignments), so every surface agrees about who is reachable without a coordination protocol between them.

**One more gate:** when `crossProject` is off, a peer counts as reachable only if the two sessions share a normalized working directory. That decision lives in one shared function, so an explicit link can group sessions from several projects for the overview, while `send_session_message`, the context line, and the header all refuse or hide cross-project peers until you opt in.

---

## Delivery

A message is delivered by the only mechanism the harness offers a plugin:

- the recipient is **already running** — handed to that agent, which is left running; the plugin does not own it and never disposes it;
- the recipient is **idle** — resumed through `ctx.agents.resume()`, delivered, and the handle is kept so a reply reuses the same agent instead of racing for the session lock;
- **neither works** — reported to the caller with the reason, never thrown.

When a profile cannot resume a session at all, the header says so instead of promising a delivery the Host cannot make.

---

## The transcript

Every successful relay is appended to a bounded log (200 entries, oldest dropped first) and shown in the header panel as plain text:

```text
session-5bae23 → session-3b9622 @ 1
验证明文转录：这条消息的原文会出现在标题栏面板的「智能体之间的消息（原文）」区块……

session-3b9622 → session-5bae23 @ 1
收到。本会话（lead，链路 1）已收到你从 session-5bae23（yy）经链路 1 发来的原文消息……
```

Bodies are kept **whole**, not summarised — a summary would reintroduce the very black box this is meant to remove. A session view returns only the exchanges it took part in.

---

## Architecture

Two halves, one implementation of the rules:

```text
link.js          pure reachability logic: linkOf / linksOf / sameProject
catalogue.js     one answer to "who exists, who is on what, who can reach whom"
link-store.js    durable assignments, links registry, and relay transcript
routes.js        the same-origin HTTP bridge (/api/session-link/*)
plugin.js        Host half: tools, context line
client.js        browser half: settings card, header control, transcript
index.js         wiring: the Loader row, the routes, the store
```

The browser panel, the agent tools, and the standing context line all consume `catalogue.js`, so a disagreement between them is structurally impossible.

---

## Development

```bash
npm test          # 89 host tests + 39 client tests
npm run test:host
npm run test:client
```

The suites run on plain Node — no Harness required. `test.mjs` covers the pure logic, the store, the routes, and the tools; `test-client.mjs` drives the browser half against a Cordis/slot/settings fake.

---

## License

MIT © [shouzugzs-AI](https://github.com/shouzugzs-AI)

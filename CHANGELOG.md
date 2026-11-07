# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-11-07

First public release, published as `dsh-interlink`.

### Added

- **Named links**, off by default: a session belongs to no link until one is
  created, so nothing is reachable by accident.
- **Multiple links per session**: joining a link never silently drops another,
  and reachability is the union of every shared link.
- **`send_session_message`**, **`list_session_links`**, **`set_session_link`**.
- **Standing runtime-context line** naming the peers of the current links.
- **Session header control** to join, create, leave, and read the transcript;
  the overlay portals out of the clipped header so it is actually clickable.
- **Plain-text relay transcript**: sender, recipient, link, timestamp, and the
  full message body, kept verbatim (bounded to 200 entries) and shown in the
  header panel.
- **Settings card** for the profile-wide rules: `autoLinks`, `linkTools`,
  `contextLine`, `crossProject`, `headerControl`, `allowRemoteClients`,
  `language`, `maxMessageChars`.
- **Atomic durable store** at `$DSH_HOME/plugin-data/session-link/config.json`
  with a links registry that survives an empty membership.
- Durable link registry: a named link keeps existing between creation and the
  first member joining, so it can be found and joined later.

### Fixed

- Volatile (`configForms`) fields are read through `.get()` on every access, so
  a switch saved in Settings takes effect without a Host restart.
- Tool arguments are read from the positional `execute(args, exec)` argument,
  with a fallback to the older `exec.arguments` shape.
- The session corpus is read from its `record.header` shape (`header.id`,
  `header.cwd`), so the profile listing is actually visible.
- Optional Host services are resolved through `ctx.get(name, false)`, which
  answers `undefined` where a property read would throw.
- The header overlay no longer sits inside the clipping container, so clicking
  it opens the panel instead of appearing to do nothing.

### Notes

- 89 host tests and 39 client tests, all running on plain Node.

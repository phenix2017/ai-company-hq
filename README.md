# AI Company HQ

**Run your one-person company like a big organization.** A split-view workspace:
the org chart stays visible on the left while you chat with any role on the
right — CFO, CTO, Head of Quality & Compliance, Business Development, Legal,
and more. Each role is a real, persistent agent session running on your
[OpenClaw](https://github.com/openclaw/openclaw) gateway, seeded with a
department persona.

Built for solo operators who wear every hat but want a proper leadership
team to talk to.

## Features

- **Org chart, always visible** — C-suite + key functions, grouped by department
- **Chat with any role** — persistent per-role sessions, persona-seeded on first message
- **14 roles, full big-org coverage** — COO, CFO, CTO, CMO, Strategy, Operations & Supply Chain, Quality & Compliance (AS9100/MRB), Business Development, Publishing & Content, Research, People & Culture, Legal & Risk, Data & Analytics, Customer Success
- **Runs on your own gateway** — roles are personas on your OpenClaw main agent; no third-party API, no data leaves your machine
- **Zero config on first run** — falls back to your gateway token file

## Architecture

```
┌──────────────┐   HTTP (localhost)   ┌───────────────┐   WebSocket RPC (v4)   ┌─────────────┐
│  browser UI  │ ───────────────────▶ │  hq server.js │ ─────────────────────▶ │ OpenClaw    │
│ org + chat   │ ◀─────────────────── │  (proxy)      │ ◀───────────────────── │ Gateway     │
└──────────────┘                      └───────────────┘                        └─────────────┘
                                        roles.json
                                        (personas)
```

- `server.js` — Node proxy: serves the UI, talks Gateway WebSocket RPC (protocol v4),
  keeps one persistent session per role (`agent:main:hq-<slug>`), polls for replies.
- `roles.json` — the **public template**: a generic, industry-agnostic org chart
  (id, name, department, level (`c` = C-suite), icon, scope, persona). Safe to
  commit and share — no business names, product names, or personal details.
- `roles.local.json` *(optional, gitignored)* — your real departments/personas
  with your actual business names and context. If present, this file is used
  instead of `roles.json`; if absent, the generic template runs as-is. This is
  how you keep your own business/personal data out of version control while
  still shipping (or forking) a clean, reusable framework.
- `public/index.html` — split-view UI. No build step, no dependencies.

## Quickstart

Requirements: Node.js ≥ 22, an OpenClaw Gateway running on `ws://127.0.0.1:18789`
(or `GATEWAY_WS`), and a gateway token.

```bash
npm install   # no dependencies — this is a formality
npm start
# → http://127.0.0.1:8813/
```

Token resolution order:

1. `GATEWAY_TOKEN` env var
2. `GATEWAY_TOKEN_FILE` env var (path to a file containing the token)
3. Default path `~/.openclaw/secrets/gateway-token` (OpenClaw default install)

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8813` | HTTP port for the UI + API |
| `GATEWAY_WS` | `ws://127.0.0.1:18789` | Gateway WebSocket address |
| `GATEWAY_TOKEN` | — | Gateway auth token (preferred) |
| `GATEWAY_TOKEN_FILE` | `~/.openclaw/secrets/gateway-token` | Token file path |
| `ROLE_MODEL` | `deepseek/deepseek-v4-flash` | Model override applied to role sessions |
| `OWNER_LABEL` | `Founder` | Display name/title for the CEO seat and your chat messages |
| `COO_LABEL` | `COO Agent` | Display name for the COO seat |

## API

- `GET /api/health` — proxy + gateway status
- `GET /api/config` — display labels for the CEO/COO seats
- `GET /api/roles` — org chart (id, name, dept, level, icon, scope)
- `GET /api/history?role=<id>` — recent messages for a role session
- `POST /api/chat` `{ role, text }` — send a message, returns the role's reply

## Customizing roles

Copy `roles.json` to `roles.local.json` and edit that instead — the UI and
sessions adapt automatically, and `roles.local.json` is gitignored so your
edits (business names, product names, org-specific personas) never get
committed. Each role needs: `id` (slug), `name`, `dept`, `level` (`c` or `d`),
`icon` (emoji), `scope` (one-line subtitle), and `persona` (the role's system
instruction, seeded on the first message of its session).

## Security & privacy notes

- The gateway token is read at startup and never exposed to the browser.
- Bind to loopback (`127.0.0.1`) only — don't expose this on a network.
- Role sessions run with your agent's full tool access; treat them like internal staff.
- Before pushing changes to a public fork, audit `roles.local.json` isn't
  staged (`git status`), and grep your diff for real names, company names, or
  other identifying details you don't want public. `roles.json` (the tracked
  template) should stay generic.

## License

MIT

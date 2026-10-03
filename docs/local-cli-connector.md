# Personal local Claude connector

Ask the dashboard can use the Claude Code sign-in already on this Mac. It runs
Sonnet through the official, pinned Claude Agent SDK. Normal Claude plan limits
apply to questions. Connecting and checking native sign-in do not send a model
prompt.

## Connect

In Terminal:

```sh
cd ~/projects/bwp-analytics-dashboard
pnpm install --frozen-lockfile
pnpm chat:doctor
pnpm chat:helper
```

Keep that Terminal open. Visit http://127.0.0.1:5557/connect and click **Copy
connection code**. In the dashboard, open **Ask the dashboard → Settings → Local
Claude Code**, paste the code, and click **Connect**, then **Back to chat**.
Both the local code page and dashboard code input mask the code. If the browser
asks for local network access, allow it for this dashboard.

The live GitHub Pages dashboard and local dashboard ports 3000, 3111 and 3114
can connect. The helper must run on the same Mac as the browser. This does not
make a phone or another computer able to use the Mac's Claude login.

Pairing stays in memory in that tab. Reloading/closing the tab, signing out,
Disconnect, or restarting the helper requires reconnection. **Check connection**
checks the helper without asking a model question. After a restart, copy the
new code. Stop cancels the active model request. Start a new chat when changing
provider or effort.

## Data and tools

The helper reloads its own fixed `public/data` files for each question. A scrape
completed after helper startup is therefore available to the next question.
Comments load only when a comment lookup needs them. The separate scraper stays
on port 5556:

```sh
python3 scrape/server.py
```

Claude can use only the eleven read-only dashboard analytics tools. Shell,
file, browser, web, other MCP servers, local skills and project settings are
excluded. Native authentication remains inside the official Claude process;
the dashboard never reads or copies its login credentials. No API key is
needed for this provider. Question text, recent completed conversation and
requested analytics results are sent to Claude to produce the answer.

Each question has a 90-second deadline, at most nine model turns, 64 analytics
lookups, and a $0.25 **estimated** SDK query budget. The budget is an SDK guard,
not a guaranteed billing cap or a claim that subscription usage is free.
Interrupted, refused and failed answers do not enter the helper's conversation
history. Input and streaming responses have size limits. Only one question runs
at a time in this helper.

## Troubleshooting

- **Cannot reach connector:** run `pnpm chat:helper` on this Mac. Allow local
  network access for the dashboard if your browser asks.
- **Sign-in needed:** `pnpm chat:doctor` prints the official native login command.
  Complete that native login yourself, then rerun the doctor.
- **Expired connection:** open the local page and copy the current code.
- **Model or plan access error:** check your Claude plan usage and native sign-in.
  The connector uses the native `sonnet` alias so Claude Code resolves its
  available Sonnet version.
- **Port already in use:** use the connector already running on 5557, or stop
  that connector before starting another. Do not expose the helper through a
  tunnel or bind it to a public interface.

For tests without a model request, `pnpm chat:helper:mock` starts the explicit
mock helper. The settings show **Test mode** and its answers identify themselves
as test responses. `pnpm test` includes offline model fixtures and temporary
loopback HTTP servers; it does not call Claude.

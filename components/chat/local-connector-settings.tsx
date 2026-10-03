"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { checkLocalHelper, connectLocalHelper, disconnectLocalHelper, LOCAL_CHAT_URL, PERSONAL_MODEL_LABEL } from "@/lib/chat/local-connection";
import { useChatContext } from "./chat-root";
import { StateBlock } from "./state-block";

export function LocalConnectorSettings() {
  const { localConnection, chat, setShowSettings } = useChatContext();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const connect = async () => {
    if (busy || chat.streaming) return;
    setShowSettings(true); setBusy(true); setError(null);
    const controller = new AbortController(); pending.current = controller;
    try { await connectLocalHelper(code, fetch, controller.signal); setCode(""); chat.newChat(); }
    catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not connect."); }
    finally { if (!controller.signal.aborted) setBusy(false); pending.current = null; }
  };
  const check = async () => {
    setBusy(true); setError(null);
    const controller = new AbortController(); pending.current = controller;
    const info = await checkLocalHelper(fetch, controller.signal);
    if (!controller.signal.aborted) { if (!info) setError("The helper stopped or restarted. Start it and copy its current connection code."); setBusy(false); }
    pending.current = null;
  };
  return <section className="space-y-3">
    <h3 className="font-display text-lg font-semibold text-ink">Claude on this Mac</h3>
    <p className="text-sm text-ink-soft">Uses your Claude Code sign-in and plan limits. The helper reads your local dashboard data for each question.</p>
    {localConnection ? <>
      <StateBlock tone={localConnection.mode === "mock" ? "warn" : "positive"} eyebrow={localConnection.mode === "mock" ? "Test mode" : "Connected"} role="status">
        {localConnection.mode === "mock" ? "The helper is in mock mode. Restart without --mock for real answers." : `Claude Code is connected · ${PERSONAL_MODEL_LABEL}`}
      </StateBlock>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="button" disabled={busy || chat.streaming} onClick={() => setShowSettings(false)}>Back to chat</Button>
        <Button size="sm" variant="ghost" type="button" disabled={busy || chat.streaming} onClick={() => void check()}>{busy ? "Checking…" : "Check connection"}</Button>
        <Button size="sm" variant="ghost" type="button" disabled={busy || chat.streaming} onClick={() => { disconnectLocalHelper(); chat.newChat(); setError(null); }}>Disconnect</Button>
      </div>
    </> : <>
      <p className="text-sm text-ink-soft">Start the connector in Terminal:</p>
      <code className="block break-words rounded-md bg-muted p-3 text-xs text-ink">cd ~/projects/bwp-analytics-dashboard &amp;&amp; pnpm chat:helper</code>
      <p className="text-sm"><a href={`${LOCAL_CHAT_URL}/connect`} target="_blank" rel="noopener noreferrer" className="text-brand underline underline-offset-2">Open the local connection page</a>, copy its code, and paste it here. Keep that page out of your recording.</p>
      <Input type="password" name="bwp-local-connection" autoComplete="off" spellCheck={false} aria-label="Local connection code" placeholder="Paste connection code" value={code} disabled={busy || chat.streaming} onChange={e => setCode(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void connect(); } }} />
      <Button size="sm" type="button" disabled={busy || chat.streaming || !/^[a-f0-9]{32}$/i.test(code.trim())} onClick={() => void connect()}>{busy ? "Connecting…" : "Connect"}</Button>
      <p className="text-xs text-ink-muted">Allow local network access if your browser asks. Reconnect after closing this tab or restarting the helper. No model request is made when you connect.</p>
    </>}
    {error && <StateBlock tone="warn" eyebrow="Connection" role="alert">{error}</StateBlock>}
  </section>;
}

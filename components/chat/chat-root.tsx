"use client";

// Client context for the assistant (section 5, chat-root.tsx). Holds the open
// state, settings, the dataset (built on first open), the provider session,
// the transcript (through useChat), Cmd/Ctrl+K, the sign-out subscription and
// the dev-only mock wiring. AppShell stays a server component and renders
// <ChatRoot> around its shell div; ChatLauncher, ChatFab and ChatPanel read
// this context.
//
// ChatRoot mounts inside the client-only PIN gate, so the lazy state
// initializers below may read storage and navigator without a hydration
// mismatch; every reader is still guarded for a missing window.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { isAuthenticated, subscribeAuth } from "@/lib/auth";
import type { Post } from "@/lib/types";
import { getChatData, type ChatData } from "@/lib/chat/data";
import { createSession, getProvider, PROVIDERS } from "@/lib/chat/providers";
import { createAnthropicKeyProvider } from "@/lib/chat/providers/anthropic-key";
import { createToolRunner } from "@/lib/chat/tools/run";
import { forgetKey, getKey, maskKey, readSettings, setKey, storageBlocked, writeSettings } from "@/lib/chat/settings";
import { buildDataCard } from "@/lib/chat/system-prompt";
import { clearTranscript } from "@/lib/chat/transcript";
import type { ChatProvider, ChatSession, ChatSettings } from "@/lib/chat/types";
import { useChat, type UseChatResult } from "@/lib/chat/use-chat";

/** Dev only: a scenario name for lib/chat/providers/mock-fetch.ts. */
export const MOCK_STORAGE_KEY = "bwp_chat_mock";
const MOCK_KEY = "sk-ant-mock-" + "x".repeat(40);
/** Trace chip shown while the 2.6 MB comments file loads for the first time. */
export const COMMENTS_HINT = "Loading comments (2.6 MB)…";

interface MockWiring {
  scenario: string;
  fn: typeof fetch;
  provider: ChatProvider;
}

export interface ChatContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  showSettings: boolean;
  setShowSettings: (show: boolean) => void;
  settings: ChatSettings;
  updateSettings: (patch: Partial<Pick<ChatSettings, "provider" | "effort" | "showUsage">>) => void;
  providers: readonly ChatProvider[];
  provider: ChatProvider | null;
  data: ChatData | null;
  dataError: boolean;
  dataCard: string | null;
  postsById: ReadonlyMap<string, Post>;
  session: ChatSession | null;
  hasKey: boolean;
  keyMask: string | null;
  keyBlocked: boolean;
  saveKey: (key: string) => Promise<"ok" | "rejected" | "offline" | "blocked" | "limited">;
  forgetSavedKey: () => void;
  chat: UseChatResult;
  launcherRef: RefObject<HTMLButtonElement | null>;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  isMac: boolean;
  /** The active mock scenario in dev, else null. */
  mock: string | null;
  /** Extra running chip on the live turn (the comments-load hint). */
  loadingHint: string | null;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChatContext must be used inside <ChatRoot>.");
  return ctx;
}

function readMockScenario(): string | null {
  if (process.env.NODE_ENV === "production") return null;
  try {
    const v = window.localStorage.getItem(MOCK_STORAGE_KEY);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

function detectMac(): boolean {
  if (typeof navigator === "undefined") return true;
  try {
    const platform =
      (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
    return /mac|iphone|ipad|ipod/i.test(platform);
  } catch {
    return true;
  }
}

export function ChatRoot({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<ChatSettings>(() => readSettings());
  const [data, setData] = useState<ChatData | null>(null);
  const [dataError, setDataError] = useState(false);
  const [keyVersion, setKeyVersion] = useState(0);
  const [keyBlocked, setKeyBlocked] = useState(() => storageBlocked());
  const [isMac] = useState(() => detectMac());
  const [mock, setMock] = useState<string | null>(null);
  const [mockFetch, setMockFetch] = useState<MockWiring | null>(null);
  const [loadingHint, setLoadingHint] = useState<string | null>(null);

  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const openRef = useRef(open);
  const mockRef = useRef<MockWiring | null>(null);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  useEffect(() => {
    mockRef.current = mockFetch;
  }, [mockFetch]);

  const mockKey = mock && mock !== "nokey" ? MOCK_KEY : null;
  const keyGetter = useCallback((): string | null => mockKey ?? getKey(), [mockKey]);
  // keyVersion is bumped by save and forget so the masked line re-reads.
  const keyInfo = useMemo(() => {
    const k = keyGetter();
    return { hasKey: k !== null, keyMask: k ? maskKey(k) : null, version: keyVersion };
  }, [keyGetter, keyVersion]);

  // Under the dev mock the provider is built over the mock fetch so that
  // Save and test hits the mocked count_tokens route too.
  const provider = useMemo<ChatProvider | null>(() => {
    if (mock && mockFetch?.scenario === mock && settings.provider === "anthropic-key") return mockFetch.provider;
    try {
      return getProvider(settings.provider) ?? null;
    } catch {
      return null;
    }
  }, [settings.provider, mock, mockFetch]);

  // Data is built on first open, not on page load.
  useEffect(() => {
    if (!open || data) return;
    let live = true;
    getChatData()
      .then((d) => {
        if (!live) return;
        setData(d);
        setDataError(false);
      })
      .catch(() => {
        if (live) setDataError(true);
      });
    return () => {
      live = false;
    };
  }, [open, data]);

  // Dev-only mock, re-read on every open so a changed scenario takes effect
  // without a reload. Production never runs this branch and never imports
  // the mock module.
  const syncMock = useCallback(() => {
    if (process.env.NODE_ENV !== "production") {
      const scenario = readMockScenario();
      setMock(scenario);
      if (!scenario) {
        setMockFetch(null);
        return;
      }
      if (mockRef.current?.scenario === scenario) return;
      import("@/lib/chat/providers/mock-fetch")
        .then((m) => {
          if (!m.isMockScenario(scenario)) {
            setMock(null);
            setMockFetch(null);
            return;
          }
          const fn = m.mockAnthropicFetch(scenario);
          setMockFetch({ scenario, fn, provider: createAnthropicKeyProvider({ fetch: fn }) });
        })
        .catch(() => {
          setMock(null);
          setMockFetch(null);
        });
    }
  }, []);

  const setOpen = useCallback(
    (next: boolean) => {
      if (next && !openRef.current) {
        returnFocusRef.current = document.activeElement instanceof HTMLButtonElement ? document.activeElement : launcherRef.current;
      }
      setOpenState(next);
      if (next) syncMock();
      else setShowSettings(false);
    },
    [syncMock],
  );
  const toggle = useCallback(() => setOpen(!openRef.current), [setOpen]);

  const dataCard = useMemo(() => (data ? buildDataCard(data) : null), [data]);
  const postsById = useMemo(() => {
    const map = new Map<string, Post>();
    if (data) for (const p of data.posts) map.set(p.id, p);
    return map;
  }, [data]);

  // One session per provider, effort, dataset and mock scenario. Building a
  // session opens nothing: the SDK loads on the first send, and the key is
  // read through getKey() at send time, so saving a key needs no rebuild.
  const providerId = settings.provider;
  const effort = settings.effort;
  const session = useMemo<ChatSession | null>(() => {
    if (!data) return null;
    if (mock && (!mockFetch || mockFetch.scenario !== mock)) return null; // waiting for the dynamic import
    const sessionSettings: ChatSettings = { v: 1, provider: providerId, effort, showUsage: true };
    const wired = mock && mockFetch?.scenario === mock ? mockFetch : null;
    try {
      return createSession(sessionSettings, data, {
        getKey: keyGetter,
        runTool: createToolRunner(data, { onCommentsLoading: () => setLoadingHint(COMMENTS_HINT), onCommentsLoaded: () => setLoadingHint(null) }),
        fetch: wired?.fn,
        provider: wired?.provider,
      });
    } catch {
      return null;
    }
  }, [data, providerId, effort, mock, mockFetch, keyGetter]);

  const dataCardFn = useCallback(() => (data ? buildDataCard(data) : ""), [data]);
  const rawChat = useChat({ data, session, dataCard: dataCardFn });
  const { send: rawSend, retry: rawRetry, newChat: rawNewChat } = rawChat;

  // The comments hint belongs to one turn: clear it whenever a turn starts.
  const chat = useMemo<UseChatResult>(
    () => ({
      ...rawChat,
      send: (text: string) => {
        setLoadingHint(null);
        rawSend(text);
      },
      retry: () => {
        setLoadingHint(null);
        rawRetry();
      },
      newChat: () => {
        setLoadingHint(null);
        rawNewChat();
      },
    }),
    [rawChat, rawSend, rawRetry, rawNewChat],
  );
  const { newChat } = chat;

  // Cmd/Ctrl+K toggles, unless focus is in a field outside the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "k") return;
      const target = e.target as HTMLElement | null;
      const editable =
        !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (editable && !target.closest('[data-slot="dialog-content"]')) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  // Sign out wipes the transcript (never the key) and closes the panel.
  useEffect(
    () =>
      subscribeAuth(() => {
        if (isAuthenticated()) return;
        clearTranscript();
        newChat();
        setOpenState(false);
        setShowSettings(false);
      }),
    [newChat],
  );

  const updateSettings = useCallback((patch: Partial<Pick<ChatSettings, "provider" | "effort" | "showUsage">>) => {
    setSettings((prev) => {
      const next: ChatSettings = { ...prev, ...patch, v: 1 };
      writeSettings(next);
      return next;
    });
  }, []);

  const saveKey = useCallback(
    async (key: string): Promise<"ok" | "rejected" | "offline" | "blocked" | "limited"> => {
      let result: "ok" | "rejected" | "offline" | "blocked" | "limited" = "offline";
      try {
        result = provider?.validateKey ? await provider.validateKey(key) : "offline";
      } catch {
        result = "offline";
      }
      if (result !== "rejected") {
        setKey(key);
        setKeyBlocked(storageBlocked());
        setKeyVersion((v) => v + 1);
      }
      return result;
    },
    [provider],
  );

  const forgetSavedKey = useCallback(() => {
    forgetKey();
    setKeyVersion((v) => v + 1);
    newChat(); // clears the transcript and resets the session's history
  }, [newChat]);

  const value = useMemo<ChatContextValue>(
    () => ({
      open,
      setOpen,
      toggle,
      showSettings,
      setShowSettings,
      settings,
      updateSettings,
      providers: PROVIDERS,
      provider,
      data,
      dataError,
      dataCard,
      postsById,
      session,
      hasKey: keyInfo.hasKey,
      keyMask: keyInfo.keyMask,
      keyBlocked,
      saveKey,
      forgetSavedKey,
      chat,
      launcherRef,
      returnFocusRef,
      textareaRef,
      isMac,
      mock,
      loadingHint,
    }),
    [
      open,
      setOpen,
      toggle,
      showSettings,
      settings,
      updateSettings,
      provider,
      data,
      dataError,
      dataCard,
      postsById,
      session,
      keyInfo,
      keyBlocked,
      saveKey,
      forgetSavedKey,
      chat,
      isMac,
      mock,
      loadingHint,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

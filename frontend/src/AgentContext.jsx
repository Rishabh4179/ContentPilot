/**
 * Agent session state that must survive route changes.
 *
 * The <Agent> page unmounts whenever the user switches tabs (Generator /
 * Library / Agent). Holding its chat state here — in a provider mounted by the
 * always-present Layout — means everything is preserved across navigation.
 *
 * Each mode+article ("thread") can have MANY saved chat sessions (ChatGPT-style
 * history, persisted in the DB). `sessionState` maps a threadKey to the open
 * session + its messages + the session list for that thread.
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useAuthState } from "./AuthGate";

const AgentSessionContext = createContext(null);

export function AgentSessionProvider({ children }) {
  const { userId } = useAuthState();
  // threadKey -> { activeId: number|null, messages: [], list: [] | undefined }
  const [sessionState, setSessionState] = useState({});
  const [selectedId, setSelectedId] = useState(null);
  const [input, setInput] = useState("");
  const [chatMode, setChatMode] = useState("article"); // "article" | "library"
  const ownerRef = useRef(null);

  // If a different user takes over the same tab, drop the previous session so
  // one user's chat never leaks to another.
  useEffect(() => {
    if (!userId) return;
    if (ownerRef.current === null) {
      ownerRef.current = userId;
      return;
    }
    if (ownerRef.current !== userId) {
      ownerRef.current = userId;
      setSessionState({});
      setSelectedId(null);
      setInput("");
      setChatMode("article");
    }
  }, [userId]);

  const value = {
    sessionState,
    setSessionState,
    selectedId,
    setSelectedId,
    input,
    setInput,
    chatMode,
    setChatMode,
  };

  return (
    <AgentSessionContext.Provider value={value}>
      {children}
    </AgentSessionContext.Provider>
  );
}

export function useAgentSession() {
  const ctx = useContext(AgentSessionContext);
  if (!ctx) {
    throw new Error("useAgentSession must be used within an AgentSessionProvider");
  }
  return ctx;
}

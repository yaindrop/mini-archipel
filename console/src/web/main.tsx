import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";

import { HostCard } from "./hostCard.tsx";

interface FleetState {
  ts: number;
  hosts: Array<{
    name: string;
    online: boolean;
    lastError: string | null;
    lastTs: number;
    snapshot: any;
    history: Record<string, Array<{ ts: number; value: number }>>;
  }>;
}

function useFleetState(token: string): FleetState | null {
  const [state, setState] = useState<FleetState | null>(null);
  const [fallbackTick, setFallbackTick] = useState(0);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const suffix = token ? `?token=${encodeURIComponent(token)}` : "";
      socket = new WebSocket(`${protocol}//${location.host}/ws${suffix}`);
      socket.onmessage = (event) => setState(JSON.parse(event.data));
      socket.onclose = () => {
        if (closed) return;
        retry = setTimeout(connect, 2000);
      };
    };
    connect();

    const poll = setInterval(async () => {
      if (document.hidden) return;
      try {
        const response = await fetch(`/api/state`, {
          headers: token ? { authorization: `Bearer ${token}` } : undefined,
        });
        if (response.ok) setState(await response.json());
      } catch {
        /* WebSocket remains the primary feed. */
      }
    }, 2000);
    const visibility = () => setFallbackTick((tick) => tick + 1);
    document.addEventListener("visibilitychange", visibility);

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", visibility);
      socket?.close();
    };
  }, [token, fallbackTick]);

  return state;
}

function TokenGate({ onToken }: { onToken: (token: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="token-gate">
      <input
        placeholder="访问令牌"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onToken(value);
        }}
      />
      <button onClick={() => onToken(value)}>进入</button>
    </div>
  );
}

function App() {
  const [token, setToken] = useState(() => {
    const fromUrl = new URLSearchParams(location.search).get("token");
    if (fromUrl) return fromUrl;
    return localStorage.getItem("fleet-token") ?? "";
  });
  const state = useFleetState(token);
  const clockRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const timer = setInterval(() => {
      if (clockRef.current)
        clockRef.current.textContent = new Date().toLocaleTimeString();
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (token && location.search.includes("token=")) {
      localStorage.setItem("fleet-token", token);
      history.replaceState(null, "", location.pathname);
    }
  }, [token]);

  if (state === null && token === "")
    return (
      <TokenGate
        onToken={(value) => {
          localStorage.setItem("fleet-token", value);
          setToken(value);
        }}
      />
    );

  return (
    <>
      <div className="fleet-header">
        <h1>mini-fleet</h1>
        <span className="muted">
          {state
            ? `${state.hosts.filter((host) => host.online).length}/${state.hosts.length} 在线`
            : "连接中…"}
          {" · "}
          <span ref={clockRef} />
        </span>
      </div>
      <div className="host-grid">
        {(state?.hosts ?? []).map((host) => (
          <HostCard key={host.name} host={host} />
        ))}
      </div>
    </>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);

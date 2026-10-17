import { useEffect, useState } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { FleetSchema, type Fleet } from "../contracts.ts";
import { api, ApiError } from "./api.ts";
export function useFleet(paused: boolean) {
  const client = useQueryClient();
  const [visible, setVisible] = useState(!document.hidden);
  const [connection, setConnection] = useState<
    "connecting" | "live" | "polling"
  >("connecting");
  useEffect(() => {
    const update = () => {
      setVisible(!document.hidden);
    };
    document.addEventListener("visibilitychange", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  const query = useQuery({
    queryKey: ["fleet"],
    queryFn: ({ signal }) => api.fleet(signal),
    enabled: !paused && visible,
    refetchInterval: connection === "live" || paused || !visible ? false : 3000,
    retry: 1,
  });
  useEffect(() => {
    if (!visible) return;
    let closed = false,
      socket: WebSocket | null = null,
      retry: ReturnType<typeof setTimeout> | undefined,
      attempt = 0;
    const connect = () => {
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
      );
      socket.onopen = () => {
        attempt = 0;
        setConnection("live");
      };
      socket.onmessage = (event) => {
        try {
          const parsed = FleetSchema.safeParse(
            JSON.parse(String(event.data)) as unknown,
          );
          if (parsed.success)
            client.setQueryData<Fleet>(["fleet"], parsed.data);
          else socket?.close();
        } catch {
          setConnection("polling");
          socket?.close();
        }
      };
      socket.onclose = () => {
        if (closed) return;
        setConnection("polling");
        retry = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 15000));
      };
      socket.onerror = () => {
        setConnection("polling");
        socket?.close();
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [client, visible]);
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401)
      void client.invalidateQueries({ queryKey: ["session"] });
  }, [query.error, client]);
  return {
    ...query,
    connection: paused
      ? ("paused" as const)
      : !visible
        ? ("hidden" as const)
        : connection,
  };
}

/** Pausing freezes resources; connection health and operation state remain current. */
export function withLivePlugins(frozen: Fleet, live: Fleet | undefined): Fleet {
  if (!live) return frozen;
  return {
    ...frozen,
    plugins: live.plugins,
    hosts: frozen.hosts.map((host) => {
      const current = live.hosts.find((item) => item.name === host.name);
      return {
        ...host,
        online: current?.online ?? host.online,
        lastTs: current?.lastTs ?? host.lastTs,
        lastError: current ? current.lastError : host.lastError,
        snapshot: host.snapshot
          ? {
              ...host.snapshot,
              plugins: current?.snapshot?.plugins ?? host.snapshot.plugins,
              disk_scan:
                current?.snapshot?.disk_scan ?? host.snapshot.disk_scan,
              disk_scans:
                current?.snapshot?.disk_scans ?? host.snapshot.disk_scans,
            }
          : null,
      };
    }),
  };
}

export async function refreshFleet(client: QueryClient): Promise<Fleet> {
  await client.cancelQueries({ queryKey: ["fleet"] });
  return client.query({
    queryKey: ["fleet"],
    queryFn: ({ signal }) => api.fleet(signal),
    staleTime: 0,
  });
}

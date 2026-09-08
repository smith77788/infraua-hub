import * as React from "react";
import { api, ApiError, getStoredApiKey, setStoredApiKey } from "@/console/lib/api";
import { ClearanceLevel } from "@/console/lib/types";

/**
 * Holds the operator's API key and the clearance the *server* resolved from
 * it. The clearance is never chosen in the UI and never inferred locally: it
 * comes back from GET /api/platform/session, so what the console displays is
 * exactly what the API will enforce on every subsequent read.
 */

interface SessionState {
  apiKey: string;
  clearance: ClearanceLevel | null;
  status: "unauthenticated" | "checking" | "authenticated" | "error";
  error: string | null;
  signIn: (key: string) => Promise<boolean>;
  signOut: () => void;
}

const SessionContext = React.createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [apiKey, setApiKey] = React.useState<string>(() => getStoredApiKey());
  const [clearance, setClearance] = React.useState<ClearanceLevel | null>(null);
  const [status, setStatus] = React.useState<SessionState["status"]>(() =>
    getStoredApiKey() ? "checking" : "unauthenticated",
  );
  const [error, setError] = React.useState<string | null>(null);

  const verify = React.useCallback(async (key: string): Promise<boolean> => {
    if (!key) {
      setClearance(null);
      setStatus("unauthenticated");
      setError(null);
      return false;
    }
    setStatus("checking");
    setError(null);
    try {
      const session = await api.session(key);
      setClearance(session.clearance);
      setStatus("authenticated");
      return true;
    } catch (err) {
      setClearance(null);
      const message = err instanceof Error ? err.message : String(err);
      // A rejected key is a normal state to sit in (the operator mistyped it);
      // an unreachable API is an error worth showing differently.
      setStatus(err instanceof ApiError && err.isAuth ? "unauthenticated" : "error");
      setError(message);
      return false;
    }
  }, []);

  // Verify a key restored from storage once on mount.
  const verifiedRef = React.useRef(false);
  React.useEffect(() => {
    if (verifiedRef.current) return;
    verifiedRef.current = true;
    if (apiKey) void verify(apiKey);
  }, [apiKey, verify]);

  const signIn = React.useCallback(
    async (key: string) => {
      const trimmed = key.trim();
      setApiKey(trimmed);
      const ok = await verify(trimmed);
      // Only remember a key the server actually accepted, so a typo does not
      // persist across reloads.
      setStoredApiKey(ok ? trimmed : "");
      return ok;
    },
    [verify],
  );

  const signOut = React.useCallback(() => {
    setApiKey("");
    setClearance(null);
    setStatus("unauthenticated");
    setError(null);
    setStoredApiKey("");
  }, []);

  const value = React.useMemo<SessionState>(
    () => ({ apiKey, clearance, status, error, signIn, signOut }),
    [apiKey, clearance, status, error, signIn, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = React.useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>");
  return ctx;
}

/**
 * The API key for callers that only run inside an authenticated view. Throws
 * rather than returning "" so a query can never silently fire unauthenticated.
 */
export function useApiKey(): string {
  const { apiKey, status } = useSession();
  if (status !== "authenticated") {
    throw new Error("useApiKey called outside an authenticated view");
  }
  return apiKey;
}

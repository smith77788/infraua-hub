import * as React from "react";
import { KeyRound, ShieldCheck, TriangleAlert } from "lucide-react";
import { Button, ErrorNote, Field, Input, Panel } from "@/console/components/primitives";
import { useSession } from "@/console/hooks/useSession";

/**
 * The console's only entry point. There is deliberately no "choose your
 * clearance" control anywhere in this UI: the key is the credential, and the
 * server decides what it unlocks.
 */
export function SignIn() {
  const { signIn, status, error } = useSession();
  const [key, setKey] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [rejected, setRejected] = React.useState(false);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!key.trim()) return;
    setSubmitting(true);
    setRejected(false);
    const ok = await signIn(key);
    setSubmitting(false);
    if (!ok) setRejected(true);
  };

  const unreachable = status === "error";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Palanter</h1>
            <p className="text-xs text-muted-foreground">Sovereign Analyst Console</p>
          </div>
        </div>

        <Panel className="p-5">
          <form onSubmit={onSubmit} className="space-y-4">
            <Field
              label="API key"
              htmlFor="api-key"
              hint="Your clearance is resolved server-side from this key. It is never sent as part of a request body, and the console cannot raise it."
            >
              <div className="relative">
                <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="api-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  className="pl-9 font-mono"
                  placeholder="e.g. demo-analyst"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  autoFocus
                />
              </div>
            </Field>

            {rejected && !unreachable && (
              <ErrorNote>
                That key was not recognised. Keys come from the server&apos;s
                <code className="mx-1 font-mono">PLATFORM_API_KEYS</code>
                environment variable — see <code className="font-mono">.env.example</code>.
              </ErrorNote>
            )}

            {unreachable && error && (
              <div className="flex gap-2 rounded-md border border-clearance-confidential/40 bg-clearance-confidential/10 px-3 py-2 text-xs text-clearance-confidential">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Button type="submit" className="w-full" loading={submitting || status === "checking"}>
              Open console
            </Button>
          </form>
        </Panel>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-muted-foreground">
          Every read is filtered to your clearance before results are assembled, and every ingestion
          and investigation is appended to a hash-chained audit log.
        </p>
      </div>
    </div>
  );
}

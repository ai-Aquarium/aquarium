"use client";

import { createContext, useContext, type ComponentProps, type ReactNode } from "react";

import { useT } from "@/i18n";
import { useHydrated } from "@/lib/use-hydrated";

const HydratedContext = createContext(true);

/**
 * The action a native (pre-hydration) submit goes to: this page's own path
 * with an empty query, so neither the typed values nor the current query
 * string end up in a URL.
 */
export const CREDENTIAL_FORM_ACTION = "?";

export type CredentialFormProps = Omit<ComponentProps<"form">, "method" | "action" | "encType" | "target">;

/**
 * The one `<form>` for anything with a password, secret, token or code field.
 *
 * If the JS bundle is slow or fails to load, the browser would submit a plain
 * `<form>` itself as a GET and put every named field in the URL (history,
 * proxy logs, Referer). This form is `method="post"` to its own path, and its
 * controls sit in a `<fieldset>` that stays disabled until React has hydrated,
 * so a pre-hydration click or Enter does nothing. `SubmitLabel` shows
 * "Loading…" on the submit button until then.
 */
export function CredentialForm({ children, ...rest }: CredentialFormProps) {
  const hydrated = useHydrated();
  return (
    <form
      {...rest}
      method="post"
      action={CREDENTIAL_FORM_ACTION}
      data-credential-form=""
      data-hydrated={hydrated ? "true" : "false"}
    >
      <HydratedContext.Provider value={hydrated}>
        <fieldset disabled={!hydrated} className="contents">
          {children}
        </fieldset>
      </HydratedContext.Provider>
    </form>
  );
}

/** The submit button's label: "Loading…" until the enclosing `CredentialForm` is usable. */
export function SubmitLabel({ children }: { children: ReactNode }) {
  const hydrated = useContext(HydratedContext);
  const t = useT("common");
  return <>{hydrated ? children : t("loading")}</>;
}

"use client";

import Link from "next/link";

import { BTN_PRIMARY } from "@/components/sources/ui";
import { PlusIcon } from "@/components/ui/icons";
import { useT } from "@/i18n/client";

/** Header action on My sources; `?register=1` opens the wizard in SourcesView. */
export function RegisterSourceLink() {
  const t = useT("sources");
  return (
    <Link href="/settings/sources?register=1" scroll={false} data-action="register-source"
      aria-label={t("register")}
      className={`${BTN_PRIMARY} shrink-0 whitespace-nowrap px-3 sm:px-4`}
    >
      <PlusIcon size={16} />
      <span className="sm:hidden">{t("registerShort")}</span>
      <span className="hidden sm:inline">{t("register")}</span>
    </Link>
  );
}

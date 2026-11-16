"use client";

import Link from "next/link";

import { BTN_PRIMARY } from "@/components/sources/ui";
import { PlusIcon } from "@/components/ui/icons";
import { useT } from "@/i18n/client";

/** Header action on My sources; `?register=1` opens the wizard in SourcesView. */
export function RegisterSourceLink() {
  const t = useT("sources");
  return (
    <Link href="/settings/sources?register=1" scroll={false} data-action="register-source" className={BTN_PRIMARY}>
      <PlusIcon size={16} />
      {t("register")}
    </Link>
  );
}

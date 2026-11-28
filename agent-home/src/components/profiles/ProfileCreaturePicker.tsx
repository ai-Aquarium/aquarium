"use client";

import { useState } from "react";

import { CreatureIcon } from "@/components/aquarium/CreatureIcon";
import { Spinner } from "@/components/ui/Spinner";
import { errorText, profilePath, sendJson } from "@/lib/admin-fetch";
import { CREATURES, type CreatureId } from "@/lib/aquarium/creatures";
import { useAction } from "@/lib/use-action";

/** The sea creature that stands for a profile on its card; saved as soon as one is picked. */
export function ProfileCreaturePicker({
  profile,
  value,
  onSaved,
}: {
  profile: string;
  value: CreatureId;
  onSaved(id: CreatureId): Promise<void> | void;
}) {
  const [current, setCurrent] = useState<CreatureId>(value);
  const [saving, setSaving] = useState<CreatureId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { run: choose } = useAction(async (id: CreatureId) => {
    if (id === current) return;
    setSaving(id);
    setError(null);
    try {
      await sendJson(profilePath(profile, "creature"), "PUT", { creature: id });
      setCurrent(id);
      await onSaved(id);
    } catch (err) {
      setError(`Couldn't save the creature (${errorText(err)}).`);
    } finally {
      setSaving(null);
    }
  });

  return (
    <fieldset
      data-component="ProfileCreaturePicker"
      aria-busy={saving !== null}
      className="space-y-1"
    >
      <legend className="font-medium">Creature</legend>
      <p className="text-xs text-[var(--color-muted)]">
        Shown on the profile card so it is easy to spot.
      </p>
      {error ? (
        <p role="alert" className="text-xs text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
      <ul className="grid max-h-48 grid-cols-[repeat(auto-fill,minmax(3rem,1fr))] gap-1.5 overflow-y-auto pr-1">
        {CREATURES.map((c) => {
          const active = c.id === current;
          return (
            <li key={c.id}>
              <button
                type="button"
                title={c.label}
                aria-label={c.label}
                aria-pressed={active}
                data-creature-option={c.id}
                data-appmcp-hint={`Picks the ${c.label} as this profile creature`}
                disabled={saving !== null}
                onClick={() => void choose(c.id)}
                className={`flex h-12 w-full items-center justify-center rounded-[var(--radius-md)] border disabled:opacity-60 ${
                  active
                    ? "border-[var(--color-accent)] bg-[var(--color-surface-2)] ring-2 ring-[var(--color-accent)]"
                    : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-accent)]"
                }`}
              >
                {saving === c.id ? (
                  <Spinner />
                ) : (
                  <CreatureIcon id={c.id} size={36} />
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

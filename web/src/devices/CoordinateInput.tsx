import { useEffect, useState } from "react";
export default function CoordinateInput({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  function commit() {
    const parsed = Number(draft);
    if (draft.trim() && Number.isFinite(parsed) && Math.abs(parsed) < 100000) {
      onCommit(parsed);
      setDraft(String(parsed));
    } else setDraft(String(value));
  }
  return (
    <input
      aria-label={label}
      inputMode="decimal"
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

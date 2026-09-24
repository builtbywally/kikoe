"use client";

import { useState } from "react";

export function CopyButton({ text, label = "copy" }: { text: string; label?: string }) {
  const [said, setSaid] = useState(label);
  return (
    <button
      type="button"
      className="copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setSaid("copied");
        } catch {
          setSaid("select it");
        }
        setTimeout(() => setSaid(label), 1600);
      }}
    >
      {said}
    </button>
  );
}

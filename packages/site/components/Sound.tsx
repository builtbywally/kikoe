"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// Kik speaks through the browser's own voice, and only once the visitor has
// switched sound on. The choice is remembered in this browser alone.

interface Sound {
  on: boolean;
  toggle(): void;
  speak(text: string): void;
}

const SoundContext = createContext<Sound>({ on: false, toggle() {}, speak() {} });
export const useSound = () => useContext(SoundContext);

const KEY = "kikoe-sound";

export function SoundProvider({ children }: { children: React.ReactNode }) {
  const [on, setOn] = useState(false);
  const onRef = useRef(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY) === "on";
      onRef.current = saved;
      setOn(saved);
    } catch {}
  }, []);

  const speak = useCallback((text: string) => {
    if (!onRef.current || !("speechSynthesis" in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.04;
      u.pitch = 0.95;
      const voices = speechSynthesis.getVoices();
      const v =
        voices.find((x) => /en[-_]GB/i.test(x.lang)) ?? voices.find((x) => /^en/i.test(x.lang));
      if (v) u.voice = v;
      speechSynthesis.speak(u);
    } catch {}
  }, []);

  const toggle = useCallback(() => {
    const next = !onRef.current;
    onRef.current = next;
    setOn(next);
    try {
      localStorage.setItem(KEY, next ? "on" : "off");
    } catch {}
    if (next) speak("Sound's on. I'll keep it short.");
    else
      try {
        speechSynthesis.cancel();
      } catch {}
  }, [speak]);

  const value = useMemo(() => ({ on, toggle, speak }), [on, toggle, speak]);
  return <SoundContext.Provider value={value}>{children}</SoundContext.Provider>;
}

export function SoundToggle() {
  const { on, toggle } = useSound();
  return (
    <button
      type="button"
      className="pill-btn"
      aria-pressed={on}
      onClick={toggle}
      title="Let Kik speak through your browser's voice"
    >
      <span className="sound-dot" />
      {on ? "sound on" : "sound off"}
    </button>
  );
}

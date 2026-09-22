'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

const CONFIRM_MS = 1500;

/**
 * Copies an id to the clipboard and says "Copied" for a moment. Rendered
 * only once the browser has shown it has a clipboard, so a browser without
 * one (or a page served over plain http) shows nothing rather than a
 * button that does nothing.
 */
export function CopyId({ id, label = 'Copy id' }: { id: string; label?: string }) {
  const [available, setAvailable] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setAvailable(typeof navigator !== 'undefined' && navigator.clipboard !== undefined);
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  if (!available) return null;

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(id);
    } catch {
      // The browser refused the clipboard, so the label stays as it was
      // and the id is still on screen to select by hand.
      return;
    }
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setCopied(false);
    }, CONFIRM_MS);
  };

  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => {
        void copy();
      }}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {copied ? 'Copied' : label}
    </Button>
  );
}

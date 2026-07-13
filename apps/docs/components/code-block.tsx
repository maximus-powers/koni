"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon } from "@/lib/icons";

type CodeBlockProps = {
  code: string;
  label?: string;
  language?: string;
};

export function CodeBlock({ code, label = "Terminal", language }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{label}</span>
        <button type="button" onClick={copy} aria-label={copied ? "Copied" : "Copy code"}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre data-language={language}><code>{code}</code></pre>
    </div>
  );
}

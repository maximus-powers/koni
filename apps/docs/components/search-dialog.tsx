"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { searchablePages } from "@/content/navigation";
import { ArrowIcon, SearchIcon } from "@/lib/icons";

export function SearchDialog() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return searchablePages;
    return searchablePages.filter((page) =>
      [page.label, page.eyebrow, page.description, ...page.keywords]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.matches("input, textarea, select, [contenteditable='true']");
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      } else if (event.key === "/" && !typing) {
        event.preventDefault();
        setOpen(true);
      } else if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  function submit() {
    if (results[0]) {
      setOpen(false);
      setQuery("");
      router.push(results[0].href);
    }
  }

  function close() {
    setOpen(false);
    setQuery("");
  }

  return (
    <>
      <button className="search-trigger" type="button" onClick={() => setOpen(true)} aria-label="Search documentation">
        <SearchIcon />
        <span>Search</span>
        <kbd>⌘ K</kbd>
      </button>
      {open ? (
        <div className="search-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
          <div className="search-panel" role="dialog" aria-modal="true" aria-label="Search documentation" onMouseDown={(event) => event.stopPropagation()}>
            <div className="search-input-wrap">
              <SearchIcon />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submit();
                }}
                placeholder="Search concepts, commands, configuration…"
                aria-label="Search query"
              />
              <button type="button" onClick={() => setOpen(false)} aria-label="Close search">esc</button>
            </div>
            <div className="search-results" aria-live="polite">
              {results.length ? results.map((page) => (
                <Link key={page.href} className="search-result" href={page.href} onClick={close}>
                  <span className="search-result-copy">
                    <small>{page.eyebrow}</small>
                    <strong>{page.label}</strong>
                    <span>{page.description}</span>
                  </span>
                  <ArrowIcon />
                </Link>
              )) : (
                <div className="search-empty">
                  <strong>No crossing found.</strong>
                  <span>Try “graph”, “init”, or “agents”.</span>
                </div>
              )}
            </div>
            <div className="search-help"><span><kbd>↵</kbd> open first result</span><span><kbd>esc</kbd> close</span></div>
          </div>
        </div>
      ) : null}
    </>
  );
}

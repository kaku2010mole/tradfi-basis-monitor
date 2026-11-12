"use client";

import { useEffect, useRef, useState } from "react";
import { getDisplayTheme, subscribeTheme } from "../lib/themePreference";

export default function JlpFrame() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(1_200);

  useEffect(() => {
    const iframe = frame.current;
    if (!iframe) return;
    let observer: ResizeObserver | undefined;
    const syncTheme = () => {
      const root = iframe.contentDocument?.documentElement;
      if (root) root.dataset.theme = getDisplayTheme();
    };
    const resize = () => {
      const doc = iframe.contentDocument;
      const content = doc?.querySelector("main");
      if (content && doc?.defaultView) {
        const bottom = content.getBoundingClientRect().bottom + doc.defaultView.scrollY;
        setHeight(Math.max(800, Math.ceil(bottom)));
      }
    };
    const attach = () => {
      observer?.disconnect();
      syncTheme();
      const doc = iframe.contentDocument;
      const content = doc?.querySelector("main");
      if (!content) return;
      resize();
      observer = new ResizeObserver(resize);
      observer.observe(content);
    };
    iframe.addEventListener("load", attach);
    const unsubscribeTheme = subscribeTheme(syncTheme);
    if (iframe.contentDocument?.readyState === "complete") attach();
    window.addEventListener("resize", resize);
    return () => {
      iframe.removeEventListener("load", attach);
      unsubscribeTheme();
      window.removeEventListener("resize", resize);
      observer?.disconnect();
    };
  }, []);

  return <iframe ref={frame} title="JLP Research dashboard" src="/jlp-app/index.html?v=20261112-theme" style={{ display: "block", width: "100%", height, border: 0 }} />;
}

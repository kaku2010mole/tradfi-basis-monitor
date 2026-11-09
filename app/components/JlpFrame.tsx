"use client";

import { useEffect, useRef, useState } from "react";

export default function JlpFrame() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(1_200);

  useEffect(() => {
    const iframe = frame.current;
    if (!iframe) return;
    let observer: ResizeObserver | undefined;
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
      const doc = iframe.contentDocument;
      const content = doc?.querySelector("main");
      if (!content) return;
      resize();
      observer = new ResizeObserver(resize);
      observer.observe(content);
    };
    iframe.addEventListener("load", attach);
    if (iframe.contentDocument?.readyState === "complete") attach();
    window.addEventListener("resize", resize);
    return () => {
      iframe.removeEventListener("load", attach);
      window.removeEventListener("resize", resize);
      observer?.disconnect();
    };
  }, []);

  return <iframe ref={frame} title="JLP Research dashboard" src="/jlp-app/index.html" style={{ display: "block", width: "100%", height, border: 0 }} />;
}

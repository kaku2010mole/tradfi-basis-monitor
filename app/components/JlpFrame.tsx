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
      if (doc) setHeight(Math.max(800, doc.documentElement.scrollHeight, doc.body?.scrollHeight || 0));
    };
    const attach = () => {
      observer?.disconnect();
      const doc = iframe.contentDocument;
      if (!doc) return;
      resize();
      observer = new ResizeObserver(resize);
      observer.observe(doc.documentElement);
      if (doc.body) observer.observe(doc.body);
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

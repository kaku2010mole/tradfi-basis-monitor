import { translateInterfaceText } from "./translationCatalog";
import type { DisplayLanguage } from "./languagePreference";

type TextRecord = { original: string; rendered: string };
export type PageTranslator = { setLanguage: (language: DisplayLanguage) => void; dispose: () => void };
const SKIP = 'script,style,noscript,template,code,pre,kbd,textarea,[translate="no"],[data-no-translate],[contenteditable]:not([contenteditable="false"])';
const ATTRIBUTES = ["title", "aria-label", "placeholder", "alt"];

// Only text-node values and presentation attributes change. No wrappers,
// innerHTML, React children, form values, URLs or market-data objects are changed.
export function createPageTranslator(doc: Document): PageTranslator {
  const originals = new WeakMap<Text, TextRecord>();
  const attributes = new WeakMap<Element, Map<string, TextRecord>>();
  const frames = new Map<HTMLIFrameElement, { load: () => void; child: PageTranslator | null }>();
  const Observer = doc.defaultView?.MutationObserver;
  let language: DisplayLanguage = "en", disposed = false;
  const skip = (element: Element | null) => !element || Boolean(element.closest(SKIP));
  const renderText = (node: Text) => {
    if (skip(node.parentElement)) return;
    const current = node.data, previous = originals.get(node);
    if (language === "en") {
      if (previous && current === previous.rendered && current !== previous.original) node.data = previous.original;
      originals.delete(node);
      return;
    }
    if (previous?.rendered === current) return; // Our own mutation, not a new quote.
    const translated = translateInterfaceText(current);
    // Numeric quote-only nodes need no record, cache or additional DOM write.
    if (translated === current) { originals.delete(node); return; }
    originals.set(node, { original: current, rendered: translated });
    node.data = translated;
  };
  const renderAttributes = (element: Element) => {
    if (skip(element)) return;
    for (const name of ATTRIBUTES) {
      const current = element.getAttribute(name);
      if (current === null) continue;
      const previous = attributes.get(element)?.get(name);
      if (language === "en") {
        if (previous && current === previous.rendered && current !== previous.original) element.setAttribute(name, previous.original);
        attributes.get(element)?.delete(name);
      } else if (previous?.rendered !== current) {
        const translated = translateInterfaceText(current);
        if (translated === current) { attributes.get(element)?.delete(name); continue; }
        let records = attributes.get(element);
        if (!records) { records = new Map(); attributes.set(element, records); }
        records.set(name, { original: current, rendered: translated });
        element.setAttribute(name, translated);
      }
    }
  };
  const attachFrame = (frame: HTMLIFrameElement) => {
    if (frames.has(frame) || language === "en") return;
    const handle = { child: null as PageTranslator | null, load: () => {
      handle.child?.dispose(); handle.child = null;
      try {
        // Same-origin JLP only. Never inject scripts or send translation data.
        const childDocument = frame.contentDocument;
        if (childDocument?.documentElement) {
          handle.child = createPageTranslator(childDocument);
          handle.child.setLanguage(language);
        }
      } catch { /* Cross-origin content is deliberately untouched. */ }
    } };
    frames.set(frame, handle);
    frame.addEventListener("load", handle.load);
    handle.load();
  };
  const scan = (root: Node) => {
    if (root.nodeType === 3) { renderText(root as Text); return; }
    const walker = doc.createTreeWalker(root, 1 | 4, { acceptNode(node) {
      const element = node.nodeType === 1 ? node as Element : node.parentElement;
      return skip(element) ? 2 : 1;
    } });
    const visit = (node: Node) => {
      if (node.nodeType === 3) renderText(node as Text);
      else if (node.nodeType === 1) {
        renderAttributes(node as Element);
        if ((node as Element).tagName === "IFRAME") attachFrame(node as HTMLIFrameElement);
      }
    };
    if (root.nodeType === 1 && !skip(root as Element)) visit(root);
    while (walker.nextNode()) visit(walker.currentNode);
  };
  const observer = Observer ? new Observer(records => {
    if (disposed || language === "en") return;
    // Visit just the changed subtrees, not the whole page on every 2s tick.
    const roots = new Set<Node>(), text = new Set<Text>(), attrs = new Set<Element>();
    for (const record of records) {
      if (record.type === "characterData") text.add(record.target as Text);
      else if (record.type === "attributes") attrs.add(record.target as Element);
      else for (const node of record.addedNodes) roots.add(node);
    }
    for (const root of roots) {
      if (!root.isConnected) continue;
      let parent = root.parentNode;
      while (parent && !roots.has(parent)) parent = parent.parentNode;
      if (!parent) scan(root);
    }
    for (const node of text) if (node.isConnected) renderText(node);
    for (const element of attrs) if (element.isConnected) renderAttributes(element);
    for (const [frame, handle] of frames) if (!frame.isConnected) {
      frame.removeEventListener("load", handle.load); handle.child?.dispose(); frames.delete(frame);
    }
  }) : null;
  const stopFrames = () => {
    for (const [frame, handle] of frames) { frame.removeEventListener("load", handle.load); handle.child?.dispose(); }
    frames.clear();
  };
  return {
    setLanguage(next) {
      if (disposed) return;
      observer?.disconnect();
      language = next;
      doc.documentElement.lang = next;
      if (next === "en") stopFrames();
      scan(doc.documentElement);
      if (next === "zh-CN") observer?.observe(doc.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });
    },
    dispose() {
      if (disposed) return;
      observer?.disconnect(); language = "en"; stopFrames();
      scan(doc.documentElement); doc.documentElement.lang = "en";
      disposed = true;
    },
  };
}

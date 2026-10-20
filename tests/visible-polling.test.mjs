import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const source = await readFile(new URL("../app/lib/visiblePolling.ts", import.meta.url), "utf8");
const { visiblePolling } = await import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(source)).toString("base64"));

test("visible 2s cadence remains; hidden tabs have no polling wakeups; resume and cleanup work", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const listeners = new Set();
  const page = { hidden: false, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
  const visible = (value) => { page.hidden = !value; for (const fn of listeners) fn(); };
  let calls = 0;
  const stop = visiblePolling(() => calls++, 2000, page);
  t.mock.timers.tick(0); assert.equal(calls,1);
  for(let i=0;i<30;i++) t.mock.timers.tick(2000);
  assert.equal(calls,31,"30 updates per active minute plus immediate load");
  visible(false);
  for(let i=0;i<30;i++) t.mock.timers.tick(2000);
  assert.equal(calls,31,"zero requests during a hidden minute");
  visible(true); t.mock.timers.tick(0); assert.equal(calls,32);
  visible(true); t.mock.timers.tick(0); t.mock.timers.tick(2000); assert.equal(calls,34,"no duplicate interval after repeated visibility events");
  stop(); t.mock.timers.tick(60000); assert.equal(calls,34); assert.equal(listeners.size,0);
});

test("initially hidden documents do not fetch until visible", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let handler, calls=0;
  const page = { hidden:true, addEventListener:(_,fn)=>handler=fn, removeEventListener:()=>{} };
  const stop=visiblePolling(()=>calls++,2000,page);
  t.mock.timers.tick(60000); assert.equal(calls,0);
  page.hidden=false; handler(); t.mock.timers.tick(0); assert.equal(calls,1);
  stop();
});

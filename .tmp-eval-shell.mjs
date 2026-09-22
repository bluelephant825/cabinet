import WebSocket from 'ws';
const expr = process.argv[2];
const list = await (await fetch('http://127.0.0.1:9335/json/list')).json();
const t = list.find(x => x.type === 'browser_ui');
if (!t) { console.log('NO SHELL'); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pending = new Map();
ws.on('message', d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (m, p) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.on('open', async () => {
  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  console.log(JSON.stringify(res.result?.value ?? res.result ?? res.error ?? res, null, 1).slice(0, 6000));
  ws.close(); process.exit(0);
});
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 15000);

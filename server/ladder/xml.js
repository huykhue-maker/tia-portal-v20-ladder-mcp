'use strict';
// Minimal dependency-free XML parser (keeps source offsets so untouched XML can be preserved
// byte-for-byte) and a tiny serializer for generated SimaticML.

function unescapeXml(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    if (e[1] === 'x') return String.fromCodePoint(parseInt(e.slice(2), 16));
    return String.fromCodePoint(parseInt(e.slice(1), 10));
  });
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) {
  return esc(s).replace(/"/g, '&quot;');
}

function parse(src) {
  const n = src.length;
  const root = { name: '#root', attrs: {}, children: [], text: '', start: 0, end: n, innerStart: 0, innerEnd: n, parent: null };
  const stack = [root];
  let i = 0;
  while (i < n) {
    const top = stack[stack.length - 1];
    const lt = src.indexOf('<', i);
    if (lt < 0) { top.text += unescapeXml(src.slice(i)); break; }
    if (lt > i) top.text += unescapeXml(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      if (e < 0) throw new Error('XML: unterminated comment');
      i = e + 3; continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt);
      if (e < 0) throw new Error('XML: unterminated CDATA');
      top.text += src.slice(lt + 9, e); i = e + 3; continue;
    }
    if (src.startsWith('<?', lt)) {
      const e = src.indexOf('?>', lt);
      if (e < 0) throw new Error('XML: unterminated declaration');
      i = e + 2; continue;
    }
    if (src.startsWith('<!', lt)) { i = src.indexOf('>', lt) + 1; continue; }
    if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt);
      const name = src.slice(lt + 2, e).trim();
      const el = stack.pop();
      if (!el || el.name !== name) throw new Error('XML: mismatched closing tag </' + name + '> (expected </' + (el && el.name) + '>) at offset ' + lt);
      el.end = e + 1; el.innerEnd = lt;
      i = e + 1; continue;
    }
    // opening tag: find '>' outside quotes
    let j = lt + 1, q = null;
    while (j < n) {
      const c = src[j];
      if (q) { if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (c === '>') break;
      j++;
    }
    if (j >= n) throw new Error('XML: unterminated tag at offset ' + lt);
    let inner = src.slice(lt + 1, j);
    const selfClosing = inner.endsWith('/');
    if (selfClosing) inner = inner.slice(0, -1);
    const m = /^([^\s/>]+)/.exec(inner);
    if (!m) throw new Error('XML: bad tag at offset ' + lt);
    const attrs = {};
    const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let am;
    const rest = inner.slice(m[1].length);
    while ((am = re.exec(rest))) attrs[am[1]] = unescapeXml(am[2] !== undefined ? am[2] : am[3]);
    const el = { name: m[1], attrs, children: [], text: '', start: lt, end: j + 1, innerStart: j + 1, innerEnd: j + 1, parent: top, selfClosing };
    top.children.push(el);
    if (!selfClosing) stack.push(el);
    i = j + 1;
  }
  if (stack.length !== 1) throw new Error('XML: unclosed element <' + stack[stack.length - 1].name + '>');
  return root.children[0] || null;
}

function kids(el, name) { return el ? el.children.filter(c => c.name === name) : []; }
function kid(el, name) { return el ? el.children.find(c => c.name === name) || null : null; }
function path(el, p) {
  let cur = el;
  for (const part of p.split('/')) { cur = kid(cur, part); if (!cur) return null; }
  return cur;
}
function descendants(el, name, out) {
  out = out || [];
  for (const c of el.children) { if (c.name === name) out.push(c); descendants(c, name, out); }
  return out;
}
function textOf(el) { return el ? el.text.trim() : ''; }

// ---- serializer for generated documents -----------------------------------
function E(name, attrs, content) {
  return { name, attrs: attrs || {}, content: content === undefined ? [] : (Array.isArray(content) ? content : [content]) };
}
function ser(node, depth, ind) {
  ind = ind === undefined ? '  ' : ind; depth = depth || 0;
  const pad = ind.repeat(depth);
  if (typeof node === 'string') return pad + esc(node);
  let a = '';
  for (const k of Object.keys(node.attrs)) {
    const v = node.attrs[k];
    if (v === undefined || v === null) continue;
    a += ' ' + k + '="' + escAttr(v) + '"';
  }
  const c = node.content.filter(x => x !== null && x !== undefined);
  if (c.length === 0) return pad + '<' + node.name + a + ' />';
  if (c.length === 1 && typeof c[0] === 'string') return pad + '<' + node.name + a + '>' + esc(c[0]) + '</' + node.name + '>';
  return pad + '<' + node.name + a + '>\n' + c.map(x => ser(x, depth + 1, ind)).join('\n') + '\n' + pad + '</' + node.name + '>';
}

module.exports = { parse, kids, kid, path, descendants, textOf, esc, escAttr, unescapeXml, E, ser };

/* TrEnDB chemical structure 2D layout, publication SVG renderer, and molecule card graphic generator. */
(function () {
  "use strict";
  var Ent = window.Ent = window.Ent || {};

  var METALS = {
    21:1,22:1,23:1,24:1,25:1,26:1,27:1,28:1,29:1,30:1,
    39:1,40:1,41:1,42:1,43:1,44:1,45:1,46:1,47:1,48:1,
    57:1,58:1,59:1,60:1,61:1,62:1,63:1,64:1,65:1,66:1,67:1,68:1,69:1,70:1,71:1,
    72:1,73:1,74:1,75:1,76:1,77:1,78:1,79:1,80:1,
    89:1,90:1,91:1,92:1,93:1,94:1,95:1,96:1,97:1,98:1,99:1,100:1,101:1,102:1,103:1,
    104:1,105:1,106:1,107:1,108:1,109:1,110:1,111:1,112:1
  };
  var ORGANIC_SUBSET = { B:1, C:1, N:1, O:1, P:1, S:1, F:1, Cl:1, Br:1, I:1 };

  var PALETTES = {
    light: {
      ink: "#162920", N: "#2563eb", O: "#dc2626", S: "#b45309",
      F: "#059669", Cl: "#15803d", Br: "#9a3412", I: "#6d28d9",
      B: "#c2410c", P: "#d97706", M: "#0f766e", coord: "#0f766e"
    },
    dark: {
      ink: "#e4f2e9", N: "#60a5fa", O: "#f87171", S: "#fbbf24",
      F: "#34d399", Cl: "#4ade80", Br: "#fb923c", I: "#a78bfa",
      B: "#fb923c", P: "#fbbf24", M: "#2dd4bf", coord: "#2dd4bf"
    }
  };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function isMetal(mol, a) {
    return !!METALS[mol.getAtomicNo(a)] || (mol.isMetalAtom && mol.isMetalAtom(a));
  }

  function buildAdj(mol) {
    var n = mol.getAllAtoms();
    var adj = [];
    for (var i = 0; i < n; i++) adj.push([]);
    for (var b = 0; b < mol.getAllBonds(); b++) {
      var u = mol.getBondAtom(0, b), v = mol.getBondAtom(1, b), bt = mol.getBondType(b);
      adj[u].push({ to: v, bond: b, type: bt });
      adj[v].push({ to: u, bond: b, type: bt });
    }
    return adj;
  }

  /* ---------- Connected SMILES writer preserving cBondTypeMetalLigand (16) ---------- */
  Ent.molToSmiles = function (mol) {
    if (!mol || !window.OCL) return "";
    var B_DAT = OCL.Molecule.cBondTypeMetalLigand;
    var hasCoord = false;
    for (var b = 0; b < mol.getAllBonds(); b++) {
      if (mol.getBondType(b) === B_DAT) { hasCoord = true; break; }
    }
    if (!hasCoord) return mol.toIsomericSmiles ? mol.toIsomericSmiles() : mol.toSmiles();

    mol.ensureHelperArrays(OCL.Molecule.cHelperRings);
    var n = mol.getAllAtoms(), adj = buildAdj(mol), order = [];
    for (var a = 0; a < n; a++) if (isMetal(mol, a)) order.push(a);
    for (a = 0; a < n; a++) if (!isMetal(mol, a)) order.push(a);

    var state = new Uint8Array(n), parentOf = new Int32Array(n);
    for (a = 0; a < n; a++) parentOf[a] = -1;
    var treeChildren = [], closures = [], nextRing = 1;
    for (a = 0; a < n; a++) { treeChildren.push([]); closures.push([]); }

    function fmtRing(d) { return d >= 10 ? "%" + d : String(d); }
    function bondSym(from, to, bIdx) {
      if (mol.getBondType(bIdx) === B_DAT) return isMetal(mol, to) ? "->" : "<-";
      if (mol.isAromaticBond(bIdx)) return "";
      var ord = mol.getBondOrder(bIdx);
      if (ord === 2) return "=";
      if (ord === 3) return "#";
      if (mol.isAromaticAtom(from) && mol.isAromaticAtom(to)) return "-";
      return "";
    }
    function atomTok(idx) {
      var sym = mol.getAtomLabel(idx), arom = mol.isAromaticAtom(idx) && !isMetal(mol, idx);
      var chg = mol.getAtomCharge(idx), mass = mol.getAtomMass(idx);
      var impH = mol.getImplicitHydrogens(idx), rad = mol.getAtomRadical(idx);
      var metalBonded = adj[idx].some(function (e) { return isMetal(mol, e.to); });
      if (!arom && !chg && !mass && !rad && !metalBonded && ORGANIC_SUBSET[sym]) return sym;
      if (arom && !chg && !mass && !rad && !metalBonded && (sym === "C" || (sym === "N" && impH === 0))) {
        return sym.toLowerCase();
      }
      var s = "[";
      if (mass) s += mass;
      s += arom ? sym.toLowerCase() : sym;
      if (impH > 0) s += impH === 1 ? "H" : "H" + impH;
      if (chg > 0) s += chg === 1 ? "+" : "+" + chg;
      else if (chg < 0) s += chg === -1 ? "-" : String(chg);
      return s + "]";
    }
    function dfs(u) {
      state[u] = 1;
      for (var i = 0; i < adj[u].length; i++) {
        var e = adj[u][i], v = e.to;
        if (v === parentOf[u]) continue;
        if (state[v] === 0) {
          parentOf[v] = u;
          treeChildren[u].push({ v: v, bond: e.bond });
          dfs(v);
        } else if (state[v] === 1) {
          var d = nextRing++;
          closures[v].push({ digit: d, sym: "" });
          closures[u].push({ digit: d, sym: bondSym(u, v, e.bond) });
        }
      }
      state[u] = 2;
    }
    function emit(u) {
      var out = atomTok(u);
      for (var i = 0; i < closures[u].length; i++) out += closures[u][i].sym + fmtRing(closures[u][i].digit);
      var ch = treeChildren[u];
      for (i = 0; i < ch.length; i++) {
        var sub = bondSym(u, ch[i].v, ch[i].bond) + emit(ch[i].v);
        out += i < ch.length - 1 ? "(" + sub + ")" : sub;
      }
      return out;
    }

    var comps = [];
    for (var k = 0; k < order.length; k++) {
      var root = order[k];
      if (state[root] !== 0) continue;
      dfs(root);
      comps.push(emit(root));
    }
    return comps.join(".");
  };

  /* ---------- Geometry & 2D Layout Solver ---------- */
  function medianBondLength(mol, pts) {
    var B_DAT = OCL.Molecule.cBondTypeMetalLigand;
    var lens = [], fallback = [];
    for (var b = 0; b < mol.getAllBonds(); b++) {
      var u = mol.getBondAtom(0, b), v = mol.getBondAtom(1, b);
      var d = Math.hypot(pts[u].x - pts[v].x, pts[u].y - pts[v].y);
      if (d <= 1e-3) continue;
      fallback.push(d);
      if (mol.getBondType(b) !== B_DAT && !isMetal(mol, u) && !isMetal(mol, v)) lens.push(d);
    }
    var arr = lens.length ? lens : fallback;
    arr.sort(function (a, b) { return a - b; });
    return arr.length ? arr[Math.floor(arr.length / 2)] : 1.5;
  }

  function rotateSubset(pts, indices, cx, cy, angle) {
    var c = Math.cos(angle), s = Math.sin(angle);
    for (var i = 0; i < indices.length; i++) {
      var p = pts[indices[i]], dx = p.x - cx, dy = p.y - cy;
      p.x = cx + dx * c - dy * s;
      p.y = cy + dx * s + dy * c;
    }
  }

  function reflectSubset(pts, indices, x0, y0, ux, uy) {
    for (var i = 0; i < indices.length; i++) {
      var p = pts[indices[i]], dx = p.x - x0, dy = p.y - y0;
      var proj = dx * ux + dy * uy;
      p.x = 2 * (x0 + proj * ux) - p.x;
      p.y = 2 * (y0 + proj * uy) - p.y;
    }
  }

  function reachWithout(adj, start, blocked) {
    var seen = {}, list = [start], q = [start];
    seen[start] = 1;
    while (q.length) {
      var cur = q.shift();
      for (var i = 0; i < adj[cur].length; i++) {
        var nxt = adj[cur][i].to;
        if (blocked[nxt] || seen[nxt]) continue;
        seen[nxt] = 1; list.push(nxt); q.push(nxt);
      }
    }
    return list;
  }

  function reachAcrossBond(adj, start, otherEnd) {
    var seen = {}, list = [start], q = [start];
    seen[start] = 1;
    while (q.length) {
      var cur = q.shift();
      for (var i = 0; i < adj[cur].length; i++) {
        var nxt = adj[cur][i].to;
        if ((cur === start && nxt === otherEnd) || (cur === otherEnd && nxt === start)) continue;
        if (seen[nxt]) continue;
        seen[nxt] = 1; list.push(nxt); q.push(nxt);
      }
    }
    return { set: seen, list: list };
  }

  function countClashes(adj, pts, avgBond) {
    var n = pts.length, thresh = 0.80 * avgBond, score = 0, count = 0;
    var near = [];
    for (var i = 0; i < n; i++) {
      var s = {}; s[i] = 1;
      for (var k = 0; k < adj[i].length; k++) s[adj[i][k].to] = 1;
      near.push(s);
    }
    for (i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        if (near[i][j]) continue;
        var d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
        if (d < thresh) {
          count++;
          var pen = (thresh - d) / avgBond;
          score += pen * pen + 0.1;
        }
      }
    }
    // Penalize non-adjacent atoms sitting right on top of a bond segment
    var bThresh = 0.42 * avgBond;
    for (var b = 0; b < adj.length; b++) {
      for (var ei = 0; ei < adj[b].length; ei++) {
        var to = adj[b][ei].to;
        if (to <= b) continue;
        var bx = pts[to].x - pts[b].x, by = pts[to].y - pts[b].y;
        var bl2 = bx * bx + by * by;
        if (bl2 < 1e-6) continue;
        for (var k = 0; k < n; k++) {
          if (k === b || k === to) continue;
          var t = ((pts[k].x - pts[b].x) * bx + (pts[k].y - pts[b].y) * by) / bl2;
          if (t <= 0.12 || t >= 0.88) continue;
          var dSeg = Math.hypot(pts[k].x - (pts[b].x + t * bx), pts[k].y - (pts[b].y + t * by));
          if (dSeg < bThresh) {
            count++;
            var sp = (bThresh - dSeg) / avgBond;
            score += sp * sp + 0.15;
          }
        }
      }
    }
    return { score: score, count: count };
  }

  function snapshotPoints(pts, indices) {
    return indices.map(function (id) { return { x: pts[id].x, y: pts[id].y }; });
  }
  function restorePoints(pts, indices, saved) {
    for (var i = 0; i < indices.length; i++) {
      pts[indices[i]].x = saved[i].x;
      pts[indices[i]].y = saved[i].y;
    }
  }

  function resolveOrganicClashes(mol, adj, pts, avgBond) {
    var best = countClashes(adj, pts, avgBond);
    if (!best.count) return;
    var B_DAT = OCL.Molecule.cBondTypeMetalLigand, n = mol.getAllAtoms(), cands = [];
    for (var b = 0; b < mol.getAllBonds(); b++) {
      if (mol.isRingBond(b) || mol.getBondOrder(b) !== 1 || mol.getBondType(b) === B_DAT) continue;
      var u = mol.getBondAtom(0, b), v = mol.getBondAtom(1, b);
      if (isMetal(mol, u) || isMetal(mol, v)) continue;
      var sideU = reachAcrossBond(adj, u, v);
      if (sideU.list.length === n) continue;
      var sideV = reachAcrossBond(adj, v, u);
      if (sideV.list.length <= sideU.list.length && sideV.list.length >= 2) cands.push({ root: u, pivot: v, sub: sideV.list });
      else if (sideU.list.length < sideV.list.length && sideU.list.length >= 2) cands.push({ root: v, pivot: u, sub: sideU.list });
    }
    cands.sort(function (a, b) { return a.sub.length - b.sub.length; });

    for (var pass = 0; pass < 4 && best.count > 0; pass++) {
      var improved = false;
      for (var ci = 0; ci < cands.length; ci++) {
        var c = cands[ci], saved = snapshotPoints(pts, c.sub);
        var rx = pts[c.root].x, ry = pts[c.root].y, px = pts[c.pivot].x, py = pts[c.pivot].y;
        var len = Math.hypot(px - rx, py - ry) || avgBond, ux = (px - rx) / len, uy = (py - ry) / len;

        reflectSubset(pts, c.sub, rx, ry, ux, uy);
        var cur = countClashes(adj, pts, avgBond);
        if (cur.score < best.score - 1e-4) { best = cur; improved = true; continue; }
        restorePoints(pts, c.sub, saved);

        var baseAng = Math.atan2(py - ry, px - rx), sibAngs = [];
        for (var si0 = 0; si0 < adj[c.root].length; si0++) {
          var sn = adj[c.root][si0].to;
          if (sn !== c.pivot) sibAngs.push(Math.atan2(pts[sn].y - ry, pts[sn].x - rx));
        }
        var angs = adj[c.root].length >= 4 ? [-15, 15, -30, 30, -50, 50, -75, 75, -105, 105, -140, 140, 180] : [-18, 18, -32, 32];
        var bestAng = 0, bestScore = best.score;
        for (var ai = 0; ai < angs.length; ai++) {
          var rad = angs[ai] * Math.PI / 180, newAng = baseAng + rad, blockedAng = false;
          for (var si1 = 0; si1 < sibAngs.length; si1++) {
            var diff = Math.abs(Math.atan2(Math.sin(newAng - sibAngs[si1]), Math.cos(newAng - sibAngs[si1])));
            if (diff < 0.70) { blockedAng = true; break; }
          }
          if (blockedAng) continue;
          rotateSubset(pts, c.sub, rx, ry, rad);
          cur = countClashes(adj, pts, avgBond);
          if (cur.score < bestScore - 1e-4) { bestScore = cur.score; bestAng = angs[ai]; }
          restorePoints(pts, c.sub, saved);
        }
        if (bestAng !== 0) {
          rotateSubset(pts, c.sub, rx, ry, bestAng * Math.PI / 180);
          best = countClashes(adj, pts, avgBond);
          improved = true;
        }
      }
      if (!improved) break;
    }

    for (pass = 0; pass < 6 && best.count > 0; pass++) {
      var bestCand = null, bestExt = 0, bestS = best;
      for (ci = 0; ci < cands.length; ci++) {
        c = cands[ci];
        if (c.sub.length < 3 && adj[c.root].length < 4) continue;
        rx = pts[c.root].x; ry = pts[c.root].y; px = pts[c.pivot].x; py = pts[c.pivot].y;
        len = Math.hypot(px - rx, py - ry) || avgBond;
        if (len > 1.55 * avgBond) continue;
        ux = (px - rx) / len; uy = (py - ry) / len;
        saved = snapshotPoints(pts, c.sub);
        var exts = [0.35 * avgBond, 0.55 * avgBond];
        for (var ei = 0; ei < exts.length; ei++) {
          if (len + exts[ei] > 1.70 * avgBond) continue;
          for (var si = 0; si < c.sub.length; si++) { pts[c.sub[si]].x += ux * exts[ei]; pts[c.sub[si]].y += uy * exts[ei]; }
          cur = countClashes(adj, pts, avgBond);
          if (cur.score < bestS.score - 1e-3) { bestS = cur; bestCand = c; bestExt = exts[ei]; }
          restorePoints(pts, c.sub, saved);
        }
      }
      if (!bestCand) break;
      rx = pts[bestCand.root].x; ry = pts[bestCand.root].y; px = pts[bestCand.pivot].x; py = pts[bestCand.pivot].y;
      len = Math.hypot(px - rx, py - ry) || avgBond; ux = (px - rx) / len; uy = (py - ry) / len;
      for (si = 0; si < bestCand.sub.length; si++) { pts[bestCand.sub[si]].x += ux * bestExt; pts[bestCand.sub[si]].y += uy * bestExt; }
      best = bestS;
    }
  }

  function buildSubgraphMol(mol, adj, atomIds) {
    var B_DAT = OCL.Molecule.cBondTypeMetalLigand, B_SGL = OCL.Molecule.cBondTypeSingle;
    var map = {}; atomIds.forEach(function (a, idx) { map[a] = idx; });
    var sub = new OCL.Molecule(atomIds.length, Math.max(4, atomIds.length * 2));
    for (var i = 0; i < atomIds.length; i++) {
      var a = atomIds[i], idx = sub.addAtom(mol.getAtomicNo(a));
      sub.setAtomCharge(idx, mol.getAtomCharge(a));
      if (mol.getAtomMass(a)) sub.setAtomMass(idx, mol.getAtomMass(a));
    }
    var seenB = {};
    for (i = 0; i < atomIds.length; i++) {
      var u = atomIds[i];
      for (var j = 0; j < adj[u].length; j++) {
        var e = adj[u][j];
        if (!(e.to in map) || seenB[e.bond]) continue;
        seenB[e.bond] = 1;
        var nb = sub.addBond(map[u], map[e.to]);
        sub.setBondType(nb, e.type === B_DAT ? B_SGL : e.type);
      }
    }
    return { sub: sub, map: map };
  }

  function layoutSubgraph(mol, adj, atomIds) {
    var built = buildSubgraphMol(mol, adj, atomIds), sub = built.sub;
    sub.ensureHelperArrays(OCL.Molecule.cHelperRings);
    sub.inventCoordinates();
    var subPts = [];
    for (var i = 0; i < sub.getAllAtoms(); i++) subPts.push({ x: sub.getAtomX(i), y: sub.getAtomY(i) });
    var subAdj = buildAdj(sub), subAvg = medianBondLength(sub, subPts);
    resolveOrganicClashes(sub, subAdj, subPts, subAvg);
    return { sub: sub, subPts: subPts, subAdj: subAdj, subAvg: subAvg, map: built.map };
  }

  function enforceCisChelate(sub, subAdj, subPts, aIdx, bIdx) {
    if (aIdx === bIdx) return;
    var parent = {}; parent[aIdx] = null;
    var q = [aIdx];
    while (q.length) {
      var cur = q.shift();
      if (cur === bIdx) break;
      for (var i = 0; i < subAdj[cur].length; i++) {
        var e = subAdj[cur][i];
        if (!(e.to in parent)) { parent[e.to] = { prev: cur, bond: e.bond }; q.push(e.to); }
      }
    }
    if (!(bIdx in parent)) return;
    var pathBonds = [], c = bIdx;
    while (parent[c]) {
      pathBonds.push({ u: parent[c].prev, v: c, bond: parent[c].bond });
      c = parent[c].prev;
    }
    var bridge = null;
    for (i = 0; i < pathBonds.length; i++) {
      if (!sub.isRingBond(pathBonds[i].bond) && sub.getBondOrder(pathBonds[i].bond) === 1) { bridge = pathBonds[i]; break; }
    }
    if (!bridge) return;
    var sideB = reachAcrossBond(subAdj, bridge.v, bridge.u).list;
    var ux = subPts[bridge.v].x - subPts[bridge.u].x, uy = subPts[bridge.v].y - subPts[bridge.u].y;
    var len = Math.hypot(ux, uy) || 1, dx = ux / len, dy = uy / len;
    var crossA = dx * (subPts[aIdx].y - subPts[bridge.u].y) - dy * (subPts[aIdx].x - subPts[bridge.u].x);
    var crossB = dx * (subPts[bIdx].y - subPts[bridge.u].y) - dy * (subPts[bIdx].x - subPts[bridge.u].x);
    if (crossA * crossB < 0) reflectSubset(subPts, sideB, subPts[bridge.u].x, subPts[bridge.u].y, dx, dy);
  }

  /* Heuristic donor finder for legacy disconnected metal-ion SMILES (e.g. [Ir+3].[c-]1ccccc1-c1ccccn1...) */
  function inferDisconnectedAnchors(mol, adj, comp) {
    var anchors = [];
    // 1. Charged carbon carbanions ([c-]) or cyanide C ([C-]#N)
    for (var i = 0; i < comp.length; i++) {
      var a = comp[i], lbl = mol.getAtomLabel(a), chg = mol.getAtomCharge(a);
      if ((lbl === "C" || lbl === "N" || lbl === "O" || lbl === "S") && chg < 0) {
        anchors.push({ atom: a, atomicNo: mol.getAtomicNo(a), dative: false });
      }
    }
    // 2. Aromatic pyridine-like N (0 implicit H, 0 charge, 2 heavy neighbors)
    for (i = 0; i < comp.length; i++) {
      a = comp[i];
      if (mol.getAtomLabel(a) === "N" && mol.isAromaticAtom(a) && mol.getAtomCharge(a) === 0 && mol.getImplicitHydrogens(a) === 0 && adj[a].length === 2) {
        anchors.push({ atom: a, atomicNo: 7, dative: true });
      }
    }
    return anchors.length <= 2 ? anchors : anchors.slice(0, 2);
  }

  function layoutMetalComplex(mol, adj, mIdx, disconnectedMode) {
    var B_DAT = OCL.Molecule.cBondTypeMetalLigand, n = mol.getAllAtoms();
    var pts = []; for (var i = 0; i < n; i++) pts.push({ x: 0, y: 0 });
    var blocked = {}, visited = {}; blocked[mIdx] = 1; visited[mIdx] = 1;
    var ligands = [];
    for (var a = 0; a < n; a++) {
      if (visited[a]) continue;
      var comp = reachWithout(adj, a, blocked);
      comp.forEach(function (x) { visited[x] = 1; });
      var anchors = [];
      if (disconnectedMode) {
        anchors = inferDisconnectedAnchors(mol, adj, comp);
      } else {
        for (var j = 0; j < adj[mIdx].length; j++) {
          var e = adj[mIdx][j];
          if (comp.indexOf(e.to) >= 0) anchors.push({ atom: e.to, atomicNo: mol.getAtomicNo(e.to), dative: e.type === B_DAT });
        }
      }
      anchors.sort(function (x, y) { return (x.dative ? 1 : 0) - (y.dative ? 1 : 0) || x.atomicNo - y.atomicNo; });
      ligands.push({ comp: comp, anchors: anchors });
    }

    var coordLigands = ligands.filter(function (l) { return l.anchors.length > 0; });
    var freeFrags = ligands.filter(function (l) { return l.anchors.length === 0; });
    if (!coordLigands.length) return null;

    var globalAvg = 1.0;
    var prepared = coordLigands.map(function (lig) {
      var res = layoutSubgraph(mol, adj, lig.comp), subPts = res.subPts;
      if (res.sub.getAllBonds() > 0 && res.subAvg > 1e-4) {
        var normF = globalAvg / res.subAvg;
        subPts.forEach(function (p) { p.x *= normF; p.y *= normF; });
      }
      var anchorLocal = lig.anchors.map(function (an) { return res.map[an.atom]; });
      if (anchorLocal.length === 2) enforceCisChelate(res.sub, res.subAdj, subPts, anchorLocal[0], anchorLocal[1]);

      var ax = 0, ay = 0;
      anchorLocal.forEach(function (li) { ax += subPts[li].x; ay += subPts[li].y; });
      ax /= anchorLocal.length; ay /= anchorLocal.length;

      var cx = 0, cy = 0;
      subPts.forEach(function (p) { cx += p.x; cy += p.y; });
      cx /= subPts.length; cy /= subPts.length;

      var outX = cx - ax, outY = cy - ay;
      if (anchorLocal.length === 2) {
        var pA = subPts[anchorLocal[0]], pB = subPts[anchorLocal[1]];
        var nx = -(pB.y - pA.y), ny = pB.x - pA.x, nlen = Math.hypot(nx, ny) || 1;
        nx /= nlen; ny /= nlen;
        if (nx * outX + ny * outY < 0) { nx = -nx; ny = -ny; }
        outX = nx; outY = ny;
      } else if (Math.hypot(outX, outY) < 1e-4) {
        outX = 1; outY = 0;
      }
      var curAng = Math.atan2(outY, outX);
      subPts.forEach(function (p) { p.x -= ax; p.y -= ay; });
      rotateSubset(subPts, subPts.map(function (_, k) { return k; }), 0, 0, -curAng);

      if (anchorLocal.length === 2 && subPts[anchorLocal[0]].y > subPts[anchorLocal[1]].y) {
        subPts.forEach(function (p) { p.y = -p.y; });
      }
      return { lig: lig, subPts: subPts, anchorLocal: anchorLocal };
    });

    var bidentates = prepared.filter(function (p) { return p.anchorLocal.length >= 2; });
    var monodentates = prepared.filter(function (p) { return p.anchorLocal.length === 1; });
    var totalCoord = prepared.reduce(function (s, p) { return s + p.anchorLocal.length; }, 0);
    var isOctahedral = totalCoord === 6 && prepared.every(function (p) { return p.anchorLocal.length <= 2; });
    var slots = [], ordered = [], angles = [], bondStereo = {}, i;

    function ligSig(p) {
      return p.anchorLocal.length + ":" + p.lig.anchors.map(function (an) {
        return (an.dative ? "D" : "C") + an.atomicNo;
      }).join(",") + ":" + p.lig.comp.length;
    }

    function assignBidentate(p, thDeg, stereos, mirror) {
      if (mirror) p.subPts.forEach(function (pt) { pt.y = -pt.y; });
      ordered.push(p);
      angles.push(thDeg * Math.PI / 180);
      var a0 = p.lig.anchors[0].atom, a1 = p.lig.anchors[1].atom;
      var s0 = mirror ? stereos[1] : stereos[0], s1 = mirror ? stereos[0] : stereos[1];
      slots.push({ kind: 2, p: p });
      bondStereo[a0 < mIdx ? a0 + ":" + mIdx : mIdx + ":" + a0] = { metal: mIdx, anchor: a0, stereo: s0 };
      bondStereo[a1 < mIdx ? a1 + ":" + mIdx : mIdx + ":" + a1] = { metal: mIdx, anchor: a1, stereo: s1 };
    }

    function assignMonodentate(p, thDeg, stereo) {
      ordered.push(p);
      angles.push(thDeg * Math.PI / 180);
      var a0 = p.lig.anchors[0].atom;
      slots.push({ kind: 1, p: p });
      bondStereo[a0 < mIdx ? a0 + ":" + mIdx : mIdx + ":" + a0] = { metal: mIdx, anchor: a0, stereo: stereo };
    }

    function pairBySignature(list) {
      var counts = {}, sigs = list.map(ligSig);
      sigs.forEach(function (s) { counts[s] = (counts[s] || 0) + 1; });
      var pairs = [], singles = [];
      list.forEach(function (p, idx) {
        var isHomolepticNC = p.lig.anchors.length === 2 && !p.lig.anchors[0].dative && p.lig.anchors[1].dative;
        if (counts[sigs[idx]] === 2 || (list.length === 3 && counts[sigs[idx]] < 3 && isHomolepticNC)) pairs.push(p);
        else singles.push(p);
      });
      if (pairs.length >= 2) return pairs.slice(0, 2).concat(pairs.slice(2)).concat(singles);
      return list.slice();
    }

    if (isOctahedral && bidentates.length === 3) {
      var bs3 = pairBySignature(bidentates), s0 = ligSig(bs3[0]), s1 = ligSig(bs3[1]), s2 = ligSig(bs3[2]);
      var allSameAsym = (s0 === s1 && s1 === s2) &&
        ((bs3[0].lig.anchors[0].dative !== bs3[0].lig.anchors[1].dative) ||
         (bs3[0].lig.anchors[0].atomicNo !== bs3[0].lig.anchors[1].atomicNo));
      assignBidentate(bs3[0], -120, ["down", "plain"], false);
      assignBidentate(bs3[1],  120, ["plain", "up"], !allSameAsym);
      assignBidentate(bs3[2],    0, ["down", "up"], false);
    } else if (isOctahedral && bidentates.length === 2 && monodentates.length === 2) {
      var asymCN = bidentates[0].lig.anchors[0].dative !== bidentates[0].lig.anchors[1].dative ||
                   bidentates[0].lig.anchors[0].atomicNo !== bidentates[0].lig.anchors[1].atomicNo;
      assignBidentate(bidentates[0], -120, ["down", "plain"], false);
      assignBidentate(bidentates[1],  120, ["plain", "up"], asymCN);
      assignMonodentate(monodentates[0], -30, "down");
      assignMonodentate(monodentates[1],  30, "up");
    } else if (isOctahedral && bidentates.length === 1 && monodentates.length === 4) {
      var ms4 = pairBySignature(monodentates);
      assignMonodentate(ms4[0],  -90, "plain");
      assignMonodentate(ms4[1],   90, "plain");
      assignMonodentate(ms4[2], -150, "down");
      assignMonodentate(ms4[3],  150, "up");
      assignBidentate(bidentates[0], 0, ["down", "up"], false);
    } else if (isOctahedral && monodentates.length === 6) {
      var ms6 = pairBySignature(monodentates);
      var octRays = [[-90, "plain"], [90, "plain"], [-150, "down"], [150, "up"], [-30, "down"], [30, "up"]];
      ms6.forEach(function (m, idx) { assignMonodentate(m, octRays[idx][0], octRays[idx][1]); });
    } else {
      isOctahedral = false;
      if (bidentates.length === 2 && monodentates.length === 2) {
        ordered = [monodentates[0], bidentates[0], bidentates[1], monodentates[1]];
        angles = [-42, 138, 222, 42].map(function (d) { return d * Math.PI / 180; });
      } else if (prepared.length === 2) {
        ordered = prepared; angles = [0, Math.PI];
      } else {
        ordered = prepared;
        angles = prepared.map(function (_, idx) { return (-90 + idx * 360 / prepared.length) * Math.PI / 180; });
      }
    }

    var radii = ordered.map(function (p) {
      if (p.anchorLocal.length === 2) {
        var pa = p.subPts[p.anchorLocal[0]], pb = p.subPts[p.anchorLocal[1]];
        var half = Math.hypot(pa.x - pb.x, pa.y - pb.y) / 2;
        if (isOctahedral) return Math.max(1.25 * globalAvg, half * Math.sqrt(3));
        var targetMA = 1.82 * globalAvg;
        return Math.max(1.3 * globalAvg, Math.sqrt(Math.max(0.5, targetMA * targetMA - half * half)));
      }
      return (mol.getAtomCharge(mIdx) !== 0 ? 1.85 : 1.72) * globalAvg;
    });

    function placeAll() {
      pts[mIdx] = { x: 0, y: 0 };
      ordered.forEach(function (p, idx) {
        var th = angles[idx], R = radii[idx], c = Math.cos(th), s = Math.sin(th);
        var ox = R * c, oy = R * s;
        p.lig.comp.forEach(function (origIdx, k) {
          var lp = p.subPts[k];
          pts[origIdx] = { x: ox + lp.x * c - lp.y * s, y: oy + lp.x * s + lp.y * c };
        });
      });
    }
    placeAll();

    for (var step = 0; step < 20; step++) {
      var worst = null, worstRatio = 1.0;
      for (i = 0; i < ordered.length; i++) {
        for (var j = i + 1; j < ordered.length; j++) {
          var bothMono = ordered[i].anchorLocal.length === 1 && ordered[j].anchorLocal.length === 1;
          var bothBulkyMono = bothMono && ordered[i].lig.comp.length >= 6 && ordered[j].lig.comp.length >= 6;
          var bothBi = ordered[i].anchorLocal.length >= 2 && ordered[j].anchorLocal.length >= 2;
          var minReq = bothBulkyMono ? 2.65 * globalAvg : (isOctahedral && bothMono) ? 1.18 * globalAvg : (isOctahedral && bothBi) ? 0.78 * globalAvg : 0.88 * globalAvg;
          for (var ia = 0; ia < ordered[i].lig.comp.length; ia++) {
            for (var ib = 0; ib < ordered[j].lig.comp.length; ib++) {
              var d = Math.hypot(pts[ordered[i].lig.comp[ia]].x - pts[ordered[j].lig.comp[ib]].x,
                                 pts[ordered[i].lig.comp[ia]].y - pts[ordered[j].lig.comp[ib]].y);
              var r = d / minReq;
              if (r < worstRatio) { worstRatio = r; worst = [i, j]; }
            }
          }
        }
      }
      if (!worst) break;
      var wi = worst[0], wj = worst[1];
      var iMono = ordered[wi].anchorLocal.length === 1, jMono = ordered[wj].anchorLocal.length === 1;
      if (isOctahedral && iMono !== jMono) {
        if (iMono) radii[wi] += 0.30 * globalAvg;
        else radii[wj] += 0.30 * globalAvg;
      } else {
        radii[wi] += 0.25 * globalAvg;
        radii[wj] += 0.25 * globalAvg;
      }
      placeAll();
    }

    if (freeFrags.length) {
      var maxX = 0;
      coordLigands.forEach(function (l) { l.comp.forEach(function (idx) { if (pts[idx].x > maxX) maxX = pts[idx].x; }); });
      var cursorX = maxX + 1.8 * globalAvg;
      freeFrags.forEach(function (frag) {
        var res = layoutSubgraph(mol, adj, frag.comp);
        var minFX = Infinity, maxFX = -Infinity, sumY = 0;
        res.subPts.forEach(function (p) { if (p.x < minFX) minFX = p.x; if (p.x > maxFX) maxFX = p.x; sumY += p.y; });
        var midY = sumY / res.subPts.length;
        frag.comp.forEach(function (origIdx, k) {
          pts[origIdx] = { x: cursorX + (res.subPts[k].x - minFX), y: res.subPts[k].y - midY };
        });
        cursorX += (maxFX - minFX) + 1.5 * globalAvg;
      });
    }

    var virtualCoords = [];
    if (disconnectedMode) {
      coordLigands.forEach(function (l) {
        l.anchors.forEach(function (an) { virtualCoords.push({ from: an.atom, to: mIdx, dative: true }); });
      });
    }
    return { pts: pts, avgBond: globalAvg, virtualCoords: virtualCoords, bondStereo: bondStereo, isOctahedral: isOctahedral };
  }

  function orientHorizontal(mol, adj, pts, avgBond, onlyOrtho) {
    var n = pts.length;
    if (n <= 2) return;
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, i;
    for (i = 0; i < n; i++) {
      if (pts[i].x < minX) minX = pts[i].x; if (pts[i].x > maxX) maxX = pts[i].x;
      if (pts[i].y < minY) minY = pts[i].y; if (pts[i].y > maxY) maxY = pts[i].y;
    }
    var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, pad = 0.6 * (avgBond || 1.5);
    var cands = onlyOrtho ? [0, -90, 90] : [0, -90, 90, -60, 60, -30, 30];
    function measure(deg) {
      var rad = deg * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
      var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, upScore = 0;
      for (var k = 0; k < n; k++) {
        var dx = pts[k].x - cx, dy = pts[k].y - cy;
        var rx = dx * c - dy * s, ry = dx * s + dy * c;
        if (rx < x0) x0 = rx; if (rx > x1) x1 = rx;
        if (ry < y0) y0 = ry; if (ry > y1) y1 = ry;
        var z = mol.getAtomicNo(k);
        if (z === 8 || z === 7 || z === 16) {
          var w = (adj[k].length === 1 && mol.getBondOrder(adj[k][0].bond) === 2) ? 4 : (adj[k].length === 1 ? 1.5 : 0.4);
          upScore -= ry * w;
        }
      }
      var wSpan = (x1 - x0) + pad, hSpan = (y1 - y0) + pad;
      return { deg: deg, w: wSpan, h: hSpan, asp: wSpan / hSpan, upScore: upScore };
    }
    var base = measure(0);
    if (base.asp >= (onlyOrtho ? 1.04 : 1.12)) return;
    var best = base, bestRank = -Infinity;
    for (i = 0; i < cands.length; i++) {
      var m = measure(cands[i]), isOrtho = (m.deg % 90 === 0);
      var cappedAsp = Math.min(2.1, m.asp);
      /* Prefer clean 0/+-90 orientations whenever already horizontal */
      var rank = cappedAsp + (isOrtho && m.asp >= 1.04 ? 0.35 : 0) + (m.deg === 0 ? 0.05 : 0);
      if (rank > bestRank + 1e-4 || (Math.abs(rank - bestRank) <= 1e-4 && m.upScore > best.upScore + 1e-3)) {
        bestRank = rank;
        best = m;
      }
    }
    if (best.deg !== 0) rotateSubset(pts, pts.map(function (_, idx) { return idx; }), cx, cy, best.deg * Math.PI / 180);
  }

  function computeLayout(mol) {
    mol.ensureHelperArrays(OCL.Molecule.cHelperRings);
    var adj = buildAdj(mol), metals = [], loneMetals = [], res = null;
    for (var a = 0; a < mol.getAllAtoms(); a++) {
      if (!isMetal(mol, a)) continue;
      if (adj[a].length >= 2) metals.push(a);
      else if (adj[a].length === 0 && mol.getAllAtoms() > 2) loneMetals.push(a);
    }
    if (metals.length === 1) res = layoutMetalComplex(mol, adj, metals[0], false);
    else if (loneMetals.length === 1 && !metals.length) res = layoutMetalComplex(mol, adj, loneMetals[0], true);
    if (!res) {
      mol.inventCoordinates();
      var pts = [];
      for (a = 0; a < mol.getAllAtoms(); a++) pts.push({ x: mol.getAtomX(a), y: mol.getAtomY(a) });
      var avgBond = medianBondLength(mol, pts);
      resolveOrganicClashes(mol, adj, pts, avgBond);
      res = { pts: pts, avgBond: avgBond, virtualCoords: [], bondStereo: null, isOctahedral: false };
    }
    orientHorizontal(mol, adj, res.pts, res.avgBond, res.isOctahedral);
    return res;
  }

  /* ---------- Publication-Grade SVG Renderer ---------- */
  function doubleBondSide(mol, adj, pts, b, u, v) {
    var rs = mol.getRingSet();
    if (mol.isRingBond(b) && rs) {
      var ux = pts[v].x - pts[u].x, uy = pts[v].y - pts[u].y, nx = -uy, ny = ux;
      var ringSum = 0, rCnt = 0;
      for (var r = 0; r < rs.getSize(); r++) {
        var rb = rs.getRingBonds(r), hasB = false;
        for (var k = 0; k < rb.length; k++) if (rb[k] === b) { hasB = true; break; }
        if (!hasB) continue;
        var ra = rs.getRingAtoms(r), cx = 0, cy = 0;
        for (k = 0; k < ra.length; k++) { cx += pts[ra[k]].x; cy += pts[ra[k]].y; }
        cx /= ra.length; cy /= ra.length;
        ringSum += (cx - (pts[u].x + pts[v].x) / 2) * nx + (cy - (pts[u].y + pts[v].y) / 2) * ny;
        rCnt++;
      }
      if (rCnt > 0 && Math.abs(ringSum) > 1e-4) return ringSum > 0 ? 1 : -1;
    }
    if (adj[u].length === 1 || adj[v].length === 1) return 0;
    var dx = pts[v].x - pts[u].x, dy = pts[v].y - pts[u].y, mx = -dy, my = dx, score = 0;
    adj[u].forEach(function (e) { if (e.to !== v) score += (pts[e.to].x - pts[u].x) * mx + (pts[e.to].y - pts[u].y) * my; });
    adj[v].forEach(function (e) { if (e.to !== u) score += (pts[e.to].x - pts[v].x) * mx + (pts[e.to].y - pts[v].y) * my; });
    if (Math.abs(score) > 1e-3) return score > 0 ? 1 : -1;
    return 1;
  }

  function clipEndpoint(x1, y1, x2, y2, box) {
    if (!box) return [x1, y1];
    var dx = x2 - x1, dy = y2 - y1;
    if (Math.hypot(dx, dy) < 1e-4) return [x1, y1];
    var xmin = box.cx - box.hw, xmax = box.cx + box.hw, ymin = box.cy - box.hh, ymax = box.cy + box.hh;
    var t0 = 0, t1 = 1;
    if (Math.abs(dx) > 1e-6) {
      var tx1 = (xmin - x1) / dx, tx2 = (xmax - x1) / dx;
      t0 = Math.max(t0, Math.min(tx1, tx2)); t1 = Math.min(t1, Math.max(tx1, tx2));
    } else if (x1 < xmin || x1 > xmax) return [x1, y1];
    if (Math.abs(dy) > 1e-6) {
      var ty1 = (ymin - y1) / dy, ty2 = (ymax - y1) / dy;
      t0 = Math.max(t0, Math.min(ty1, ty2)); t1 = Math.min(t1, Math.max(ty1, ty2));
    } else if (y1 < ymin || y1 > ymax) return [x1, y1];
    if (t0 <= t1 && t1 > 0 && t1 <= 1.0) return [x1 + dx * t1, y1 + dy * t1];
    return [x1, y1];
  }

  function formatAtomLabel(mol, adj, pts, a) {
    var lbl = mol.getAtomLabel(a), chg = mol.getAtomCharge(a);
    var impH = mol.getImplicitHydrogens(a), rad = mol.getAtomRadical(a), deg = adj[a].length;
    if (lbl === "C" && chg === 0 && rad === 0 && deg > 0) return null;
    var hLeft = false;
    if (impH > 0 && deg > 0) {
      var avgDx = 0;
      for (var i = 0; i < adj[a].length; i++) avgDx += pts[adj[a][i].to].x - pts[a].x;
      if (avgDx > 0.15) hLeft = true;
    }
    var chgStr = chg === 0 ? "" : chg === 1 ? "+" : chg === -1 ? "−" : (chg > 0 ? chg + "+" : Math.abs(chg) + "−");
    return { sym: lbl, impH: impH, hLeft: hLeft, chgStr: chgStr };
  }

  /* Exact Drawing settings from ChemDraw 23.1 "Template catalytic cycles.cdxml" (ACS 1996 + Arial) */
  var CHEMDRAW_PRESET = {
    fontFamily: "Arial,Helvetica,system-ui,sans-serif",
    fontWeight: "400",
    metalWeight: "600",
    bondLength: 14.40,
    lineWidth: 0.60,
    boldWidth: 2.00,
    bondSpacingPct: 18,
    hashSpacing: 2.50,
    marginWidth: 1.60,
    labelSize: 10.0
  };

  var ABBR_DEFS = {
    CF3:  { role: "ink", fwd: [{ t: "CF" }, { t: "3", sub: 1 }], rev: [{ t: "F" }, { t: "3", sub: 1 }, { t: "C" }] },
    C6F5: { role: "ink", fwd: [{ t: "C" }, { t: "6", sub: 1 }, { t: "F" }, { t: "5", sub: 1 }], rev: [{ t: "F" }, { t: "5", sub: 1 }, { t: "C" }, { t: "6", sub: 1 }] },
    NMe2: { role: "N",   fwd: [{ t: "NMe" }, { t: "2", sub: 1 }], rev: [{ t: "Me" }, { t: "2", sub: 1 }, { t: "N" }] },
    OMe:  { role: "O",   fwd: [{ t: "OMe" }], rev: [{ t: "MeO" }] },
    tBu:  { role: "ink", fwd: [{ t: "t", ital: 1 }, { t: "-Bu" }], rev: [{ t: "t", ital: 1 }, { t: "-Bu" }] },
    Mes:  { role: "ink", fwd: [{ t: "Mes" }], rev: [{ t: "Mes" }] }
  };

  function compressMolForDisplay(mol) {
    mol.ensureHelperArrays(OCL.Molecule.cHelperRings);
    var n = mol.getAllAtoms(), adj = buildAdj(mol), rs = mol.getRingSet();
    var B_DAT = OCL.Molecule.cBondTypeMetalLigand;

    function isTerm(a, parentAtomicNo) {
      return a != null && mol.getAtomicNo(a) === parentAtomicNo && mol.getAtomCharge(a) === 0 &&
        !mol.isRingAtom(a) && adj[a].length === 1 && mol.getBondOrder(adj[a][0].bond) === 1 && adj[a][0].type !== B_DAT;
    }
    function allSingleNonMetal(a) {
      for (var i = 0; i < adj[a].length; i++) {
        if (mol.getBondOrder(adj[a][i].bond) !== 1 || adj[a][i].type === B_DAT || isMetal(mol, adj[a][i].to)) return false;
      }
      return true;
    }

    var candidates = [], ringCount = [], i, j, r;
    for (i = 0; i < n; i++) ringCount.push(0);
    if (rs) {
      for (r = 0; r < rs.getSize(); r++) {
        var ra0 = rs.getRingAtoms(r);
        for (i = 0; i < ra0.length; i++) ringCount[ra0[i]]++;
      }
      for (r = 0; r < rs.getSize(); r++) {
        var ra = rs.getRingAtoms(r);
        if (ra.length !== 6) continue;
        var inThis = {}, ringOk = true;
        for (i = 0; i < 6; i++) {
          var ri = ra[i]; inThis[ri] = 1;
          if (mol.getAtomicNo(ri) !== 6 || mol.getAtomCharge(ri) !== 0 || ringCount[ri] !== 1) { ringOk = false; break; }
        }
        if (!ringOk || n - 11 < 4) continue;
        var extAtoms = [];
        for (i = 0; i < 6 && ringOk; i++) {
          var aR = ra[i], exts = [];
          for (j = 0; j < adj[aR].length; j++) if (!inThis[adj[aR][j].to]) exts.push(adj[aR][j]);
          if (exts.length > 1) { ringOk = false; break; }
          if (exts.length === 1) extAtoms.push({ ringAtom: aR, nb: exts[0].to, bond: exts[0].bond, order: mol.getBondOrder(exts[0].bond), type: exts[0].type });
        }
        if (!ringOk) continue;
        var nonSubst = extAtoms.filter(function (ex) { return !isTerm(ex.nb, 9) && !isTerm(ex.nb, 6); });
        if (nonSubst.length === 1 && nonSubst[0].order === 1 && nonSubst[0].type !== B_DAT && !isMetal(mol, nonSubst[0].nb)) {
          var ipso = nonSubst[0].ringAtom, anchor = nonSubst[0].nb;
          var otherExts = extAtoms.filter(function (ex) { return ex.ringAtom !== ipso; });
          if (otherExts.length === 5 && otherExts.every(function (ex) { return isTerm(ex.nb, 9); })) {
            candidates.push({ kind: "C6F5", anchor: anchor, bondType: nonSubst[0].type, atoms: ra.concat(otherExts.map(function (ex) { return ex.nb; })) });
          } else if (otherExts.length === 3 && otherExts.every(function (ex) { return isTerm(ex.nb, 6); })) {
            var ordered = [ipso], prev = ipso;
            for (var step = 0; step < 5; step++) {
              var cur = ordered[ordered.length - 1], nxt = -1;
              for (j = 0; j < adj[cur].length; j++) {
                var cnb = adj[cur][j].to;
                if (inThis[cnb] && cnb !== prev && ordered.indexOf(cnb) < 0) { nxt = cnb; break; }
              }
              if (nxt < 0) break;
              prev = cur; ordered.push(nxt);
            }
            if (ordered.length === 6) {
              var extNb = function (idx) {
                for (var q = 0; q < adj[idx].length; q++) if (!inThis[adj[idx][q].to]) return adj[idx][q].to;
                return null;
              };
              if (isTerm(extNb(ordered[1]), 6) && !extNb(ordered[2]) && isTerm(extNb(ordered[3]), 6) && !extNb(ordered[4]) && isTerm(extNb(ordered[5]), 6)) {
                candidates.push({ kind: "Mes", anchor: anchor, bondType: nonSubst[0].type, atoms: ra.concat(otherExts.map(function (ex) { return ex.nb; })) });
              }
            }
          }
        }
      }
    }

    for (var a = 0; a < n; a++) {
      var z = mol.getAtomicNo(a);
      if (mol.getAtomCharge(a) !== 0 || mol.isRingAtom(a) || !allSingleNonMetal(a)) continue;
      if (z === 6 && adj[a].length === 4) {
        var fs = [], mes = [], rest = [];
        for (i = 0; i < 4; i++) {
          var nb = adj[a][i];
          if (isTerm(nb.to, 9)) fs.push(nb.to);
          else if (isTerm(nb.to, 6)) mes.push(nb.to);
          else rest.push(nb);
        }
        if (fs.length === 3 && rest.length === 1 && n - 4 >= 3) {
          candidates.push({ kind: "CF3", anchor: rest[0].to, bondType: rest[0].type, atoms: [a].concat(fs) });
        } else if (mes.length === 3 && rest.length === 1 && n - 4 >= 4) {
          candidates.push({ kind: "tBu", anchor: rest[0].to, bondType: rest[0].type, atoms: [a].concat(mes) });
        }
      } else if (z === 7 && adj[a].length === 3) {
        var nMes = [], nRest = [];
        for (i = 0; i < 3; i++) {
          nb = adj[a][i];
          if (isTerm(nb.to, 6)) nMes.push(nb.to); else nRest.push(nb);
        }
        if (nMes.length === 2 && nRest.length === 1 && mol.getAtomicNo(nRest[0].to) === 6 && n - 3 >= 5) {
          candidates.push({ kind: "NMe2", anchor: nRest[0].to, bondType: nRest[0].type, atoms: [a].concat(nMes) });
        }
      } else if (z === 8 && adj[a].length === 2) {
        var oMes = [], oRest = [];
        for (i = 0; i < 2; i++) {
          nb = adj[a][i];
          if (isTerm(nb.to, 6)) oMes.push(nb.to); else oRest.push(nb);
        }
        if (oMes.length === 1 && oRest.length === 1 && mol.getAtomicNo(oRest[0].to) === 6 && n - 2 >= 6) {
          candidates.push({ kind: "OMe", anchor: oRest[0].to, bondType: oRest[0].type, atoms: [a].concat(oMes) });
        }
      }
    }

    if (!candidates.length) return { mol: mol, abbr: {} };
    candidates.sort(function (x, y) { return y.atoms.length - x.atoms.length; });
    var hidden = {}, keptGroups = [];
    for (i = 0; i < candidates.length; i++) {
      var g = candidates[i], conflict = !!hidden[g.anchor];
      for (j = 0; j < g.atoms.length && !conflict; j++) if (hidden[g.atoms[j]]) conflict = true;
      if (conflict) continue;
      for (j = 0; j < g.atoms.length; j++) hidden[g.atoms[j]] = 1;
      keptGroups.push(g);
    }
    if (!keptGroups.length) return { mol: mol, abbr: {} };

    var atomMap = {}, keepIds = [];
    for (a = 0; a < n; a++) if (!hidden[a]) keepIds.push(a);
    var disp = new OCL.Molecule(keepIds.length + keptGroups.length, mol.getAllBonds() + keptGroups.length);
    for (i = 0; i < keepIds.length; i++) {
      a = keepIds[i];
      var na = disp.addAtom(mol.getAtomicNo(a));
      disp.setAtomCharge(na, mol.getAtomCharge(a));
      if (mol.getAtomMass(a)) disp.setAtomMass(na, mol.getAtomMass(a));
      atomMap[a] = na;
    }
    for (var b = 0; b < mol.getAllBonds(); b++) {
      var u = mol.getBondAtom(0, b), v = mol.getBondAtom(1, b);
      if (hidden[u] || hidden[v]) continue;
      var nbIdx = disp.addBond(atomMap[u], atomMap[v]);
      disp.setBondType(nbIdx, mol.getBondType(b));
    }
    var abbrMap = {};
    for (i = 0; i < keptGroups.length; i++) {
      g = keptGroups[i];
      var pa = disp.addAtom(9);
      var pb = disp.addBond(atomMap[g.anchor], pa);
      disp.setBondType(pb, g.bondType || OCL.Molecule.cBondTypeSingle);
      abbrMap[pa] = { kind: g.kind, anchor: atomMap[g.anchor] };
    }
    disp.ensureHelperArrays(OCL.Molecule.cHelperRings);
    return { mol: disp, abbr: abbrMap };
  }

  function segsMetrics(segs, fontSize) {
    var tot = 0;
    for (var i = 0; i < segs.length; i++) {
      var st = segs[i];
      tot += st.t.length * fontSize * (st.sub ? 0.44 : st.ital ? 0.42 : 0.61);
    }
    return tot;
  }

  function renderSegsHtml(segs, tyStr, subY) {
    var out = "", needReset = false;
    for (var i = 0; i < segs.length; i++) {
      var st = segs[i], txt = esc(st.t);
      if (st.sub) {
        out += '<tspan y="' + subY + '" font-size="72%">' + txt + "</tspan>";
        needReset = true;
      } else {
        var inner = st.ital ? '<tspan font-style="italic">' + txt + "</tspan>" : txt;
        if (needReset) { out += '<tspan y="' + tyStr + '">' + inner + "</tspan>"; needReset = false; }
        else out += inner;
      }
    }
    return out;
  }

  function roleColorAttr(role, pal, cssThemed, mono) {
    if (mono) return cssThemed ? 'class="chem-ink"' : 'fill="' + pal.ink + '"';
    if (cssThemed) {
      if (role === "M") return 'class="chem-M"';
      if (PALETTES.light[role]) return 'class="chem-' + role + '"';
      return 'class="chem-ink"';
    }
    var col = role === "M" ? pal.M : (pal[role] || pal.ink);
    return 'fill="' + col + '"';
  }

  function colorSpec(mol, a, pal, cssThemed, mono) {
    var role = isMetal(mol, a) ? "M" : mol.getAtomLabel(a);
    return { attr: roleColorAttr(role, pal, cssThemed, mono) };
  }

  function strokeAttr(role, pal, cssThemed) {
    if (cssThemed) return 'class="chem-stroke-' + role + '"';
    return 'stroke="' + (role === "coord" ? pal.coord : pal.ink) + '"';
  }

  function fillAttr(role, pal, cssThemed) {
    if (cssThemed) return 'class="chem-fill-' + role + '"';
    return 'fill="' + (role === "coord" ? pal.coord : pal.ink) + '"';
  }

  Ent.toCleanMolfile = function (smiles) {
    if (!window.OCL || !smiles) return null;
    try {
      var m = OCL.Molecule.fromSmiles(smiles);
      if (!(m.getAllAtoms() > 0)) return null;
      m.ensureHelperArrays(OCL.Molecule.cHelperRings);
      if (m.getStereoCenterCount && m.getStereoCenterCount() > 0) return null;
      var res = computeLayout(m);
      for (var a = 0; a < m.getAllAtoms(); a++) {
        m.setAtomX(a, res.pts[a].x);
        m.setAtomY(a, res.pts[a].y);
      }
      return m.toMolfile();
    } catch (e) { return null; }
  };

  Ent.renderStructure = function (mol, opts) {
    if (!mol || !window.OCL || !(mol.getAllAtoms() > 0)) return null;
    opts = opts || {};
    var cssThemed = !!opts.cssThemed, mono = !!opts.mono;
    var pal = PALETTES[opts.theme === "dark" ? "dark" : "light"];
    var B_DAT = OCL.Molecule.cBondTypeMetalLigand, B_UP = OCL.Molecule.cBondTypeUp;
    var B_DOWN = OCL.Molecule.cBondTypeDown, B_CROSS = OCL.Molecule.cBondTypeCross;

    var comp = opts.compact === false ? { mol: mol, abbr: {} } : compressMolForDisplay(mol);
    var dmol = comp.mol, abbrMap = comp.abbr;
    var layout = computeLayout(dmol), rawPts = layout.pts, rawAvg = layout.avgBond;
    var adj = buildAdj(dmol), n = dmol.getAllAtoms();

    /* Exact ratios scaled from ChemDraw 23.1 Template catalytic cycles.cdxml */
    var cd = CHEMDRAW_PRESET;
    var bondPx = opts.bondPx || 24, scale = bondPx / (rawAvg || 1.5);
    var cdScale = bondPx / cd.bondLength;
    var pts = rawPts.map(function (p) { return { x: p.x * scale, y: p.y * scale }; });

    var fontSize = +(cd.labelSize * cdScale).toFixed(2);
    var sw = Math.max(0.82, +(cd.lineWidth * cdScale).toFixed(2));
    var off = +(bondPx * (cd.bondSpacingPct / 100)).toFixed(2);
    var off0 = +(off * 0.50).toFixed(2);
    var off3 = +(off * 0.86).toFixed(2);
    var wedgeHalf = +(cd.boldWidth * cdScale * 0.5).toFixed(2);
    var hashStep = Math.max(2.6, cd.hashSpacing * cdScale);
    var atomMargin = Math.max(1.6, cd.marginWidth * cdScale);
    var fScale = fontSize / 13.5;

    var labels = [], boxes = [];
    for (var a = 0; a < n; a++) {
      if (abbrMap[a]) {
        var gInfo = abbrMap[a], gDef = ABBR_DEFS[gInfo.kind];
        var dxG = pts[a].x - pts[gInfo.anchor].x;
        var gDir = dxG > 0.22 * bondPx ? "right" : dxG < -0.22 * bondPx ? "left" : "mid";
        var segs = gDir === "left" ? gDef.rev : gDef.fwd;
        var totW = segsMetrics(segs, fontSize), anchW = fontSize * 0.62;
        var lExt, rExt, txStart;
        if (gDir === "right") {
          lExt = anchW / 2 + atomMargin; rExt = (totW - anchW / 2) + atomMargin; txStart = pts[a].x - anchW / 2;
        } else if (gDir === "left") {
          lExt = (totW - anchW / 2) + atomMargin; rExt = anchW / 2 + atomMargin; txStart = pts[a].x - totW + anchW / 2;
        } else {
          lExt = totW / 2 + atomMargin; rExt = totW / 2 + atomMargin; txStart = pts[a].x - totW / 2;
        }
        labels.push({ abbr: { segs: segs, txStart: txStart, role: gDef.role } });
        boxes.push({ cx: pts[a].x + (rExt - lExt) / 2, cy: pts[a].y, hw: (lExt + rExt) / 2, hh: fontSize * 0.56 });
        continue;
      }
      var info = formatAtomLabel(dmol, adj, pts, a);
      labels.push(info);
      if (!info) { boxes.push(null); continue; }
      var metalAtom = isMetal(dmol, a);
      var symW = info.sym.length * (metalAtom ? 9.5 : 8.1) * fScale;
      var hW = info.impH > 0 ? (8.1 + (info.impH > 1 ? 5.6 : 0)) * fScale : 0;
      var cW = info.chgStr ? info.chgStr.length * 6.0 * fScale : 0;
      var pad = metalAtom ? atomMargin * 1.55 : atomMargin;
      var leftExt = symW / 2 + pad, rightExt = symW / 2 + pad;
      if (info.impH > 0) { if (info.hLeft) leftExt += hW; else rightExt += hW; }
      rightExt += cW;
      boxes.push({ cx: pts[a].x + (rightExt - leftExt) / 2, cy: pts[a].y, hw: (leftExt + rightExt) / 2, hh: (metalAtom ? 9.2 : 7.4) * fScale });
    }

    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (a = 0; a < n; a++) {
      var bx = boxes[a];
      if (bx) {
        minX = Math.min(minX, bx.cx - bx.hw); maxX = Math.max(maxX, bx.cx + bx.hw);
        minY = Math.min(minY, bx.cy - bx.hh); maxY = Math.max(maxY, bx.cy + bx.hh);
      } else {
        minX = Math.min(minX, pts[a].x - 3); maxX = Math.max(maxX, pts[a].x + 3);
        minY = Math.min(minY, pts[a].y - 3); maxY = Math.max(maxY, pts[a].y + 3);
      }
    }
    var margin = opts.margin != null ? opts.margin : 12;
    minX -= margin; maxX += margin; minY -= margin; maxY += margin;
    var vbW = Math.max(60, maxX - minX), vbH = Math.max(44, maxY - minY);

    var elems = [], inkStroke = strokeAttr("ink", pal, cssThemed), inkFill = fillAttr("ink", pal, cssThemed);

    function drawWedge(sx, sy, ex, ey, nx, ny) {
      elems.push('<polygon points="' + sx.toFixed(2) + "," + sy.toFixed(2) + " " + (ex + nx * wedgeHalf).toFixed(2) + "," + (ey + ny * wedgeHalf).toFixed(2) + " " + (ex - nx * wedgeHalf).toFixed(2) + "," + (ey - ny * wedgeHalf).toFixed(2) + '" ' + inkFill + "/>");
    }

    function drawHash(sx, sy, dx, dy, blen, nx, ny) {
      var nHash = Math.max(4, Math.min(8, Math.round(blen / hashStep)));
      for (var s = 1; s <= nHash; s++) {
        var frac = (s - 0.5) / nHash, mx = sx + dx * frac, my = sy + dy * frac, hw = sw * 0.45 + (wedgeHalf - sw * 0.45) * frac;
        elems.push('<line x1="' + (mx + nx * hw).toFixed(2) + '" y1="' + (my + ny * hw).toFixed(2) + '" x2="' + (mx - nx * hw).toFixed(2) + '" y2="' + (my - ny * hw).toFixed(2) + '" ' + inkStroke + ' stroke-width="' + sw + '" stroke-linecap="round"/>');
      }
    }

    function clipBond(u, v) {
      var c1 = clipEndpoint(pts[u].x, pts[u].y, pts[v].x, pts[v].y, boxes[u]);
      var c2 = clipEndpoint(pts[v].x, pts[v].y, pts[u].x, pts[u].y, boxes[v]);
      var sx = c1[0], sy = c1[1], ex = c2[0], ey = c2[1], dx = ex - sx, dy = ey - sy, blen = Math.hypot(dx, dy);
      if (blen < 1 || dx * (pts[v].x - pts[u].x) + dy * (pts[v].y - pts[u].y) <= 0) return null;
      var ux = dx / blen, uy = dy / blen;
      return { sx: sx, sy: sy, ex: ex, ey: ey, dx: dx, dy: dy, blen: blen, nx: -uy, ny: ux };
    }

    function drawSingleStereo(u, v, stereo) {
      var cb = clipBond(u, v);
      if (!cb) return;
      if (stereo === "up") drawWedge(cb.sx, cb.sy, cb.ex, cb.ey, cb.nx, cb.ny);
      else if (stereo === "down") drawHash(cb.sx, cb.sy, cb.dx, cb.dy, cb.blen, cb.nx, cb.ny);
      else elems.push('<line x1="' + cb.sx.toFixed(2) + '" y1="' + cb.sy.toFixed(2) + '" x2="' + cb.ex.toFixed(2) + '" y2="' + cb.ey.toFixed(2) + '" ' + inkStroke + ' stroke-width="' + sw + '" stroke-linecap="round"/>');
    }

    for (var b = 0; b < dmol.getAllBonds(); b++) {
      var u = dmol.getBondAtom(0, b), v = dmol.getBondAtom(1, b), bt = dmol.getBondType(b), ord = dmol.getBondOrder(b);
      var bKey = u < v ? u + ":" + v : v + ":" + u;
      var octInfo = layout.bondStereo && layout.bondStereo[bKey];
      if (octInfo) {
        drawSingleStereo(octInfo.metal, octInfo.anchor, octInfo.stereo);
        continue;
      }
      if (bt === B_DAT) { bt = 0; ord = 1; }
      var cb = clipBond(u, v);
      if (!cb) continue;
      var sx = cb.sx, sy = cb.sy, ex = cb.ex, ey = cb.ey, dx = cb.dx, dy = cb.dy, blen = cb.blen, nx = cb.nx, ny = cb.ny;

      if (bt === B_UP) {
        drawWedge(sx, sy, ex, ey, nx, ny);
      } else if (bt === B_DOWN) {
        drawHash(sx, sy, dx, dy, blen, nx, ny);
      } else if (bt === B_CROSS) {
        var dpath = "M" + sx.toFixed(2) + " " + sy.toFixed(2);
        for (var s = 1; s <= 6; s++) {
          var f2 = s / 6, amp = (s % 2 ? 1 : -1) * (wedgeHalf * 0.72);
          dpath += " L" + (sx + dx * f2 + nx * amp).toFixed(2) + " " + (sy + dy * f2 + ny * amp).toFixed(2);
        }
        elems.push('<path d="' + dpath + '" fill="none" ' + inkStroke + ' stroke-width="' + sw + '" stroke-linecap="round" stroke-linejoin="round"/>');
      } else if (ord === 1) {
        elems.push('<line x1="' + sx.toFixed(2) + '" y1="' + sy.toFixed(2) + '" x2="' + ex.toFixed(2) + '" y2="' + ey.toFixed(2) + '" ' + inkStroke + ' stroke-width="' + sw + '" stroke-linecap="round"/>');
      } else if (ord === 2) {
        var side = doubleBondSide(dmol, adj, pts, b, u, v);
        if (side === 0) {
          elems.push('<line x1="' + (sx + nx * off0).toFixed(2) + '" y1="' + (sy + ny * off0).toFixed(2) + '" x2="' + (ex + nx * off0).toFixed(2) + '" y2="' + (ey + ny * off0).toFixed(2) + '" ' + inkStroke + ' stroke-width="' + sw + '" stroke-linecap="round"/>');
          elems.push('<line x1="' + (sx - nx * off0).toFixed(2) + '" y1="' + (sy - ny * off0).toFixed(2) + '" x2="' + (ex - nx * off0).toFixed(2) + '" y2="' + (ey - ny * off0).toFixed(2) + '" ' + inkStroke + ' stroke-width="' + sw + '" stroke-linecap="round"/>');
        } else {
          var offS = off * side, tr1 = boxes[u] ? 0 : 0.14, tr2 = boxes[v] ? 0 : 0.14;
          elems.push('<line x1="' + sx.toFixed(2) + '" y1="' + sy.toFixed(2) + '" x2="' + ex.toFixed(2) + '" y2="' + ey.toFixed(2) + '" ' + inkStroke + ' stroke-width="' + sw + '" stroke-linecap="round"/>');
          elems.push('<line x1="' + (sx + dx * tr1 + nx * offS).toFixed(2) + '" y1="' + (sy + dy * tr1 + ny * offS).toFixed(2) + '" x2="' + (ex - dx * tr2 + nx * offS).toFixed(2) + '" y2="' + (ey - dy * tr2 + ny * offS).toFixed(2) + '" ' + inkStroke + ' stroke-width="' + sw + '" stroke-linecap="round"/>');
        }
      } else if (ord === 3) {
        var sA = sx + dx * 0.08, eA = ex - dx * 0.08, yA = sy + dy * 0.08, yB = ey - dy * 0.08;
        elems.push('<line x1="' + sx.toFixed(2) + '" y1="' + sy.toFixed(2) + '" x2="' + ex.toFixed(2) + '" y2="' + ey.toFixed(2) + '" ' + inkStroke + ' stroke-width="' + sw + '" stroke-linecap="round"/>');
        elems.push('<line x1="' + (sA + nx * off3).toFixed(2) + '" y1="' + (yA + ny * off3).toFixed(2) + '" x2="' + (eA + nx * off3).toFixed(2) + '" y2="' + (yB + ny * off3).toFixed(2) + '" ' + inkStroke + ' stroke-width="' + sw + '" stroke-linecap="round"/>');
        elems.push('<line x1="' + (sA - nx * off3).toFixed(2) + '" y1="' + (yA - ny * off3).toFixed(2) + '" x2="' + (eA - nx * off3).toFixed(2) + '" y2="' + (yB - ny * off3).toFixed(2) + '" ' + inkStroke + ' stroke-width="' + sw + '" stroke-linecap="round"/>');
      }
    }

    if (layout.virtualCoords) {
      layout.virtualCoords.forEach(function (vc) {
        var vKey = vc.from < vc.to ? vc.from + ":" + vc.to : vc.to + ":" + vc.from;
        var octV = layout.bondStereo && layout.bondStereo[vKey];
        drawSingleStereo(octV ? octV.metal : vc.to, octV ? octV.anchor : vc.from, octV ? octV.stereo : "plain");
      });
    }

    for (a = 0; a < n; a++) {
      info = labels[a];
      if (!info) continue;
      var ty = pts[a].y + fontSize * 0.35;
      var tyStr = ty.toFixed(2), subY = (ty + fontSize * 0.21).toFixed(2), supY = (ty - fontSize * 0.33).toFixed(2);
      if (info.abbr) {
        var gAttr = roleColorAttr(info.abbr.role, pal, cssThemed, mono);
        elems.push('<text x="' + info.abbr.txStart.toFixed(2) + '" y="' + tyStr + '" font-family="' + cd.fontFamily + '" font-size="' + fontSize + '" font-weight="' + cd.fontWeight + '" ' + gAttr + ">" + renderSegsHtml(info.abbr.segs, tyStr, subY) + "</text>");
        continue;
      }
      var cs = colorSpec(dmol, a, pal, cssThemed, mono), fw = isMetal(dmol, a) ? cd.metalWeight : cd.fontWeight;
      var hSvg = info.impH > 0 ? "H" + (info.impH > 1 ? '<tspan y="' + subY + '" font-size="72%">' + info.impH + "</tspan>" : "") : "";
      var cSvg = info.chgStr ? '<tspan y="' + supY + '" font-size="70%">' + esc(info.chgStr) + "</tspan>" : "";
      var hW2 = info.impH > 0 ? (info.impH > 1 ? 11.5 : 7.8) * fScale : 0, cW2 = info.chgStr ? info.chgStr.length * 4.8 * fScale : 0;
      var textX = (info.hLeft && hSvg) ? pts[a].x - (hW2 - cW2) / 2 : pts[a].x + (hW2 + cW2) / 2;
      var symHtml = (info.hLeft && info.impH > 1) ? '<tspan y="' + tyStr + '">' + esc(info.sym) + "</tspan>" : esc(info.sym);
      var body = (info.hLeft && hSvg) ? hSvg + symHtml + cSvg : esc(info.sym) + hSvg + cSvg;
      elems.push('<text x="' + textX.toFixed(2) + '" y="' + tyStr + '" text-anchor="middle" font-family="' + cd.fontFamily + '" font-size="' + fontSize + '" font-weight="' + fw + '" ' + cs.attr + ">" + body + "</text>");
    }

    var w = opts.width || 290, h = opts.height || 180;
    var inner = elems.join("");
    var svg = '<svg class="chem-svg" xmlns="http://www.w3.org/2000/svg" viewBox="' + minX.toFixed(1) + " " + minY.toFixed(1) + " " + vbW.toFixed(1) + " " + vbH.toFixed(1) + '" width="' + w + '" height="' + h + '" preserveAspectRatio="xMidYMid meet">' + inner + "</svg>";
    return { svg: svg, inner: inner, viewBox: [minX, minY, vbW, vbH] };
  };

  /* ---------- Slide / Paper Molecule Card SVG Generator ---------- */
  function formulaTspans(formulaStr, baseY) {
    if (!formulaStr) return "";
    var s = String(formulaStr), out = "", i = 0;
    var m = s.match(/^(.*?)([+\-]\d*)$/);
    var body = m ? m[1] : s, chg = m ? m[2] : "";
    while (i < body.length) {
      if (body.charAt(i) >= "0" && body.charAt(i) <= "9") {
        var j = i + 1;
        while (j < body.length && body.charAt(j) >= "0" && body.charAt(j) <= "9") j++;
        out += '<tspan y="' + (baseY + 2.8).toFixed(1) + '" font-size="76%">' + esc(body.slice(i, j)) + "</tspan>";
        i = j;
        if (i < body.length) {
          var k = i;
          while (k < body.length && (body.charAt(k) < "0" || body.charAt(k) > "9")) k++;
          out += '<tspan y="' + baseY + '">' + esc(body.slice(i, k)) + "</tspan>";
          i = k;
        }
      } else {
        var k0 = i;
        while (k0 < body.length && (body.charAt(k0) < "0" || body.charAt(k0) > "9")) k0++;
        out += esc(body.slice(i, k0));
        i = k0;
      }
    }
    if (chg) out += '<tspan y="' + (baseY - 4).toFixed(1) + '" font-size="76%">' + esc(chg) + "</tspan>";
    return out;
  }

  function wrapLines(text, maxChars, maxLines) {
    var s = String(text || "").trim(), lines = [];
    while (s && lines.length < maxLines) {
      if (s.length <= maxChars) { lines.push(s); s = ""; break; }
      if (lines.length === maxLines - 1) {
        var cut = s.slice(0, maxChars - 1).replace(/[,;:\s]+$/, "");
        lines.push(cut + "…");
        s = "";
        break;
      }
      var brk = -1;
      for (var i = maxChars; i >= Math.floor(maxChars * 0.45); i--) {
        var ch = s.charAt(i - 1), prev = i >= 2 ? s.charAt(i - 2) : "";
        if ((ch === " " && prev !== ",") || ch === ")" || ch === "]" || ch === "-") { brk = i; break; }
      }
      if (brk < 0) brk = maxChars;
      lines.push(s.slice(0, brk).trimEnd());
      s = s.slice(brk).trimStart();
    }
    return lines;
  }

  Ent.renderMoleculeCardSVG = function (card, opts) {
    opts = opts || {};
    var dark = opts.theme === "dark";
    var m = Ent.molOf ? Ent.molOf(card.smiles) : null;
    if (!m && window.OCL && card.smiles) { try { m = OCL.Molecule.fromSmiles(card.smiles); } catch (e) { m = null; } }
    var st = m ? Ent.renderStructure(m, { theme: dark ? "dark" : "light", bondPx: 28, cssThemed: false, mono: !!opts.mono }) : null;

    var W = 860, H = 460;
    var th = dark ? {
      bg: "#0f1e16", border: "#2a4a38", card: "#15261c", cardLine: "#274333",
      fg: "#e4f2e9", muted: "#9dbba8", accent: "#5fd39a", accentSoft: "#1b3a2a", accentFg: "#0b1f14",
      calc: "#b9a3ea", calcSoft: "#2a2342", track: "#213a2c", divider: "#243e2f", brandEn: "#5fd39a",
      cylBody: "#22A06B", cylTop: "#5FD39A", cylStroke: "#0b1f14", ray: "#FFB020"
    } : {
      bg: "#f2faf5", border: "#c3dfd0", card: "#ffffff", cardLine: "#cfe5d7",
      fg: "#12301f", muted: "#3f5e4c", accent: "#146c43", accentSoft: "#ddf2e5", accentFg: "#ffffff",
      calc: "#5a3f96", calcSoft: "#ebe5f6", track: "#e0efe5", divider: "#e3efe7", brandEn: "#22a06b",
      cylBody: "#22A06B", cylTop: "#5FD39A", cylStroke: "#12301F", ray: "#FFB020"
    };

    var commName = card.commercial_name ? String(card.commercial_name).trim() : "";
    var iupacName = card.name ? String(card.name).trim() : "";
    var rawName = commName || iupacName || "(unnamed)";
    var titleSize = rawName.length > 95 ? 16 : rawName.length > 65 ? 18 : 20;
    var maxTitleChars = titleSize === 16 ? 82 : titleSize === 18 ? 72 : 64;
    var lines = wrapLines(rawName, maxTitleChars, 2);
    var has2Lines = lines.length > 1;
    var subLine = (commName && iupacName && commName.toLowerCase() !== iupacName.toLowerCase()) ? wrapLines(iupacName, 102, 1)[0] : "";
    var boxY = (has2Lines || subLine) ? 116 : 104, boxH = 292;
    var boxX = 34, boxW = 424;

    var structSvg = "";
    if (st) {
      var vb = st.viewBox, scale = Math.min((boxW - 28) / vb[2], (boxH - 28) / vb[3]);
      var tx = boxX + (boxW - vb[2] * scale) / 2 - vb[0] * scale;
      var ty = boxY + (boxH - vb[3] * scale) / 2 - vb[1] * scale;
      structSvg = '<g transform="translate(' + tx.toFixed(2) + "," + ty.toFixed(2) + ") scale(" + scale.toFixed(4) + ')">' + st.inner + "</g>";
    } else {
      structSvg = '<text x="' + (boxX + boxW / 2) + '" y="' + (boxY + boxH / 2) + '" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="14" fill="' + th.muted + '">Structure unavailable</text>';
    }

    var roleTxt = card.role === "donor" ? "DONOR" : card.role === "both" ? "DONOR & ACCEPTOR" : "ACCEPTOR";
    var roleW = Math.max(82, roleTxt.length * 7.6 + 24);
    var vals = Array.isArray(card.values) && card.values.length ? card.values : [{ et_kcal: card.et_kcal, origin: card.origin, et_unc: card.et_unc }];
    var origins = {}; vals.forEach(function (v) { origins[v.origin === "calc" ? "calc" : "exp"] = 1; });
    var origTxt = (origins.exp && origins.calc) ? "EXP & COMPUTED" : origins.calc ? "COMPUTED" : "EXPERIMENTAL";
    var origX = 34 + roleW + 8, origW = Math.max(98, origTxt.length * 7.4 + 24);
    var origBg = (origins.calc && !origins.exp) ? th.calcSoft : th.accentSoft;
    var origFg = (origins.calc && !origins.exp) ? th.calc : th.accent;
    var clsChip = "";
    if (card.cls) {
      var cx0 = origX + origW + 8, clsRaw = String(card.cls), avail = (W - 150) - cx0;
      var maxC = Math.max(12, Math.floor((avail - 24) / 7.1));
      var clsTxt = clsRaw.length > maxC ? clsRaw.slice(0, maxC - 1).trimEnd() + "…" : clsRaw;
      var clsW = Math.min(avail, Math.max(70, clsTxt.length * 7.1 + 24));
      if (avail >= 70) {
        clsChip = '<rect x="' + cx0 + '" y="26" width="' + clsW + '" height="24" rx="12" fill="' + th.track + '"/>' +
          '<text x="' + (cx0 + clsW / 2) + '" y="42" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="11" font-weight="600" fill="' + th.muted + '">' + esc(clsTxt) + "</text>";
      }
    }

    var nums = vals.map(function (v) { return Number(v.et_kcal); }).filter(isFinite);
    var etStr = "—", altStr = "";
    if (nums.length === 1) {
      etStr = nums[0].toFixed(1) + (vals[0].et_unc ? " ± " + vals[0].et_unc : "");
      altStr = Math.round(nums[0] * 4.184) + " kJ/mol · " + (nums[0] / 23.0605).toFixed(2) + " eV";
    } else if (nums.length > 1) {
      var lo = Math.min.apply(null, nums), hi = Math.max.apply(null, nums);
      etStr = lo === hi ? lo.toFixed(1) : lo.toFixed(1) + "–" + hi.toFixed(1);
      altStr = nums.length + " reported values · " + Math.round(lo * 4.184) + (lo === hi ? "" : "–" + Math.round(hi * 4.184)) + " kJ/mol";
    }

    var sx0 = 498, sxW = 304, sy = boxY + 174;
    function pct(v) { return sx0 + Math.max(0, Math.min(1, (v - 40) / 40)) * sxW; }
    var refs = [{ l: "Ru", v: 46.5 }, { l: "Ir", v: 55.2 }, { l: "TX", v: 63.3 }, { l: "BP", v: 68.0 }];
    var refMarks = refs.map(function (r) {
      var px = pct(r.v);
      return '<line x1="' + px + '" y1="' + (sy - 5) + '" x2="' + px + '" y2="' + (sy + 11) + '" stroke="' + th.muted + '" stroke-width="1.2"/>' +
        '<text x="' + px + '" y="' + (sy + 25) + '" text-anchor="middle" font-family="IBM Plex Mono,ui-monospace,monospace" font-size="11" fill="' + th.muted + '">' + r.l + "</text>";
    }).join("");
    var valMarks = vals.map(function (v) {
      var x = Number(v.et_kcal); if (!isFinite(x)) return "";
      var px = pct(x), unc = "";
      if (v.et_unc) {
        var u0 = pct(x - Number(v.et_unc)), u1 = pct(x + Number(v.et_unc));
        unc = '<rect x="' + u0 + '" y="' + sy + '" width="' + Math.max(3, u1 - u0) + '" height="6" rx="3" fill="' + (v.origin === "calc" ? th.calc : th.accent) + '" opacity="0.28"/>';
      }
      /* the same legend as the cards: filled green experimental, hollow purple computed */
      var mark = v.origin === "calc"
        ? '<rect x="' + (px - 4) + '" y="' + (sy - 8) + '" width="8" height="22" rx="3" fill="' + th.card + '" stroke="' + th.calc + '" stroke-width="2.4"/>'
        : '<rect x="' + (px - 3) + '" y="' + (sy - 8) + '" width="6" height="22" rx="3" fill="' + th.accent + '"/>';
      return unc + mark;
    }).join("");

    var fmlY = boxY + 240;
    var formulaParts = String(card.formula || "").split(" · ");
    var fmlXml = formulaParts[0] ? formulaTspans(formulaParts[0], fmlY) + (formulaParts[1] ? '<tspan y="' + fmlY + '"> · ' + esc(formulaParts[1]) + "</tspan>" : "") : "";
    var methodTxt = card.method ? wrapLines(card.method + (card.conditions ? " · " + card.conditions : ""), 44, 1)[0] : "";
    var citeTxt = card.citation ? wrapLines(card.citation, 84, 1)[0] : "";

    var logoMark = '<g transform="translate(744,23) scale(0.14)">' +
      '<path d="M84 52 V20 M76 29 L84 19 L92 29 M116 52 V20 M108 29 L116 19 L124 29" fill="none" stroke="' + th.ray + '" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M50 62 V150 a50 16 0 0 0 100 0 V62" fill="' + th.cylBody + '" stroke="' + th.cylStroke + '" stroke-width="7"/>' +
      '<ellipse cx="100" cy="62" rx="50" ry="16" fill="' + th.cylTop + '" stroke="' + th.cylStroke + '" stroke-width="7"/>' +
      "</g>";

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '">' +
      '<rect x="0" y="0" width="' + W + '" height="' + H + '" rx="18" fill="' + th.bg + '"/>' +
      '<rect x="1.5" y="1.5" width="' + (W - 3) + '" height="' + (H - 3) + '" rx="17" fill="none" stroke="' + th.border + '" stroke-width="2"/>' +
      '<rect x="34" y="26" width="' + roleW + '" height="24" rx="12" fill="' + th.accent + '"/>' +
      '<text x="' + (34 + roleW / 2) + '" y="42" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="11" font-weight="700" fill="' + th.accentFg + '" letter-spacing="0.5">' + esc(roleTxt) + "</text>" +
      '<rect x="' + origX + '" y="26" width="' + origW + '" height="24" rx="12" fill="' + origBg + '"/>' +
      '<text x="' + (origX + origW / 2) + '" y="42" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="11" font-weight="700" fill="' + origFg + '" letter-spacing="0.4">' + esc(origTxt) + "</text>" +
      clsChip +
      logoMark +
      '<text x="772" y="43" font-family="Fredoka,Inter,system-ui,sans-serif" font-size="17" font-weight="700" fill="' + th.fg + '">Tr<tspan fill="' + th.brandEn + '">En</tspan>DB</text>' +
      '<text x="34" y="77" font-family="Fredoka,Inter,system-ui,sans-serif" font-size="' + titleSize + '" font-weight="600" fill="' + th.fg + '">' + esc(lines[0]) + "</text>" +
      (has2Lines ? '<text x="34" y="99" font-family="Fredoka,Inter,system-ui,sans-serif" font-size="' + titleSize + '" font-weight="600" fill="' + th.fg + '">' + esc(lines[1]) + "</text>" : "") +
      (subLine ? '<text x="34" y="' + (has2Lines ? 111 : 95) + '" font-family="Inter,system-ui,sans-serif" font-size="10.5" fill="' + th.muted + '">' + esc(subLine) + "</text>" : "") +
      '<rect x="' + boxX + '" y="' + boxY + '" width="' + boxW + '" height="' + boxH + '" rx="14" fill="' + th.card + '" stroke="' + th.cardLine + '" stroke-width="1.5"/>' +
      structSvg +
      '<rect x="476" y="' + boxY + '" width="350" height="' + boxH + '" rx="14" fill="' + th.card + '" stroke="' + th.cardLine + '" stroke-width="1.5"/>' +
      '<text x="498" y="' + (boxY + 32) + '" font-family="Inter,system-ui,sans-serif" font-size="11.5" font-weight="700" letter-spacing="0.8" fill="' + th.muted + '">TRIPLET ENERGY (E<tspan y="' + (boxY + 34.8) + '" font-size="75%">T</tspan><tspan y="' + (boxY + 32) + '">)</tspan></text>' +
      '<text x="498" y="' + (boxY + 88) + '" font-family="Fredoka,Inter,system-ui,sans-serif" font-size="' + (etStr.length > 8 ? 38 : 46) + '" font-weight="700" fill="' + th.fg + '">' + esc(etStr) + ' <tspan font-size="18" font-weight="500" fill="' + th.muted + '">kcal/mol</tspan></text>' +
      '<text x="498" y="' + (boxY + 118) + '" font-family="IBM Plex Mono,ui-monospace,monospace" font-size="13.5" fill="' + th.muted + '">' + esc(altStr) + "</text>" +
      '<rect x="' + sx0 + '" y="' + sy + '" width="' + sxW + '" height="6" rx="3" fill="' + th.track + '"/>' +
      refMarks + valMarks +
      '<text x="' + sx0 + '" y="' + (sy + 25) + '" font-family="IBM Plex Mono,ui-monospace,monospace" font-size="11" fill="' + th.muted + '">40</text>' +
      '<text x="' + (sx0 + sxW) + '" y="' + (sy + 25) + '" text-anchor="end" font-family="IBM Plex Mono,ui-monospace,monospace" font-size="11" fill="' + th.muted + '">80</text>' +
      '<line x1="498" y1="' + (boxY + 216) + '" x2="804" y2="' + (boxY + 216) + '" stroke="' + th.divider + '" stroke-width="1"/>' +
      (fmlXml ? '<text x="498" y="' + fmlY + '" font-family="IBM Plex Mono,ui-monospace,monospace" font-size="12.5" fill="' + th.fg + '">' + fmlXml + "</text>" : "") +
      (card.cas ? '<text x="498" y="' + (boxY + 261) + '" font-family="IBM Plex Mono,ui-monospace,monospace" font-size="12" fill="' + th.muted + '">CAS ' + esc(card.cas) + "</text>" : "") +
      (methodTxt ? '<text x="498" y="' + (boxY + (card.cas ? 280 : 263)) + '" font-family="Inter,system-ui,sans-serif" font-size="11.5" fill="' + th.muted + '">' + esc(methodTxt) + "</text>" : "") +
      '<text x="34" y="436" font-family="Inter,system-ui,sans-serif" font-size="12" fill="' + th.muted + '">' + esc(citeTxt) + "</text>" +
      (card.doi ? '<text x="' + (W - 34) + '" y="436" text-anchor="end" font-family="IBM Plex Mono,ui-monospace,monospace" font-size="12" fill="' + th.accent + '">doi:' + esc(card.doi) + "</text>" : "") +
      "</svg>";
  };

  /* ---------- Interactive Molecule Card Graphic Modal ---------- */
  function svgToPngDataUrl(svgText, w, h) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var blob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      img.onload = function () {
        try {
          var scale = 2;
          var canvas = document.createElement("canvas");
          canvas.width = w * scale; canvas.height = h * scale;
          var ctx = canvas.getContext("2d");
          ctx.scale(scale, scale);
          ctx.drawImage(img, 0, 0, w, h);
          URL.revokeObjectURL(url);
          resolve(canvas.toDataURL("image/png"));
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = function (e) { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }

  Ent.cardGraphic = {
    open: function (card) {
      if (!Ent.dialog) return;
      var rootTheme = document.documentElement.getAttribute("data-theme");
      var sysDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      var theme = rootTheme === "dark" ? "dark" : rootTheme === "light" ? "light" : (sysDark ? "dark" : "light");
      var mono = false;

      Ent.dialog("Molecule card graphic", function (box) {
        box.classList.add("ed-box", "gfx-box");
        var head = box.querySelector("h2");
        var bar = Ent.el("div", "ed-head"), acts = Ent.el("div", "ed-head-actions");
        function monoLabel() { return mono ? (theme === "dark" ? "Atoms: Mono" : "Atoms: Black") : "Atoms: Colored"; }
        var aBtn = Ent.el("button", "btn small", monoLabel()); aBtn.type = "button";
        aBtn.title = "Toggle colored atom labels vs all-black monochrome labels";
        var tBtn = Ent.el("button", "btn small", theme === "dark" ? "Paper: Dark" : "Paper: Light"); tBtn.type = "button";
        var xBtn = Ent.el("button", "btn small", "Close"); xBtn.type = "button";
        acts.appendChild(aBtn); acts.appendChild(tBtn); acts.appendChild(xBtn);
        bar.appendChild(head); bar.appendChild(acts);

        var body = Ent.el("div", "gfx-body"), stage = Ent.el("div", "gfx-stage");
        var hint = Ent.el("p", "hint", "Right-click or drag the graphic to copy or save it for slides and papers.");
        body.appendChild(stage); body.appendChild(hint);
        box.replaceChildren(bar, body);

        function paint() {
          var svg = Ent.renderMoleculeCardSVG(card, { theme: theme, mono: mono });
          svgToPngDataUrl(svg, 860, 460).then(function (pngUrl) {
            var img = Ent.el("img", "gfx-img");
            img.src = pngUrl;
            img.alt = (card.commercial_name || card.name || "Molecule") + " summary card";
            stage.replaceChildren(img);
          }, function () {
            stage.innerHTML = svg;
          });
        }
        aBtn.addEventListener("click", function () {
          mono = !mono;
          aBtn.textContent = monoLabel();
          paint();
        });
        tBtn.addEventListener("click", function () {
          theme = theme === "light" ? "dark" : "light";
          tBtn.textContent = theme === "dark" ? "Paper: Dark" : "Paper: Light";
          aBtn.textContent = monoLabel();
          paint();
        });
        xBtn.addEventListener("click", Ent.closeDialog);
        paint();
      });
    }
  };

  /* ---------- Multi-Molecule Triplet Energy Slide Scale Generator ---------- */
  var SLIDE_THEMES = {
    classic: {
      bg: "#ffffff", border: "none", axis: "#111827", tickText: "#111827",
      topLine: "#1e3a8a", botLine: "#2d6a6d", label: "#111827", val: "#52525b",
      unit: "#111827", structFill: "#ffffff", structStroke: "#e2e8f0", structTheme: "light"
    },
    trendb: {
      bg: "#f2faf5", border: "#c3dfd0", axis: "#12301f", tickText: "#12301f",
      topLine: "#146c43", botLine: "#2563eb", label: "#12301f", val: "#3f5e4c",
      unit: "#12301f", structFill: "#ffffff", structStroke: "#cfe5d7", structTheme: "light"
    },
    dark: {
      bg: "#0f1e16", border: "#2a4a38", axis: "#e4f2e9", tickText: "#c6ddd0",
      topLine: "#5fd39a", botLine: "#60a5fa", label: "#e4f2e9", val: "#9dbba8",
      unit: "#c6ddd0", structFill: "#15261c", structStroke: "#274333", structTheme: "dark"
    }
  };

  var SLIDE_ABBREV = {
    "fac-tris[2-(pyridin-2-yl)phenyl-κ²c¹,n]iridium(iii)": "fac-Ir(ppy)3",
    "fac-tris[3,5-difluoro-2-(pyridin-2-yl)phenyl-κ²c¹,n]iridium(iii)": "fac-Ir(dFppy)3",
    "(4,4′-di-tert-butyl-2,2′-bipyridine-κ²n,n′)bis[3,5-difluoro-2-[5-(trifluoromethyl)pyridin-2-yl]phenyl-κ²c¹,n]iridium(iii)": "[Ir(dF(CF3)ppy)2(dtbbpy)]+",
    "(4,4′-di-tert-butyl-2,2′-bipyridine-κ²n,n′)bis[3,5-difluoro-2-(5-methylpyridin-2-yl)phenyl-κ²c¹,n]iridium(iii)": "[Ir(dF(Me)ppy)2(dtbbpy)]+",
    "dicyanidobis[2-[4-(dimethylamino)pyridin-2-yl]-3,5-difluorophenyl-κ²c¹,n]iridate(iii)": "[Ir(dF-NMe2-ppy)2(CN)2]-",
    "bis[2-[4-(dimethylamino)pyridin-2-yl]-3,5-difluorophenyl-κ²c¹,n]bis[(cyano-κc)tris(pentafluorophenyl)borato]iridate(iii)": "[Ir(dF-NMe2-ppy)2(CN-BCF)2]-",
    "tris(2,2′-bipyridine-κ²n,n′)ruthenium(ii)": "[Ru(bpy)3]2+",
    "2,4,5,6-tetrakis(9h-carbazol-9-yl)benzene-1,3-dicarbonitrile": "4CzIPN",
    "thioxanthen-9-one": "Thioxanthone",
    "xanthen-9-one": "Xanthone",
    "9h-fluoren-9-one": "9-Fluorenone",
    "(e)-1,2-diphenylethene": "(E)-stilbene",
    "(z)-1,2-diphenylethene": "(Z)-stilbene"
  };

  Ent.slideDefaultLabel = function (name) {
    var raw = String(name || "(unnamed)").trim();
    var hit = SLIDE_ABBREV[raw.toLowerCase()];
    if (hit) return hit;
    var s = raw.replace(/^([a-z])/, function (_, c) { return c.toUpperCase(); });
    return s.length > 36 ? s.slice(0, 34).trimEnd() + "…" : s;
  };

  function slideLabelTspans(label, baseY) {
    var s = String(label || ""), chgMatch = s.match(/^(.*?[A-Za-z)\]])(\d*[+\-])$/);
    var body = chgMatch ? chgMatch[1] : s, chg = chgMatch ? chgMatch[2] : "";
    var out = "", needReset = false, i = 0;
    function emit(txt) {
      if (!txt) return;
      if (needReset) { out += '<tspan y="' + baseY + '">' + txt + "</tspan>"; needReset = false; }
      else out += txt;
    }
    while (i < body.length) {
      if ((body.slice(i, i + 3) === "(E)" || body.slice(i, i + 3) === "(Z)") && (i === 0 || /[\s,\-]/.test(body.charAt(i - 1)))) {
        emit('(<tspan font-style="italic">' + body.charAt(i + 1) + "</tspan>)");
        i += 3;
        continue;
      }
      var ch = body.charAt(i), prev = i > 0 ? body.charAt(i - 1) : "";
      if (ch >= "0" && ch <= "9" && /[A-Za-z)\]]/.test(prev)) {
        var j = i + 1;
        while (j < body.length && body.charAt(j) >= "0" && body.charAt(j) <= "9") j++;
        out += '<tspan y="' + (baseY + 2.6).toFixed(1) + '" font-size="74%">' + esc(body.slice(i, j)) + "</tspan>";
        needReset = true;
        i = j;
        continue;
      }
      var k = i + 1;
      while (k < body.length && !(body.charAt(k) >= "0" && body.charAt(k) <= "9" && /[A-Za-z)\]]/.test(body.charAt(k - 1))) && body.slice(k, k + 3) !== "(E)" && body.slice(k, k + 3) !== "(Z)") k++;
      emit(esc(body.slice(i, k)));
      i = k;
    }
    if (chg) out += '<tspan y="' + (baseY - 4.0).toFixed(1) + '" font-size="74%">' + esc(chg) + "</tspan>";
    return out;
  }

  function estimateSlideTextW(text, fontSize) {
    return Math.max(50, String(text || "").length * (fontSize * 0.62) + 12);
  }

  function slideUnitSpec(unit, rawVals) {
    var k = unit === "kcal" ? 1 : unit === "ev" ? 1 / 23.0605 : 4.184;
    var suf = unit === "kcal" ? "kcal/mol" : unit === "ev" ? "eV" : "kJ/mol";
    var axisTag = "[" + suf + "]";
    function conv(kcal) { return kcal * k; }
    function fmtVal(kcal) {
      var v = conv(kcal);
      return unit === "kcal" ? v.toFixed(1) : unit === "ev" ? v.toFixed(2) : String(Math.round(v));
    }
    var nums = rawVals.map(conv).filter(isFinite);
    var lo = nums.length ? Math.min.apply(null, nums) : conv(45);
    var hi = nums.length ? Math.max.apply(null, nums) : conv(72);
    var span = Math.max(unit === "ev" ? 0.4 : unit === "kcal" ? 8 : 30, hi - lo);
    var pad = span * 0.08;
    var stepCands = unit === "ev" ? [0.1, 0.2, 0.25, 0.5] : unit === "kcal" ? [2, 5, 10, 15] : [10, 20, 25, 50, 100];
    var step = stepCands[stepCands.length - 1];
    for (var i = 0; i < stepCands.length; i++) {
      if ((span + 2 * pad) / stepCands[i] <= 6) { step = stepCands[i]; break; }
    }
    var minTick = Math.floor((lo - pad * 0.4) / step) * step;
    var maxTick = Math.ceil((hi + pad * 0.4) / step) * step;
    if (maxTick - hi > 0.65 * step && maxTick - step >= lo) maxTick -= step;
    var ticks = [];
    for (var v = minTick; v <= maxTick + step * 1e-6; v += step) {
      ticks.push({ val: v, label: unit === "ev" ? v.toFixed(2).replace(/0$/, "") : String(Math.round(v * 100) / 100) });
    }
    var axisMin = Math.min(minTick - step * 0.16, lo - pad);
    var axisMax = Math.max(maxTick + step * 0.16, hi + pad);
    return { conv: conv, fmtVal: fmtVal, suf: suf, axisTag: axisTag, min: axisMin, max: axisMax, ticks: ticks };
  }

  function layoutSlideSide(sideItems, side, xLeft, xRight, opts) {
    if (!sideItems.length) return { placed: [], depth: side === "top" ? 54 : 58 };
    var showStructs = !!opts.showStructs, elbow = 16;
    var sBoxW = 152, sBoxH = 92;
    var tierH = showStructs ? 142 : 40, tierGap = 12, tierStep = tierH + tierGap;
    var baseOffset = side === "top" ? 24 : 36;
    var placed = [];

    function overlaps(ax0, ay0, ax1, ay1, bx0, by0, bx1, by1, px, py) {
      return ax0 - px < bx1 && ax1 + px > bx0 && ay0 - py < by1 && ay1 + py > by0;
    }

    sideItems.sort(function (a, b) { return a.stemX - b.stemX || a.order - b.order; });
    function makePlacement(it, t, mode, bx0, bx1, by0, by1, boxW, boxH, elbowX, textX) {
      var sBoxX = showStructs ? (mode === "center" ? bx0 + boxW / 2 - sBoxW / 2 : (mode === "left" ? bx1 - sBoxW : bx0)) : 0;
      var centerClamped = showStructs && mode === "center" && (it.stemX < sBoxX + 1 || it.stemX > sBoxX + sBoxW - 1);
      var effElbowX = centerClamped ? (it.stemX < sBoxX ? sBoxX : sBoxX + sBoxW) : elbowX;
      var sMidY = side === "top" ? by0 + 40 + sBoxH / 2 : by0 + 2 + sBoxH / 2;
      var stemEndY = effElbowX != null
        ? (showStructs ? sMidY : by0 + 18)
        : (showStructs ? (side === "top" ? by0 + 40 + sBoxH : by0 + 2) : (side === "top" ? by0 + 36 : by0 - 2));
      var textTopY = showStructs ? (side === "top" ? by0 + 14 : by0 + sBoxH + 19) : by0 + 15;
      return {
        item: it, tier: t, mode: mode, stemX: it.stemX, stemEndY: stemEndY, elbowX: effElbowX,
        bx0: bx0, bx1: bx1, by0: by0, by1: by1, boxW: boxW, boxH: boxH,
        textX: textX, textTopY: textTopY
      };
    }

    function tryPlaceAt(it, boxW, boxH, minTier, ignoreIdx) {
      var idx = sideItems.indexOf(it);
      var prevGap = idx > 0 ? it.stemX - sideItems[idx - 1].stemX : 999;
      var nextGap = idx + 1 < sideItems.length ? sideItems[idx + 1].stemX - it.stemX : 999;
      var crowded = prevGap < 48 || nextGap < 48;
      var veryClose = prevGap < 22 || nextGap < 22;
      var sidePref = prevGap > nextGap + 6 ? ["left", "right"] : ["right", "left"];
      var modes = veryClose ? sidePref : crowded ? [sidePref[0], sidePref[1], "center"] : ["center", sidePref[0], sidePref[1]];

      var bestCand = null, bestScore = Infinity;
      for (var t = minTier; t < 18; t++) {
        if (bestCand && (t - minTier) * 2 >= bestScore) break;
        var nearEdge = baseOffset + t * tierStep;
        var by0 = side === "top" ? -(nearEdge + boxH) : nearEdge;
        var by1 = by0 + boxH;
        for (var mi = 0; mi < modes.length; mi++) {
          var mode = modes[mi], bx0, elbowX = null, textX;
          if (mode === "center") {
            bx0 = Math.max(xLeft, Math.min(xRight - boxW, it.stemX - boxW / 2));
            textX = bx0 + 2;
          } else if (mode === "right") {
            bx0 = it.stemX + elbow + 4;
            if (bx0 + boxW > xRight) continue;
            elbowX = it.stemX + elbow; textX = bx0 + 2;
          } else {
            bx0 = it.stemX - elbow - 4 - boxW;
            if (bx0 < xLeft) continue;
            elbowX = it.stemX - elbow; textX = bx0 + 2;
          }
          var bx1 = bx0 + boxW, boxHit = false, stemHits = 0;
          for (var j = 0; j < placed.length; j++) {
            if (j === ignoreIdx) continue;
            var o = placed[j];
            if (overlaps(bx0, by0, bx1, by1, o.bx0, o.by0, o.bx1, o.by1, 10, 6)) { boxHit = true; break; }
            if (o.tier > t && o.stemX >= bx0 - 4 && o.stemX <= bx1 + 4) stemHits++;
            if (o.tier < t && it.stemX >= o.bx0 - 4 && it.stemX <= o.bx1 + 4) stemHits++;
          }
          if (boxHit) continue;
          var futureCross = 0;
          for (var k = 0; k < sideItems.length; k++) {
            if (sideItems[k] !== it && sideItems[k].stemX >= bx0 - 4 && sideItems[k].stemX <= bx1 + 4) futureCross++;
          }
          var score = stemHits * 200 + futureCross * 12 + (t - minTier) * 2 + (mode === "center" ? 0 : 0.4);
          if (score < bestScore) {
            bestScore = score;
            bestCand = makePlacement(it, t, mode, bx0, bx1, by0, by1, boxW, boxH, elbowX, textX);
          }
        }
      }
      return bestCand;
    }

    for (var i = 0; i < sideItems.length; i++) {
      var it = sideItems[i];
      var nameW = estimateSlideTextW(it.label, 14.5), valW = estimateSlideTextW(it.valLine, 12.5);
      var boxW = Math.max(nameW, valW);
      if (showStructs) boxW = Math.max(boxW, sBoxW + 8);
      var c = tryPlaceAt(it, boxW, tierH, 0, -1);
      if (c) placed.push(c);
    }

    function countPierces(list) {
      var hits = 0;
      for (var a = 0; a < list.length; a++) {
        for (var b = 0; b < list.length; b++) {
          if (a !== b && list[b].tier > list[a].tier && list[b].stemX >= list[a].bx0 - 4 && list[b].stemX <= list[a].bx1 + 4) hits++;
        }
      }
      return hits;
    }

    for (var pass = 0; pass < 16; pass++) {
      var changed = false;
      for (i = 0; i < placed.length; i++) {
        var cur = placed[i], pierced = false;
        for (var j = 0; j < placed.length; j++) {
          if (j !== i && placed[j].tier > cur.tier && placed[j].stemX >= cur.bx0 - 4 && placed[j].stemX <= cur.bx1 + 4) {
            pierced = true; break;
          }
        }
        var beforeH = countPierces(placed);
        var alt = tryPlaceAt(cur.item, cur.boxW, cur.boxH, pierced ? cur.tier : 0, i);
        if (alt) {
          placed[i] = alt;
          var afterH = countPierces(placed);
          if (afterH < beforeH || (afterH === beforeH && alt.tier < cur.tier)) changed = true;
          else placed[i] = cur;
        }
      }
      if (!changed) break;
    }

    var maxTier = 0;
    for (i = 0; i < placed.length; i++) if (placed[i].tier > maxTier) maxTier = placed[i].tier;
    var depth = placed.length ? baseOffset + maxTier * tierStep + tierH + 18 : (side === "top" ? 54 : 58);
    return { placed: placed, depth: depth };
  }

  Ent.renderSlideSVG = function (entries, opts) {
    opts = opts || {};
    var unit = opts.unit || "kj", th = SLIDE_THEMES[opts.theme || "classic"] || SLIDE_THEMES.classic;
    var list = (entries || []).filter(function (e) { return e && isFinite(Number(e.et_kcal)); });
    var rawVals = list.map(function (e) { return Number(e.et_kcal); });
    var us = slideUnitSpec(unit, rawVals);

    var W = 1040, xL = 56, xR = W - 56, xSpan = xR - xL;
    function xOf(kcal) {
      var u = us.conv(kcal);
      return xL + Math.max(0, Math.min(1, (u - us.min) / (us.max - us.min || 1))) * xSpan;
    }

    var hasDonor = false, hasAcc = false;
    list.forEach(function (e) { if (e.role === "acceptor") hasAcc = true; else hasDonor = true; });
    var useSplit = opts.layout === "split" || (opts.layout !== "alt" && hasDonor && hasAcc);

    var sortedForAlt = list.map(function (e, idx) {
      return {
        raw: e, order: idx, kcal: Number(e.et_kcal),
        stemX: xOf(Number(e.et_kcal)),
        label: (e.label && String(e.label).trim()) ? String(e.label).trim() : Ent.slideDefaultLabel(e.commercial_name || e.name),
        valLine: us.fmtVal(Number(e.et_kcal)) + (e.et_max && Number(e.et_max) !== Number(e.et_kcal) ? "–" + us.fmtVal(Number(e.et_max)) : "") + " " + us.suf
      };
    });
    if (!useSplit) {
      sortedForAlt.sort(function (a, b) { return a.stemX - b.stemX || a.order - b.order; });
    }

    var topItems = [], botItems = [];
    sortedForAlt.forEach(function (it, idx) {
      var s = it.raw.side;
      if (s !== "top" && s !== "bottom") {
        s = useSplit ? (it.raw.role === "acceptor" ? "bottom" : "top") : (idx % 2 === 0 ? "top" : "bottom");
      }
      if (s === "top") topItems.push(it); else botItems.push(it);
    });

    var topLay = layoutSlideSide(topItems, "top", xL - 12, xR + 12, opts);
    var botLay = layoutSlideSide(botItems, "bottom", xL - 12, xR + 12, opts);
    var titleTxt = opts.title != null ? String(opts.title).trim() : "";
    var topHeadH = titleTxt ? 54 : 18;
    var axisY = topHeadH + topLay.depth;
    var H = Math.max(360, axisY + botLay.depth + 26);

    var elems = [], sBoxW = 152, sBoxH = 92;
    function drawSide(lay, side) {
      var col = side === "top" ? th.topLine : th.botLine;
      lay.placed.forEach(function (c) {
        var sy1 = axisY, sy2 = axisY + c.stemEndY;
        var smi = c.item.raw && c.item.raw.smiles;
        var hasStruct = !!(opts.showStructs && smi && window.OCL);
        var sBoxX = c.mode === "center" ? c.bx0 + c.boxW / 2 - sBoxW / 2 : (c.mode === "left" ? c.bx1 - sBoxW : c.bx0);
        var sBoxY = side === "top" ? axisY + c.by0 + 40 : axisY + c.by0 + 2;
        var lineEndX = c.elbowX != null && hasStruct ? (c.elbowX < sBoxX + sBoxW / 2 ? sBoxX : sBoxX + sBoxW) : c.elbowX;
        elems.push('<line x1="' + c.stemX.toFixed(1) + '" y1="' + sy1.toFixed(1) + '" x2="' + c.stemX.toFixed(1) + '" y2="' + sy2.toFixed(1) + '" stroke="' + col + '" stroke-width="1.5"/>');
        if (lineEndX != null) {
          elems.push('<line x1="' + c.stemX.toFixed(1) + '" y1="' + sy2.toFixed(1) + '" x2="' + lineEndX.toFixed(1) + '" y2="' + sy2.toFixed(1) + '" stroke="' + col + '" stroke-width="1.5"/>');
        }
        var tY = axisY + c.textTopY, vY = tY + 17.5;
        if (hasStruct) {
          elems.push('<rect x="' + sBoxX.toFixed(1) + '" y="' + sBoxY.toFixed(1) + '" width="' + sBoxW + '" height="' + sBoxH + '" rx="9" fill="' + th.structFill + '" stroke="' + th.structStroke + '" stroke-width="1"/>');
          var m = Ent.molOf ? Ent.molOf(smi) : null;
          if (!m) { try { m = OCL.Molecule.fromSmiles(smi); } catch (er) { m = null; } }
          var st = m ? Ent.renderStructure(m, { theme: th.structTheme, bondPx: 20, margin: 4, cssThemed: false, mono: !!opts.mono }) : null;
          if (st) {
            var vb = st.viewBox, sc = Math.min((sBoxW - 10) / vb[2], (sBoxH - 8) / vb[3]);
            var tx = sBoxX + (sBoxW - vb[2] * sc) / 2 - vb[0] * sc, ty = sBoxY + (sBoxH - vb[3] * sc) / 2 - vb[1] * sc;
            elems.push('<g transform="translate(' + tx.toFixed(2) + "," + ty.toFixed(2) + ") scale(" + sc.toFixed(4) + ')">' + st.inner + "</g>");
          }
        }
        /* Always use text-anchor="start" so nested sub/sup/italic tspans never re-center on top of each other */
        var txStart = c.mode === "center" ? Math.max(c.bx0, c.bx0 + (c.boxW - estimateSlideTextW(c.item.label, 14.5)) / 2 + 4) : c.textX;
        var vxStart = c.mode === "center" ? Math.max(c.bx0, c.bx0 + (c.boxW - estimateSlideTextW(c.item.valLine, 12.5)) / 2 + 4) : c.textX;
        elems.push('<text x="' + txStart.toFixed(1) + '" y="' + tY.toFixed(1) + '" font-family="Inter,system-ui,sans-serif" font-size="14.5" font-weight="500" fill="' + th.label + '">' + slideLabelTspans(c.item.label, tY) + "</text>");
        elems.push('<text x="' + vxStart.toFixed(1) + '" y="' + vY.toFixed(1) + '" font-family="Inter,system-ui,sans-serif" font-size="13" fill="' + th.val + '">' + esc(c.item.valLine) + "</text>");
      });
    }
    drawSide(topLay, "top");
    drawSide(botLay, "bottom");

    elems.push('<line x1="' + (xL - 18) + '" y1="' + axisY + '" x2="' + (xR + 18) + '" y2="' + axisY + '" stroke="' + th.axis + '" stroke-width="4.5" stroke-linecap="butt"/>');
    us.ticks.forEach(function (tk) {
      var tx = xL + ((tk.val - us.min) / (us.max - us.min || 1)) * xSpan;
      if (tx < xL - 8 || tx > xR + 8) return;
      elems.push('<line x1="' + tx.toFixed(1) + '" y1="' + (axisY - 10) + '" x2="' + tx.toFixed(1) + '" y2="' + (axisY + 10) + '" stroke="' + th.axis + '" stroke-width="1.6"/>');
      elems.push('<text x="' + tx.toFixed(1) + '" y="' + (axisY + 26) + '" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="13.5" font-weight="500" fill="' + th.tickText + '">' + esc(tk.label) + "</text>");
    });
    elems.push('<text x="' + (xR + 12) + '" y="' + (H - 18) + '" text-anchor="end" font-family="Inter,system-ui,sans-serif" font-size="14" font-weight="600" fill="' + th.unit + '">' + esc(us.axisTag) + "</text>");
    elems.push('<text x="' + xL + '" y="' + (H - 18) + '" font-family="Inter,system-ui,sans-serif" font-size="11.5" fill="' + th.val + '">TrEnDB · Triplet Energy Scale' + (useSplit ? " (top: donors · bottom: acceptors)" : "") + "</text>");

    var headSvg = titleTxt
      ? '<text x="' + xL + '" y="36" font-family="Fredoka,Inter,system-ui,sans-serif" font-size="20" font-weight="600" fill="' + th.label + '">' + esc(titleTxt) + "</text>"
      : "";
    var borderRect = th.border !== "none"
      ? '<rect x="1.5" y="1.5" width="' + (W - 3) + '" height="' + (H - 3) + '" rx="16" fill="none" stroke="' + th.border + '" stroke-width="2"/>'
      : "";

    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '">' +
      '<rect x="0" y="0" width="' + W + '" height="' + H + '" rx="' + (th.border === "none" ? 0 : 16) + '" fill="' + th.bg + '"/>' +
      borderRect + headSvg + elems.join("") + "</svg>";
    return { svg: svg, width: W, height: H };
  };

  Ent.downloadBlob = function (blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename; a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  };

  Ent.slideGraphic = {
    open: function (items, hooks) {
      if (!Ent.dialog || !items || !items.length) return;
      hooks = hooks || {};
      var st = {
        unit: "kj", theme: "classic", layout: "auto", showStructs: false, mono: false, title: "",
        items: items.map(function (it) {
          return Object.assign({}, it, { label: it.label || Ent.slideDefaultLabel(it.commercial_name || it.name), side: it.side || "auto" });
        })
      };

      Ent.dialog("Triplet energy slide", function (box) {
        box.classList.add("ed-box", "gfx-box", "slide-box");
        var head = box.querySelector("h2");
        var bar = Ent.el("div", "ed-head"), acts = Ent.el("div", "ed-head-actions");
        var dlPng = Ent.el("button", "btn small primary", "Download PNG"); dlPng.type = "button";
        var dlSvg = Ent.el("button", "btn small", "Download SVG"); dlSvg.type = "button";
        var xBtn = Ent.el("button", "btn small", "Close"); xBtn.type = "button";
        acts.appendChild(dlPng); acts.appendChild(dlSvg); acts.appendChild(xBtn);
        bar.appendChild(head); bar.appendChild(acts);

        var ctrl = Ent.el("div", "slide-controls");
        function makeSel(lbl, optsArr, val, onChange) {
          var w = Ent.el("label", "inline", lbl + " ");
          var s = Ent.el("select", "compact-select");
          optsArr.forEach(function (o) { s.appendChild(new Option(o[1], o[0])); });
          s.value = val;
          s.addEventListener("change", function () { onChange(s.value); });
          w.appendChild(s); return w;
        }
        var ttlInp = Ent.el("input"); ttlInp.type = "text"; ttlInp.placeholder = "Optional slide title…";
        ttlInp.className = "slide-title-inp"; ttlInp.setAttribute("aria-label", "Optional slide title");
        ttlInp.addEventListener("input", function () { st.title = ttlInp.value; paint(); });

        var strLbl = Ent.el("label", "check"), strChk = Ent.el("input");
        strChk.type = "checkbox"; strChk.addEventListener("change", function () { st.showStructs = strChk.checked; paint(); });
        strLbl.appendChild(strChk); strLbl.appendChild(document.createTextNode("2D structures"));

        ctrl.appendChild(ttlInp);
        ctrl.appendChild(makeSel("Unit", [["kj", "kJ/mol"], ["kcal", "kcal/mol"], ["ev", "eV"]], st.unit, function (v) { st.unit = v; paint(); drawItems(); }));
        ctrl.appendChild(makeSel("Style", [["classic", "Slide White"], ["trendb", "TrEnDB"], ["dark", "Dark"]], st.theme, function (v) { st.theme = v; paint(); }));
        ctrl.appendChild(makeSel("Sides", [["auto", "Auto (Donors ↑ / Acceptors ↓)"], ["alt", "Alternate ↑ / ↓"]], st.layout, function (v) { st.layout = v; paint(); }));
        ctrl.appendChild(strLbl);
        ctrl.appendChild(makeSel("Atoms", [["color", "Colored"], ["mono", "Black"]], st.mono ? "mono" : "color", function (v) { st.mono = v === "mono"; paint(); }));

        var body = Ent.el("div", "gfx-body"), stage = Ent.el("div", "gfx-stage");
        var listTitle = Ent.el("div", "slide-list-head");
        var listWrap = Ent.el("div", "slide-list");
        var hint = Ent.el("p", "hint", "Right-click or drag the graphic to copy for PowerPoint/Keynote, or click Download PNG/SVG. Customize labels or axis side below.");
        body.appendChild(ctrl); body.appendChild(stage); body.appendChild(hint); body.appendChild(listTitle); body.appendChild(listWrap);
        box.replaceChildren(bar, body);

        var lastRender = null;
        function paint() {
          if (!st.items.length) { stage.replaceChildren(Ent.el("p", "hint", "No molecules selected.")); lastRender = null; return; }
          var res = Ent.renderSlideSVG(st.items, st);
          lastRender = res;
          svgToPngDataUrl(res.svg, res.width, res.height).then(function (pngUrl) {
            if (lastRender !== res) return;
            var img = Ent.el("img", "gfx-img"); img.src = pngUrl;
            img.alt = "Triplet energy comparison slide";
            stage.replaceChildren(img);
          }, function () {
            if (lastRender === res) stage.innerHTML = res.svg;
          });
        }

        function drawItems() {
          listTitle.textContent = "Selected molecules (" + st.items.length + ")";
          listWrap.replaceChildren();
          var us = slideUnitSpec(st.unit, st.items.map(function (it) { return Number(it.et_kcal); }));
          st.items.forEach(function (it, idx) {
            var row = Ent.el("div", "slide-item");
            var inp = Ent.el("input"); inp.type = "text"; inp.value = it.label; inp.setAttribute("aria-label", "Slide label for " + (it.commercial_name || it.name));
            inp.addEventListener("input", function () { it.label = inp.value; paint(); });
            var valTag = Ent.el("span", "mono slide-val", us.fmtVal(Number(it.et_kcal)) + " " + us.suf);
            var sideBtn = Ent.el("button", "btn tiny", it.side === "top" ? "↑" : it.side === "bottom" ? "↓" : "Auto");
            sideBtn.type = "button"; sideBtn.title = "Toggle above / below axis";
            sideBtn.addEventListener("click", function () {
              it.side = it.side === "auto" ? "top" : it.side === "top" ? "bottom" : "auto";
              sideBtn.textContent = it.side === "top" ? "↑" : it.side === "bottom" ? "↓" : "Auto";
              paint();
            });
            var rm = Ent.el("button", "btn tiny", "×"); rm.type = "button"; rm.title = "Remove from slide";
            rm.addEventListener("click", function () {
              st.items.splice(idx, 1);
              if (hooks.onRemove) hooks.onRemove(it);
              drawItems(); paint();
            });
            row.appendChild(inp); row.appendChild(valTag); row.appendChild(sideBtn); row.appendChild(rm);
            listWrap.appendChild(row);
          });
        }

        dlSvg.addEventListener("click", function () {
          if (!lastRender) return;
          Ent.downloadBlob(new Blob([lastRender.svg], { type: "image/svg+xml;charset=utf-8" }), "trendb-slide.svg");
        });
        dlPng.addEventListener("click", function () {
          if (!lastRender) return;
          svgToPngDataUrl(lastRender.svg, lastRender.width, lastRender.height).then(function (pngUrl) {
            var parts = pngUrl.split(","), bin = atob(parts[1]), arr = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            Ent.downloadBlob(new Blob([arr], { type: "image/png" }), "trendb-slide.png");
          });
        });
        xBtn.addEventListener("click", Ent.closeDialog);
        drawItems(); paint();
      });
    }
  };

  /* ---------- Fast 3D XYZ Geometry Generator (MMFF94s+ & Octahedral Metal Assembly) ---------- */
  function vSub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function vAdd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function vScale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function vDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function vCross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function vDist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
  function vNorm(a) { var l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function rodrigues(p, o, u, th) {
    var v = vSub(p, o), c = Math.cos(th), s = Math.sin(th);
    return vAdd(o, vAdd(vAdd(vScale(v, c), vScale(vCross(u, v), s)), vScale(u, vDot(u, v) * (1 - c))));
  }

  function idealBondLen(z1, z2, ord) {
    var a = Math.min(z1, z2), b = Math.max(z1, z2);
    if (a === 1) return b === 6 ? 1.09 : b === 7 ? 1.01 : b === 8 ? 0.97 : b === 16 ? 1.34 : 1.12;
    if (a === 5 && b === 6) return 1.56;
    if (a === 5 && b === 7) return 1.58;
    if (a === 5 && b === 8) return 1.38;
    if (a === 6 && b === 6) return ord >= 3 ? 1.20 : ord === 2 ? 1.34 : 1.48;
    if (a === 6 && b === 7) return ord >= 3 ? 1.15 : ord === 2 ? 1.29 : 1.42;
    if (a === 6 && b === 8) return ord === 2 ? 1.22 : 1.41;
    if (a === 6 && b === 9) return 1.35;
    if (a === 6 && b === 17) return 1.76;
    if (a === 6 && b === 35) return 1.92;
    if (a === 6 && b === 53) return 2.12;
    if (a === 6 && b === 16) return 1.76;
    if (a === 7 && b === 7) return ord === 2 ? 1.25 : 1.40;
    return 1.48;
  }

  function springRelaxPts(pts, syms, bonds, angles, iters) {
    var n = pts.length, near = [], i, j, it;
    for (i = 0; i < n; i++) { var s = {}; s[i] = 1; near.push(s); }
    for (i = 0; i < bonds.length; i++) { near[bonds[i].u][bonds[i].v] = 1; near[bonds[i].v][bonds[i].u] = 1; }
    for (i = 0; i < angles.length; i++) { near[angles[i].u][angles[i].v] = 1; near[angles[i].v][angles[i].u] = 1; }
    for (it = 0; it < (iters || 350); it++) {
      var f = []; for (i = 0; i < n; i++) f.push([0, 0, 0]);
      for (i = 0; i < bonds.length; i++) {
        var b = bonds[i], d = vSub(pts[b.v], pts[b.u]), len = Math.hypot(d[0], d[1], d[2]) || 0.01;
        var kb = 0.45 * (len - b.L) / len;
        for (var c = 0; c < 3; c++) { f[b.u][c] += d[c] * kb; f[b.v][c] -= d[c] * kb; }
      }
      for (i = 0; i < angles.length; i++) {
        var ag = angles[i], da = vSub(pts[ag.v], pts[ag.u]), la = Math.hypot(da[0], da[1], da[2]) || 0.01;
        var ka = 0.22 * (la - ag.L) / la;
        for (c = 0; c < 3; c++) { f[ag.u][c] += da[c] * ka; f[ag.v][c] -= da[c] * ka; }
      }
      for (i = 0; i < n; i++) {
        for (j = i + 1; j < n; j++) {
          if (near[i][j]) continue;
          var dr = vSub(pts[j], pts[i]), dist = Math.hypot(dr[0], dr[1], dr[2]) || 0.01;
          var minR = (syms[i] === "H" && syms[j] === "H") ? 1.85 : 2.25;
          if (dist < minR) {
            var kr = 0.16 * (minR - dist) / dist;
            for (c = 0; c < 3; c++) { f[i][c] -= dr[c] * kr; f[j][c] += dr[c] * kr; }
          }
        }
      }
      for (i = 0; i < n; i++) {
        for (c = 0; c < 3; c++) pts[i][c] += Math.max(-0.22, Math.min(0.22, f[i][c]));
      }
    }
  }

  function collectGraphConstraints(mol) {
    var n = mol.getAllAtoms(), adj = buildAdj(mol), bonds = [], angles = [], i, a, b;
    for (b = 0; b < mol.getAllBonds(); b++) {
      var u = mol.getBondAtom(0, b), v = mol.getBondAtom(1, b);
      bonds.push({ u: u, v: v, L: idealBondLen(mol.getAtomicNo(u), mol.getAtomicNo(v), mol.getBondOrder(b)) });
    }
    for (i = 0; i < n; i++) {
      var nbs = adj[i];
      if (nbs.length >= 2) {
        var z = mol.getAtomicNo(i), deg = nbs.length, hasT = false, hasD = false;
        for (a = 0; a < nbs.length; a++) {
          var bo = mol.getBondOrder(nbs[a].bond);
          if (bo === 3) hasT = true;
          if (bo === 2) hasD = true;
        }
        var idealDeg = (deg === 2 && (z === 6 || z === 7) && hasT) ? 180
          : (deg <= 3 && (mol.isAromaticAtom(i) || hasD || z === 5)) ? 120 : 109.5;
        var cosT = Math.cos(idealDeg * Math.PI / 180);
        for (a = 0; a < nbs.length; a++) {
          for (b = a + 1; b < nbs.length; b++) {
            var u2 = nbs[a].to, v2 = nbs[b].to;
            var l1 = idealBondLen(z, mol.getAtomicNo(u2), mol.getBondOrder(nbs[a].bond));
            var l2 = idealBondLen(z, mol.getAtomicNo(v2), mol.getBondOrder(nbs[b].bond));
            angles.push({ u: u2, v: v2, L: Math.sqrt(Math.max(0.5, l1 * l1 + l2 * l2 - 2 * l1 * l2 * cosT)) });
          }
        }
      }
    }
    return { bonds: bonds, angles: angles };
  }

  function seed3DFromMol(mol) {
    mol.ensureHelperArrays(OCL.Molecule.cHelperRings);
    mol.inventCoordinates();
    var nHeavy = mol.getAllAtoms(), lens = [], b, i, k;
    for (b = 0; b < mol.getAllBonds(); b++) {
      var u = mol.getBondAtom(0, b), v = mol.getBondAtom(1, b);
      var d = Math.hypot(mol.getAtomX(u) - mol.getAtomX(v), mol.getAtomY(u) - mol.getAtomY(v));
      if (d > 1e-3) lens.push(d);
    }
    lens.sort(function (x, y) { return x - y; });
    var sc = 1.45 / (lens.length ? lens[Math.floor(lens.length / 2)] : 1.5);
    for (i = 0; i < nHeavy; i++) {
      mol.setAtomX(i, mol.getAtomX(i) * sc);
      mol.setAtomY(i, mol.getAtomY(i) * sc);
      mol.setAtomZ(i, (mol.isAromaticAtom(i) ? 0.08 : 0.42) * (((i * 7) % 5) - 2) * 0.5);
    }
    mol.addImplicitHydrogens();
    var nAll = mol.getAllAtoms(), adj = buildAdj(mol), hByParent = {};
    for (var h = nHeavy; h < nAll; h++) {
      if (adj[h].length !== 1) continue;
      var p = adj[h][0].to;
      if (!hByParent[p]) hByParent[p] = [];
      hByParent[p].push(h);
    }
    Object.keys(hByParent).forEach(function (pk) {
      var pi = Number(pk), hs = hByParent[pk];
      var pp = [mol.getAtomX(pi), mol.getAtomY(pi), mol.getAtomZ(pi)];
      var heavyNbs = [];
      for (i = 0; i < adj[pi].length; i++) if (adj[pi][i].to < nHeavy) heavyNbs.push(adj[pi][i].to);
      var out = [0, 0, 0];
      for (i = 0; i < heavyNbs.length; i++) {
        var nb = heavyNbs[i];
        out = vAdd(out, vSub(pp, [mol.getAtomX(nb), mol.getAtomY(nb), mol.getAtomZ(nb)]));
      }
      if (Math.hypot(out[0], out[1], out[2]) < 1e-4) out = [1, 0.3, 0.2];
      var uOut = vNorm(out), perp = vCross(uOut, [0, 0, 1]);
      if (Math.hypot(perp[0], perp[1], perp[2]) < 1e-4) perp = vCross(uOut, [0, 1, 0]);
      perp = vNorm(perp);
      var perp2 = vCross(uOut, perp), bLen = idealBondLen(1, mol.getAtomicNo(pi), 1), dir, hp;
      if (hs.length === 1) {
        var zSign = (pi % 2 ? 1 : -1) * 0.55;
        dir = heavyNbs.length >= 3 ? vNorm([0, 0, zSign > 0 ? 1 : -1]) : vNorm(vAdd(uOut, [0, 0, zSign * 0.35]));
        hp = vAdd(pp, vScale(dir, bLen));
        mol.setAtomX(hs[0], hp[0]); mol.setAtomY(hs[0], hp[1]); mol.setAtomZ(hs[0], hp[2]);
      } else if (hs.length === 2) {
        for (k = 0; k < 2; k++) {
          dir = vNorm(vAdd(vScale(uOut, 0.58), vScale(perp, 0.81 * (k === 0 ? 1 : -1))));
          hp = vAdd(pp, vScale(dir, bLen));
          mol.setAtomX(hs[k], hp[0]); mol.setAtomY(hs[k], hp[1]); mol.setAtomZ(hs[k], hp[2]);
        }
      } else {
        for (k = 0; k < hs.length; k++) {
          var phi = k * 2 * Math.PI / hs.length;
          dir = vNorm(vAdd(vScale(uOut, 0.35), vScale(vAdd(vScale(perp, Math.cos(phi)), vScale(perp2, Math.sin(phi))), 0.94)));
          hp = vAdd(pp, vScale(dir, bLen));
          mol.setAtomX(hs[k], hp[0]); mol.setAtomY(hs[k], hp[1]); mol.setAtomZ(hs[k], hp[2]);
        }
      }
    });
  }

  function build3DOrganic(mol) {
    var m = mol.getCompactCopy ? mol.getCompactCopy() : OCL.Molecule.fromMolfile(mol.toMolfile());
    seed3DFromMol(m);
    var mmffOk = false;
    try { new OCL.ForceFieldMMFF94(m, OCL.ForceFieldMMFF94.MMFF94SPLUS).minimise({ maxIts: 500 }); mmffOk = true; } catch (e) {}
    var minD = 999, i, j;
    for (i = 0; i < m.getAllAtoms(); i++) {
      for (j = i + 1; j < m.getAllAtoms(); j++) {
        var d = Math.hypot(m.getAtomX(i) - m.getAtomX(j), m.getAtomY(i) - m.getAtomY(j), m.getAtomZ(i) - m.getAtomZ(j));
        if (d < minD) minD = d;
      }
    }
    if (!mmffOk || minD < 0.85) {
      var pts = [], syms = [];
      for (i = 0; i < m.getAllAtoms(); i++) {
        pts.push([m.getAtomX(i), m.getAtomY(i), m.getAtomZ(i)]);
        syms.push(m.getAtomLabel(i));
      }
      var cons = collectGraphConstraints(m);
      springRelaxPts(pts, syms, cons.bonds, cons.angles, 400);
      for (i = 0; i < m.getAllAtoms(); i++) { m.setAtomX(i, pts[i][0]); m.setAtomY(i, pts[i][1]); m.setAtomZ(i, pts[i][2]); }
      if (mmffOk) { try { new OCL.ForceFieldMMFF94(m, OCL.ForceFieldMMFF94.MMFF94SPLUS).minimise({ maxIts: 400 }); } catch (e) {} }
    }
    return m;
  }

  function appendMappedConstraints(subCons, keptMap, baseOffset, fullBonds, fullAngles) {
    for (var i = 0; i < subCons.bonds.length; i++) {
      var b = subCons.bonds[i];
      if ((b.u in keptMap) && (b.v in keptMap)) fullBonds.push({ u: baseOffset + keptMap[b.u], v: baseOffset + keptMap[b.v], L: b.L });
    }
    for (i = 0; i < subCons.angles.length; i++) {
      var a = subCons.angles[i];
      if ((a.u in keptMap) && (a.v in keptMap)) fullAngles.push({ u: baseOffset + keptMap[a.u], v: baseOffset + keptMap[a.v], L: a.L });
    }
  }

  function generate3DAtomList(mol) {
    mol.ensureHelperArrays(OCL.Molecule.cHelperRings);
    var adj = buildAdj(mol), n = mol.getAllAtoms(), mIdx = -1, loneMetals = [], a, i, j, k;
    for (a = 0; a < n; a++) {
      if (!isMetal(mol, a)) continue;
      if (adj[a].length >= 2) { mIdx = a; break; }
      if (adj[a].length === 0 && n > 2) loneMetals.push(a);
    }
    var disconnectedMode = false;
    if (mIdx < 0 && loneMetals.length === 1) { mIdx = loneMetals[0]; disconnectedMode = true; }
    if (mIdx < 0) {
      var m3 = build3DOrganic(mol), outOrg = [], cx = 0, cy = 0, cz = 0, no = m3.getAllAtoms();
      for (i = 0; i < no; i++) {
        var px = m3.getAtomX(i), py = m3.getAtomY(i), pz = m3.getAtomZ(i);
        cx += px; cy += py; cz += pz;
        outOrg.push({ sym: m3.getAtomLabel(i), p: [px, py, pz] });
      }
      if (no > 0) { cx /= no; cy /= no; cz /= no; }
      for (i = 0; i < no; i++) outOrg[i].p = [outOrg[i].p[0] - cx, outOrg[i].p[1] - cy, outOrg[i].p[2] - cz];
      return outOrg;
    }

    var blocked = {}, visited = {}, ligands = [];
    blocked[mIdx] = 1; visited[mIdx] = 1;
    var B_DAT = OCL.Molecule.cBondTypeMetalLigand;
    for (a = 0; a < n; a++) {
      if (visited[a]) continue;
      var comp = reachWithout(adj, a, blocked);
      comp.forEach(function (x) { visited[x] = 1; });
      var anchors = [];
      if (disconnectedMode) {
        anchors = inferDisconnectedAnchors(mol, adj, comp);
      } else {
        var compSet = {}; comp.forEach(function (x) { compSet[x] = 1; });
        for (i = 0; i < adj[mIdx].length; i++) {
          var e = adj[mIdx][i];
          if (compSet[e.to]) anchors.push({ atom: e.to, atomicNo: mol.getAtomicNo(e.to), dative: e.type === B_DAT });
        }
      }
      anchors.sort(function (x, y) { return (x.dative ? 1 : 0) - (y.dative ? 1 : 0) || mol.getAtomicNo(x.atom) - mol.getAtomicNo(y.atom); });
      ligands.push({ comp: comp, anchors: anchors });
    }
    var coord = ligands.filter(function (l) { return l.anchors.length > 0; });
    var freeFrags = ligands.filter(function (l) { return l.anchors.length === 0; });
    var bidentates = coord.filter(function (l) { return l.anchors.length === 2; });
    var monodentates = coord.filter(function (l) { return l.anchors.length === 1; });
    var slotDirs = [];
    if (bidentates.length === 3 && monodentates.length === 0) {
      var pairs = [[[1, 0, 0], [0, -1, 0]], [[0, 1, 0], [0, 0, -1]], [[0, 0, 1], [-1, 0, 0]]];
      bidentates.forEach(function (l, idx) { slotDirs.push({ lig: l, dirs: pairs[idx] }); });
    } else if (bidentates.length === 2 && monodentates.length === 2) {
      slotDirs.push({ lig: bidentates[0], dirs: [[1, 0, 0], [0, 0, 1]] });
      slotDirs.push({ lig: bidentates[1], dirs: [[0, 1, 0], [0, 0, -1]] });
      slotDirs.push({ lig: monodentates[0], dirs: [[-1, 0, 0]] });
      slotDirs.push({ lig: monodentates[1], dirs: [[0, -1, 0]] });
    } else {
      coord.forEach(function (l, idx) {
        var th = idx * 2 * Math.PI / Math.max(1, coord.length);
        if (l.anchors.length === 2) {
          slotDirs.push({ lig: l, dirs: [vNorm([Math.cos(th - 0.4), Math.sin(th - 0.4), idx % 2 ? 0.3 : -0.3]), vNorm([Math.cos(th + 0.4), Math.sin(th + 0.4), idx % 2 ? -0.3 : 0.3])] });
        } else {
          slotDirs.push({ lig: l, dirs: [[Math.cos(th), Math.sin(th), 0]] });
        }
      });
    }

    var pts = [[0, 0, 0]], syms = [mol.getAtomLabel(mIdx)], fullBonds = [], fullAngles = [], coordSites = [];
    for (var li = 0; li < slotDirs.length; li++) {
      var entry = slotDirs[li], lig = entry.lig, dirs = entry.dirs;
      var built = buildSubgraphMol(mol, adj, lig.comp), sub = built.sub, map = built.map;
      var heavyCount = sub.getAllAtoms(), mol3d = build3DOrganic(sub), adj3 = buildAdj(mol3d);
      var anchorInfos = lig.anchors.map(function (an) { return { localIdx: map[an.atom], wasCov: !an.dative, atomicNo: an.atomicNo }; });
      var dropSet = {}, anchorDir = {};
      for (i = 0; i < anchorInfos.length; i++) {
        var ai = anchorInfos[i];
        if (!ai.wasCov) continue;
        var hNb = null;
        for (j = 0; j < adj3[ai.localIdx].length; j++) {
          var candNb = adj3[ai.localIdx][j].to;
          if (candNb >= heavyCount && mol3d.getAtomicNo(candNb) === 1) { hNb = candNb; break; }
        }
        if (hNb != null) {
          dropSet[hNb] = 1;
          anchorDir[ai.localIdx] = vNorm(vSub(
            [mol3d.getAtomX(hNb), mol3d.getAtomY(hNb), mol3d.getAtomZ(hNb)],
            [mol3d.getAtomX(ai.localIdx), mol3d.getAtomY(ai.localIdx), mol3d.getAtomZ(ai.localIdx)]
          ));
        }
      }
      var pts3 = [], syms3 = [], keptMap = {};
      for (i = 0; i < mol3d.getAllAtoms(); i++) {
        if (dropSet[i]) continue;
        keptMap[i] = pts3.length;
        pts3.push([mol3d.getAtomX(i), mol3d.getAtomY(i), mol3d.getAtomZ(i)]);
        syms3.push(mol3d.getAtomLabel(i));
      }

      var baseOffset = pts.length, subCons = collectGraphConstraints(mol3d);
      if (anchorInfos.length === 2) {
        var aL = anchorInfos[0].localIdx, bL = anchorInfos[1].localIdx;
        var parent = {}, q = [aL]; parent[aL] = null;
        while (q.length) {
          var cur = q.shift(); if (cur === bL) break;
          for (i = 0; i < adj3[cur].length; i++) {
            var e3 = adj3[cur][i];
            if ((e3.to in keptMap) && !(e3.to in parent)) { parent[e3.to] = { prev: cur, bond: e3.bond }; q.push(e3.to); }
          }
        }
        if (bL in parent) {
          var path = [], c = bL;
          while (parent[c]) { var st = parent[c]; path.push({ u: st.prev, v: c, bond: st.bond }); c = st.prev; }
          var br = null;
          for (i = 0; i < path.length; i++) if (!mol3d.isRingBond(path[i].bond) && mol3d.getBondOrder(path[i].bond) === 1) { br = path[i]; break; }
          if (br) {
            var sideB = reachAcrossBond(adj3, br.v, br.u).list.filter(function (idx) { return idx in keptMap; });
            var pU = pts3[keptMap[br.u]], pV = pts3[keptMap[br.v]], axis = vNorm(vSub(pV, pU));
            var pA0 = pts3[keptMap[aL]], pB0 = pts3[keptMap[bL]], bestTheta = 0, bestD = vDist(pA0, pB0);
            for (var deg = 0; deg < 360; deg += 5) {
              var th = deg * Math.PI / 180, dR = vDist(pA0, rodrigues(pB0, pU, axis, th));
              if (dR < bestD) { bestD = dR; bestTheta = th; }
            }
            if (Math.abs(bestTheta) > 1e-4) {
              for (i = 0; i < sideB.length; i++) pts3[keptMap[sideB[i]]] = rodrigues(pts3[keptMap[sideB[i]]], pU, axis, bestTheta);
            }
          }
        }
        var pA = pts3[keptMap[aL]], pB = pts3[keptMap[bL]];
        var rA = anchorInfos[0].atomicNo === 6 ? 2.01 : 2.12, rB = anchorInfos[1].atomicNo === 6 ? 2.01 : 2.12;
        var midA = vScale(vAdd(pA, pB), 0.5), com = [0, 0, 0];
        pts3.forEach(function (p) { com = vAdd(com, p); }); com = vScale(com, 1 / pts3.length);
        var e1 = vNorm(vSub(pB, pA)), rawOut = vSub(com, midA);
        rawOut = vSub(rawOut, vScale(e1, vDot(rawOut, e1)));
        var e2 = vNorm(rawOut), e3 = vCross(e1, e2);
        var dA = dirs[0], dB = dirs[1], t2 = vNorm(vAdd(dA, dB)), rawT1 = vSub(dB, dA);
        var t1 = vNorm(vSub(rawT1, vScale(t2, vDot(rawT1, t2)))), t3 = vCross(t1, t2);
        var targetMid = vScale(vAdd(vScale(dA, rA), vScale(dB, rB)), 0.5);
        for (k = 0; k < pts3.length; k++) {
          var rel = vSub(pts3[k], midA);
          pts.push(vAdd(targetMid, vAdd(vAdd(vScale(t1, vDot(rel, e1)), vScale(t2, vDot(rel, e2))), vScale(t3, vDot(rel, e3)))));
          syms.push(syms3[k]);
        }
        var gA = baseOffset + keptMap[aL], gB = baseOffset + keptMap[bL];
        fullBonds.push({ u: 0, v: gA, L: rA }, { u: 0, v: gB, L: rB });
        coordSites.push({ idx: gA, r: rA, dir: dA }, { idx: gB, r: rB, dir: dB });
        appendMappedConstraints(subCons, keptMap, baseOffset, fullBonds, fullAngles);
      } else if (anchorInfos.length === 1) {
        var iA = keptMap[anchorInfos[0].localIdx], pA1 = pts3[iA];
        var rA1 = anchorInfos[0].atomicNo === 6 ? 2.02 : 2.12, dirOut;
        if (anchorInfos[0].localIdx in anchorDir) dirOut = vScale(anchorDir[anchorInfos[0].localIdx], -1);
        else { var com1 = [0, 0, 0]; pts3.forEach(function (p) { com1 = vAdd(com1, p); }); dirOut = vNorm(vSub(vScale(com1, 1 / pts3.length), pA1)); }
        var dT = vNorm(dirs[0]), dot = Math.max(-1, Math.min(1, vDot(dirOut, dT))), targetP = vScale(dT, rA1);
        var rotAxis = vCross(dirOut, dT), axisLen = Math.hypot(rotAxis[0], rotAxis[1], rotAxis[2]), ang = Math.acos(dot);
        rotAxis = axisLen > 1e-6 ? vScale(rotAxis, 1 / axisLen) : [0, 0, 1];
        for (k = 0; k < pts3.length; k++) {
          var rel1 = vSub(pts3[k], pA1);
          if (axisLen > 1e-6) rel1 = rodrigues(rel1, [0, 0, 0], rotAxis, ang);
          else if (dot < 0) rel1 = vScale(rel1, -1);
          pts.push(vAdd(targetP, rel1));
          syms.push(syms3[k]);
        }
        var gA1 = baseOffset + iA;
        fullBonds.push({ u: 0, v: gA1, L: rA1 });
        coordSites.push({ idx: gA1, r: rA1, dir: dT });
        appendMappedConstraints(subCons, keptMap, baseOffset, fullBonds, fullAngles);
      }
    }

    for (i = 0; i < coordSites.length; i++) {
      for (j = i + 1; j < coordSites.length; j++) {
        var sA = coordSites[i], sB = coordSites[j], cosS = vDot(vNorm(sA.dir), vNorm(sB.dir));
        fullAngles.push({ u: sA.idx, v: sB.idx, L: Math.sqrt(Math.max(0.5, sA.r * sA.r + sB.r * sB.r - 2 * sA.r * sB.r * cosS)) });
      }
    }
    springRelaxPts(pts, syms, fullBonds, fullAngles, 350);

    if (freeFrags.length) {
      var maxX = 0;
      for (i = 0; i < pts.length; i++) if (pts[i][0] > maxX) maxX = pts[i][0];
      var cursorX = maxX + 3.8;
      for (var fi = 0; fi < freeFrags.length; fi++) {
        var fm = build3DOrganic(buildSubgraphMol(mol, adj, freeFrags[fi].comp).sub);
        var minFX = Infinity, maxFX = -Infinity, cyF = 0, czF = 0, nf = fm.getAllAtoms();
        for (i = 0; i < nf; i++) {
          var fx = fm.getAtomX(i);
          if (fx < minFX) minFX = fx;
          if (fx > maxFX) maxFX = fx;
          cyF += fm.getAtomY(i); czF += fm.getAtomZ(i);
        }
        if (nf > 0) { cyF /= nf; czF /= nf; }
        for (i = 0; i < nf; i++) {
          pts.push([cursorX + (fm.getAtomX(i) - minFX), fm.getAtomY(i) - cyF, fm.getAtomZ(i) - czF]);
          syms.push(fm.getAtomLabel(i));
        }
        cursorX += (maxFX - minFX) + 3.2;
      }
    }
    return pts.map(function (p, idx) { return { sym: syms[idx], p: p }; });
  }

  var xyzCache = Object.create(null);

  function fmtCoord(v) {
    var clean = Math.abs(v) < 5e-7 ? 0 : v;
    var s = clean.toFixed(6);
    while (s.length < 12) s = " " + s;
    return s;
  }

  Ent.molToXYZ = function (smiles, title) {
    if (!window.OCL || !smiles) return null;
    try {
      var atoms = xyzCache[smiles];
      if (!atoms) {
        var mol = OCL.Molecule.fromSmiles(smiles);
        if (!(mol.getAllAtoms() > 0)) return null;
        atoms = generate3DAtomList(mol);
        if (!atoms || !atoms.length) return null;
        xyzCache[smiles] = atoms;
      }
      var cleanTitle = title ? String(title).replace(/[\r\n]+/g, " ").trim() : "TrEnDB";
      var lines = [String(atoms.length), cleanTitle + " — 3D geometry (Angstrom)"];
      for (var i = 0; i < atoms.length; i++) {
        var sym = atoms[i].sym, pad = sym.length === 1 ? " " : "";
        var p = atoms[i].p;
        lines.push(sym + pad + "  " + fmtCoord(p[0]) + " " + fmtCoord(p[1]) + " " + fmtCoord(p[2]));
      }
      return lines.join("\n") + "\n";
    } catch (e) { return null; }
  };
})();

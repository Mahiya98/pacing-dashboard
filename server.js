import express from "express";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(__dirname, ".env")); } catch {}

const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwd2JjdXh3eGtxdmF1ZmZxb29qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM4MjA4NjEsImV4cCI6MjA5OTM5Njg2MX0.iAoIZXl-2G7h3wm4jcYsEs6-wdN-YKTS-KbBteBBzUk";

const SUPABASE_PROJECT_REF = "pacing-dashboard";

const BUS = [
  { display: "AEFML", dwhSbu: "AEL", dwhBuId: 144 },
  { display: "AAFL", dwhSbu: "AAFL", dwhBuId: 232 },
  { display: "FAL", dwhSbu: "FAL", dwhBuId: 189 },
  { display: "MRML", dwhSbu: "HRML", dwhBuId: 188 },
  { display: "ACCL", dwhSbu: "ACCL", dwhBuId: 4 },
  { display: "APFIL", dwhSbu: "APFIL", dwhBuId: 8 },
  { display: "AIL", dwhSbu: "AIL", dwhBuId: 224 },
];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = n => String(n).padStart(2, "0");

const TARGET_RULES = [
  { id: "cap_util", ordered: true, patterns: ["capacity utilization %", "capacity utilization", "plant capacity utilization"] },
  { id: "oee", patterns: ["oee (%)"] },
  { id: "Yeild", patterns: ["yield %", "maintain yield %"] },
  { id: "waste", patterns: ["production rejection rate", "rework / wastage rate"] },
  { id: "5s_score", patterns: ["5s score"] },
  { id: "kaizen", patterns: ["no of kaizen implemented"] },
  { id: "kaizen_savings", patterns: ["kaizen savings"] },
  { id: "training", patterns: ["training participation"] },
  { id: "manpower", patterns: ["manpower availability"] },
  { id: "project", patterns: ["project progress vs plan"] },
];

function resolveTargets(rows) {
  const byName = {};
  for (const r of rows) {
    const buId = Number(r.intBusinessUnitId);
    const name = (r.strKPIs || "").toLowerCase();
    const val = Number(r.numTarget);
    if (!Number.isFinite(val)) continue;
    const map = byName[buId] || (byName[buId] = {});
    if (map[name] === undefined || val < map[name]) map[name] = val;
  }
  const targets = {};
  for (const buId of Object.keys(byName)) {
    const map = byName[buId];
    const t = targets[buId] = {};
    for (const rule of TARGET_RULES) {
      if (rule.ordered) {
        for (const p of rule.patterns) {
          const matched = Object.keys(map).filter(n => n.includes(p));
          if (matched.length) {
            t[rule.id] = Math.min(...matched.map(n => map[n]));
            break;
          }
        }
      } else {
        let best;
        for (const n of Object.keys(map)) {
          if (rule.patterns.some(p => n.includes(p)) && (best === undefined || map[n] < best)) {
            best = map[n];
          }
        }
        if (best !== undefined) t[rule.id] = best;
      }
    }
  }
  return targets;
}

function resolveMonth(q) {
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth() + 1;
  if (q && /^\d{4}-\d{2}$/.test(q.month || "")) {
    year = Number(q.month.slice(0, 4));
    month = Number(q.month.slice(5, 7));
  }
  if (month < 1 || month > 12) { year = now.getFullYear(); month = now.getMonth() + 1; }
  const totalDays = new Date(year, month, 0).getDate();
  const start = `${year}-${pad(month)}-01`;
  const end = month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`;
  const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1;
  const today = Math.min(isCurrent ? now.getDate() : totalDays, totalDays);
  return {
    year, month, totalDays, today,
    monthName: MONTHS[month - 1],
    freqValue: `${MONTH_ABBR[month - 1]}, ${year}`,
    start, end,
  };
}

function buildSnapshot(meta, rows) {
  const idx = Object.fromEntries(BUS.map((b, i) => [b.dwhBuId, i]));
  const sbus = BUS.map(b => ({
    display: b.display,
    dwhSbu: b.dwhSbu,
    dwhBuId: b.dwhBuId,
    today: meta.today,
    targets: {},
    dayLog: {},
    breakdownByDay: {},
    breakdownByReason: {},
    totalDowntime: 0,
  }));

  const logOf = (buId, d) => {
    const i = idx[buId];
    if (i === undefined) return null;
    const s = sbus[i];
    return s.dayLog[d] || (s.dayLog[d] = {});
  };

  for (const r of rows.prod) {
    const log = logOf(Number(r.intBusinessUnitId), Number(r.d));
    if (!log) continue;
    const actual = Number(r.actual) || 0;
    const good = Number(r.good) || 0;
    const availableMin = Number(r.availableMin) || 0;
    const nptMin = Number(r.nptMin) || 0;
    const capUnits = Number(r.capUnits) || 0;
    log.prod_budget = actual;
    if (availableMin > 0) log.npt_pct = (nptMin / availableMin) * 100;
    if (capUnits > 0) log.cap_util = (actual / capUnits) * 100;
    if (capUnits > 0) log.oee = (good / capUnits) * 100;
    if (actual > 0) log.Yeild = (good / actual) * 100;
    if (actual > 0) log.waste = ((actual - good) / actual) * 100;
  }

  for (const r of rows.ot) {
    const log = logOf(Number(r.intBusinessUnitId), Number(r.d));
    if (log) log.ot = Number(r.hours) || 0;
  }
  for (const r of rows.man) {
    const log = logOf(Number(r.intBusinessUnitId), Number(r.d));
    if (log) log.manpower = Number(r.cnt) || 0;
  }
  for (const r of rows.tr) {
    const log = logOf(Number(r.intBusinessUnitId), Number(r.d));
    if (log) log.training = Number(r.cnt) || 0;
  }
  for (const r of rows.pr) {
    const log = logOf(Number(r.intBusinessUnitId), Number(r.d));
    if (log) log.project = Number(r.cnt) || 0;
  }

  for (const r of rows.bd) {
    const i = idx[Number(r.intBusinessUnitId)];
    if (i === undefined) continue;
    const s = sbus[i];
    const name = (r.strBreakdownName || "").trim();
    const reasonName = (r.strReasonName || "").trim();
    if (name.startsWith("P01") || reasonName.startsWith("P01")) continue;
    const reason = reasonName || (r.strReason || "").trim() || (r.strSubCategoryName || "").trim() || (r.strCategoryName || "").trim() || "(unspecified)";
    const downtime = Number(r.downtime) || 0;
    const d = Number(r.d);
    (s.breakdownByDay[d] || (s.breakdownByDay[d] = [])).push({ downtime, name, reason });
    const br = s.breakdownByReason[reason] || (s.breakdownByReason[reason] = { count: 0, name, totalDowntime: 0 });
    br.count += 1;
    br.totalDowntime += downtime;
    s.totalDowntime += downtime;
  }

  const resolved = resolveTargets(rows.tgt);
  for (const buIdStr of Object.keys(resolved)) {
    const i = idx[Number(buIdStr)];
    if (i !== undefined) sbus[i].targets = resolved[buIdStr];
  }

  for (const s of sbus) {
    for (const k of Object.keys(s.dayLog)) {
      if (Object.keys(s.dayLog[k]).length === 0) delete s.dayLog[k];
    }
  }

  return {
    meta: {
      generated: new Date().toISOString().replace("T", " ").slice(0, 19),
      year: meta.year,
      month: meta.month,
      monthName: meta.monthName,
      totalDays: meta.totalDays,
    },
    sbus,
  };
}

async function loadSnapshot(meta) {
  const inClause = BUS.map(b => b.dwhBuId).join(",");
  const pool = await sql.connect(DB_CONFIG);
  try {
    const req = pool.request();
    const prod = (await req.query(`
      SELECT intBusinessUnitId, DATEPART(day, dteProductionDate) d,
             SUM(numActualOutputQuantity) actual,
             SUM(numGoodOutputQuantity) good,
             SUM(numAvailableMinute) availableMin,
             SUM(numNptLossTimeInMinutes) nptMin,
             SUM(numCapacityPerHr * numAvailableMinute / 60.0) capUnits
      FROM mes.tblOeeProdWasteHeaderArc
      WHERE intBusinessUnitId IN (${inClause})
        AND dteProductionDate >= '${meta.start}' AND dteProductionDate < '${meta.end}'
      GROUP BY intBusinessUnitId, DATEPART(day, dteProductionDate)`)).recordset;

    const bd = (await req.query(`
      SELECT h.intBusinessUnitId, DATEPART(day, h.dteLossTimeDate) d,
             r.strBreakdownName, r.strReasonName, r.strReason, r.strCategoryName, r.strSubCategoryName,
             r.intLossTimeInMinutes downtime
      FROM mes.tblNPTHeaderArc h
      JOIN mes.tblNPTRowArc r ON r.intNPTId = h.intNPTId
      WHERE h.intBusinessUnitId IN (${inClause})
        AND h.dteLossTimeDate >= '${meta.start}' AND h.dteLossTimeDate < '${meta.end}'`)).recordset;

    const ot = (await req.query(`
      SELECT intBusinessUnitId, DATEPART(day, dteOverTimeDate) d, SUM(numOverTimeHour) hours
      FROM saas.timeEmpOverTimeArc
      WHERE intBusinessUnitId IN (${inClause}) AND isActive = 1
        AND dteOverTimeDate >= '${meta.start}' AND dteOverTimeDate < '${meta.end}'
      GROUP BY intBusinessUnitId, DATEPART(day, dteOverTimeDate)`)).recordset;

    const man = (await req.query(`
      SELECT e.intBusinessUnitId, DATEPART(day, a.dteAttendanceDate) d, COUNT(DISTINCT a.intEmployeeId) cnt
      FROM saas.timeAttendanceDailySummaryArc a
      JOIN saas.empEmployeeBasicInfoArc e ON e.intEmployeeBasicInfoId = a.intEmployeeId
      WHERE e.intBusinessUnitId IN (${inClause}) AND a.isPresent = 1
        AND a.dteAttendanceDate >= '${meta.start}' AND a.dteAttendanceDate < '${meta.end}'
      GROUP BY e.intBusinessUnitId, DATEPART(day, a.dteAttendanceDate)`)).recordset;

    const tr = (await req.query(`
      SELECT e.intBusinessUnitId, DATEPART(day, t.dteStartDate) d, COUNT(*) cnt
      FROM saas.empEmployeeTrainingArc t
      JOIN saas.empEmployeeBasicInfoArc e ON e.intEmployeeBasicInfoId = t.intEmployeeBasicInfoId
      WHERE e.intBusinessUnitId IN (${inClause})
        AND t.dteStartDate >= '${meta.start}' AND t.dteStartDate < '${meta.end}'
      GROUP BY e.intBusinessUnitId, DATEPART(day, t.dteStartDate)`)).recordset;

    const pr = (await req.query(`
      SELECT intBusinessUnitId, DATEPART(day, dteFromDate) d, COUNT(*) cnt
      FROM pmt.tblProjectManagementArc
      WHERE intBusinessUnitId IN (${inClause}) AND isActive = 1
        AND dteFromDate >= '${meta.start}' AND dteFromDate < '${meta.end}'
      GROUP BY intBusinessUnitId, DATEPART(day, dteFromDate)`)).recordset;

    const tgt = (await req.query(`
      SELECT t.intBusinessUnitId, k.strKPIs, t.numTarget
      FROM pms.tblTargetSetupArc t
      JOIN pms.tblKPIsArc k ON k.intKPIsId = t.intKPIsId
      WHERE t.intBusinessUnitId IN (${inClause}) AND t.isActive = 1
        AND t.strTargetFrequency = 'Monthly' AND t.strFrequencyValue = '${meta.freqValue}'`)).recordset;

    return buildSnapshot(meta, { prod, bd, ot, man, tr, pr, tgt });
  } finally {
    await pool.close();
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwd2JjdXh3eGtxdmF1ZmZxb29qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM4MjA4NjEsImV4cCI6MjA5OTM5Njg2MX0.iAoIZXl-2G7h3wm4jcYsEs6-wdN-YKTS-KbBteBBzUk";

const SUPABASE_PROJECT_REF = "pacing-dashboard";

async function supabaseFetch(pathAndQuery) {
  const res = await fetch(`https://${SUPABASE_PROJECT_REF}.supabase.co/rest/v1${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}`, "apikey": SUPABASE_ANON_KEY },
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function supabaseMonthsData() {
  const { data } = await supabaseFetch("/ACCL_KPI_TARGET?select=month,year");
  if (!data || data.length === 0) throw new Error("Supabase months query failed");
  const byMonth = {};
  for (const r of data) {
    const key = `${r.year}-${String(r.month).padStart(2, "0")}`;
    if (!byMonth[key]) byMonth[key] = { year: r.year, month: r.month, monthName: MONTHS[r.month - 1] };
  }
  return Object.values(byMonth);
}

async function supabaseSnapshotData(meta) {
  const monthKey = `${meta.year}-${String(meta.month).padStart(2, "0")}`;
  const { data } = await supabaseFetch(`/ACCL_KPI_TARGET?month=eq.${monthKey}&sbu=not.is.null`);
  if (!data || data.length === 0) throw new Error("Supabase snapshot query failed for " + monthKey);
  return buildSnapshotFromSupabase(data, meta);
}

function buildSnapshotFromSupabase(rows, meta) {
  const idx = Object.fromEntries(BUS.map((b, i) => [b.dwhBuId, i]));
  const sbus = BUS.map(b => ({
    display: b.display,
    dwhSbu: b.dwhSbu,
    dwhBuId: b.dwhBuId,
    today: meta.today,
    targets: {},
    dayLog: {},
    breakdownByDay: {},
    breakdownByReason: {},
    totalDowntime: 0,
  }));

  // KPI targets from Supabase ACCL_KPI_TARGET
  const tgtBySbu = {};
  for (const r of rows) {
    const buId = Number(r.intBusinessUnitId);
    const name = (r.strKPIs || "").toLowerCase();
    const val = Number(r.numTarget);
    if (!Number.isFinite(val)) continue;
    const map = tgtBySbu[buId] || (tgtBySbu[buId] = {});
    map[name] = val;
  }
  for (const buIdStr of Object.keys(tgtBySbu)) {
    const i = idx[Number(buIdStr)];
    if (i !== undefined) {
      const map = tgtBySbu[buIdStr];
      const t = {};
      for (const rule of TARGET_RULES) {
        if (rule.ordered) {
          for (const p of rule.patterns) {
            const matched = Object.keys(map).filter(n => n.includes(p));
            if (matched.length) {
              t[rule.id] = Math.min(...matched.map(n => map[n]));
              break;
            }
          }
        } else {
          let best;
          for (const n of Object.keys(map)) {
            if (rule.patterns.some(p => n.includes(p)) && (best === undefined || map[n] < best)) {
              best = map[n];
            }
          }
          if (best !== undefined) t[rule.id] = best;
        }
      }
      sbus[i].targets = t;
    }
  }

  return {
    meta: {
      generated: new Date().toISOString().replace("T", " ").slice(0, 19),
      year: meta.year,
      month: meta.month,
      monthName: meta.monthName,
      totalDays: meta.totalDays,
    },
    sbus,
  };
}

app.get("/api/months", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await supabaseMonthsData());
  } catch (err) {
    res.status(502).json({ error: String(err && err.message ? err.message : err) });
  }
});

app.get("/api/dwh", async (req, res) => {
  try {
    const meta = resolveMonth(req.query);
    const snapshot = await supabaseSnapshotData(meta);
    res.setHeader("Cache-Control", "no-store");
    res.json(snapshot);
  } catch (err) {
    res.status(502).json({ error: String(err && err.message ? err.message : err) });
  }
});

// ---- remote MCP server (Streamable HTTP, stateless JSON-RPC) ----
const MCP_TOOLS = [
  {
    name: "list_months",
    description: "List every month that has production data in the DWH (newest first).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_snapshot",
    description: "Return the full pacing dashboard snapshot for a month (targets + day-by-day KPIs for every SBU).",
    inputSchema: {
      type: "object",
      properties: {
        month: { type: "string", description: "Month as YYYY-MM (e.g. 2026-08). Omit for the current month." },
      },
      required: [],
    },
  },
  {
    name: "get_sbu",
    description: "Return a single SBU's targets and day-by-day log for a month.",
    inputSchema: {
      type: "object",
      properties: {
        month: { type: "string", description: "Month as YYYY-MM (e.g. 2026-08). Omit for the current month." },
        sbu: { type: "string", description: "SBU code: AEFML, AAFL, FAL, MRML, ACCL, APFIL, AIL" },
      },
      required: ["sbu"],
    },
  },
  {
    name: "get_sbu_supabase",
    description: "Return a single SBU's KPI targets and metadata from Supabase (independent of DWH tunnel).",
    inputSchema: {
      type: "object",
      properties: {
        month: { type: "string", description: "Month as YYYY-MM (e.g. 2026-08). Omit for current month." },
        sbu: { type: "string", description: "SBU code: AEFML, AAFL, FAL, MRML, ACCL, APFIL, AIL" },
      },
      required: ["month", "sbu"],
    },
  },
];

async function callMcpTool(name, args) {
  if (name === "list_months") return await getMonthsData();
  if (name === "get_snapshot") {
    const meta = resolveMonth({ month: args && args.month });
    return await getSnapshotData(meta);
  }
  if (name === "get_sbu") {
    const meta = resolveMonth({ month: args && args.month });
    const snap = await getSnapshotData(meta);
    const want = String(args && args.sbu || "").toUpperCase();
    const sbu = (snap.sbus || []).find(s => String(s.display).toUpperCase() === want);
    if (!sbu) throw new Error("SBU not found: " + (args && args.sbu) + ". Available: " + (snap.sbus || []).map(s => s.display).join(", "));
    return sbu;
  }
  if (name === "get_sbu_supabase") {
    const month = args && args.month ? args.month : resolveMonth({}).monthName;
    const sbu = String(args && args.sbu || "").toUpperCase();
    const { supabase_anon_key } = process.env;
    const res = await fetch(`https://${process.env.SUPABASE_PROJECT_REF}.supabase.co/rest/v1/ACCL_KPI_TARGET?month=eq.${month}&sbu=eq.${sbu}`, {
      headers: { Authorization: `Bearer ${supabase_anon_key}` },
    });
    if (!res.ok) throw new Error("Supabase query failed: " + res.status);
    const rows = await res.json();
    if (!rows || rows.length === 0) throw new Error("No Supabase data for month=" + month + " sbu=" + sbu);
    const r = rows[0];
    return {
      sbu,
      month,
      targets: {
        cap_util: Number(r.cap_util_target),
        oee: Number(r.oee_target),
        Yeild: Number(r.Yeild_target),
        waste: Number(r.waste_target),
        "5s_score": Number(r[\"5s_score_target\"]),
        kaizen: Number(r.kaizen_target),
        kaizen_savings: Number(r.kaizen_savings_target),
        training: Number(r.training_target),
        manpower: Number(r.manpower_target),
        project: Number(r.project_target),
      },
    };
  }
  throw new Error("Unknown tool: " + name);
}

function mcpError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleMcpMessage(msg) {
  const id = msg && msg.id;
  const method = msg && msg.method;
  if (!method) return mcpError(id, -32600, "Invalid Request");
  if (method.startsWith("notifications/")) return null;

  switch (method) {
    case "initialize": {
      const protocolVersion = (msg.params && msg.params.protocolVersion) || "2025-06-18";
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "pacing-dashboard-mcp", version: "1.0.0" },
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
    case "tools/call": {
      const name = msg.params && msg.params.name;
      const args = (msg.params && msg.params.arguments) || {};
      try {
        const data = await callMcpTool(name, args);
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(data) }], isError: false } };
      } catch (e) {
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(e && e.message ? e.message : e) }], isError: true } };
      }
    }
    default:
      return mcpError(id, -32601, "Method not found: " + method);
  }
}

function mcpCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
}

app.options("/mcp", (req, res) => { mcpCors(res); return res.status(204).end(); });

app.post("/mcp", async (req, res) => {
  mcpCors(res);
  res.setHeader("Content-Type", "application/json");
  try {
    if (Array.isArray(req.body)) {
      const results = [];
      for (const m of req.body) {
        const r = await handleMcpMessage(m);
        if (r) results.push(r);
      }
      return res.json(results.length === 1 ? results[0] : results);
    }
    const r = await handleMcpMessage(req.body);
    if (r === null) return res.status(202).end();
    return res.json(r);
  } catch (err) {
    return res.status(500).json(mcpError(null, -32603, String(err && err.message ? err.message : err)));
  }
});

app.get("/mcp", (req, res) => {
  mcpCors(res);
  res.status(405).json(mcpError(null, -32600, "This MCP endpoint is Streamable HTTP (POST only)."));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === "IPv4" && !ni.internal) addrs.push(ni.address);
    }
  }
  console.log(`Pacing dashboard running at http://localhost:${PORT}`);
  for (const a of addrs) console.log(`  LAN: http://${a}:${PORT}`);
});

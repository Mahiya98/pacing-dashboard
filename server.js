import express from "express";
import sql from "mssql";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(__dirname, ".env")); } catch {}

const DB_CONFIG = {
  server: process.env.DWH_SERVER || "203.202.241.211",
  port: Number(process.env.DWH_PORT) || 1433,
  user: process.env.DWH_USER || "mcp_user",
  password: process.env.DWH_PASSWORD || "",
  database: process.env.DWH_DATABASE || "DWH",
  options: { encrypt: false, trustServerCertificate: false },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
};

const BUS = [
  { display: "AEFML", dwhSbu: "AEL", dwhBuId: 144 },
  { display: "AAFL", dwhSbu: "AAFL", dwhBuId: 232 },
  { display: "FAL", dwhSbu: "FAL", dwhBuId: 189 },
  { display: "MRML", dwhSbu: "HRML", dwhBuId: 188 },
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
app.use(express.static(path.join(__dirname, "public")));

let cache = { key: null, value: null, at: 0 };
const TTL_MS = 15000;

app.get("/api/dwh", async (req, res) => {
  const meta = resolveMonth(req.query);
  const force = req.query.refresh === "1";
  const key = JSON.stringify(meta);
  const now = Date.now();
  if (!force && cache.key === key && now - cache.at < TTL_MS) {
    return res.json(cache.value);
  }
  try {
    const snapshot = await loadSnapshot(meta);
    cache = { key, value: snapshot, at: Date.now() };
    res.setHeader("Cache-Control", "no-store");
    res.json(snapshot);
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
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

import React, { useState, useMemo, useEffect, useRef } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell,
  ReferenceLine, ScatterChart, Scatter, LineChart, Line, Legend,
} from "recharts";

// ─── Enexor Design System ───
const COLORS = {
  bg: "#0b1121", panel: "#0f172a", card: "#131d32", cardBorder: "#1e293b",
  panelBorder: "#1a2540", accent: "#22c55e", accentDim: "#16a34a",
  white: "#f1f5f9", textMuted: "#94a3b8", textDim: "#64748b",
  red: "#ef4444", amber: "#f59e0b", cyan: "#06b6d4", purple: "#a78bfa",
  blue: "#3b82f6",
};

// ─── Sorbent Database (MCS §4) ───
const SORBENTS = {
  "13X": {
    name: "Zeolite 13X",
    dq_table: [[120, 0.9], [150, 1.5], [180, 2.1], [200, 2.35], [250, 2.55], [300, 2.65]],
    q_ads: 2.7, Cp_s: 920, rho_p: 1100, eps: 0.37, d_p_default: 2.0,
    T_regen_max: 350, dH_ads: 36000, D_eff: 1e-7,
    cost: 5, life: 7, q_H2O_max: 12,
    hum_table: [[10, 1.0], [20, 0.85], [40, 0.65], [60, 0.40], [80, 0.20]],
  },
  "CALF-20": {
    name: "CALF-20 (MOF)",
    dq_table: [[100, 0.6], [120, 1.1], [140, 1.5], [150, 1.7], [170, 1.85], [200, 1.95]],
    q_ads: 2.0, Cp_s: 800, rho_p: 900, eps: 0.40, d_p_default: 2.5,
    T_regen_max: 200, dH_ads: 38000, D_eff: 5e-8,
    cost: 25, life: 10, q_H2O_max: 2,
    hum_table: [[10, 1.0], [20, 1.0], [40, 0.95], [60, 0.80], [80, 0.60]],
  },
};

const SCENARIOS = {
  conservative: { sorbent: "13X", D_col: 0.80, L_bed: 0.90, N_col: 6, N_ads_target: 3, T_regen: 250, RH_feed: 30, Q_avail: 250, t_regen: 22, t_cool: 14, cool_air: 3.0, P_elec: 0.12 },
  base: { sorbent: "13X", D_col: 0.85, L_bed: 0.90, N_col: 6, N_ads_target: 3, T_regen: 200, RH_feed: 15, Q_avail: 250, t_regen: 18, t_cool: 12, cool_air: 3.0, P_elec: 0.08 },
  optimistic: { sorbent: "CALF-20", D_col: 0.90, L_bed: 1.00, N_col: 6, N_ads_target: 3, T_regen: 150, RH_feed: 10, Q_avail: 300, t_regen: 15, t_cool: 10, cool_air: 3.5, P_elec: 0.05 },
};

// ─── Helpers ───
const interp = (table, x) => {
  if (x <= table[0][0]) return table[0][1];
  if (x >= table[table.length - 1][0]) return table[table.length - 1][1];
  for (let i = 0; i < table.length - 1; i++) {
    const [x0, y0] = table[i], [x1, y1] = table[i + 1];
    if (x >= x0 && x <= x1) return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }
  return table[table.length - 1][1];
};

const fmt$ = (v) => {
  if (v == null || isNaN(v)) return "—";
  const a = Math.abs(v), s = v < 0 ? "-" : "";
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}K`;
  return `${s}$${a.toFixed(0)}`;
};

// ─── Model Engine (MCS v1.0-R2 §6) ───
function runModel(inp) {
  const S = SORBENTS[inp.sorbent];
  const warnings = [];
  // Guard: adsorbing columns must be strictly less than total (prevents negative cycle time)
  const N_ads = Math.max(1, Math.min(inp.N_ads_target, inp.N_col - 1));
  if (inp.N_ads_target >= inp.N_col) {
    warnings.push({ t: `Columns adsorbing (${inp.N_ads_target}) must be less than total (${inp.N_col}).`, fix: `Auto-clamped to ${N_ads}`, c: "amber" });
  }

  // Step 1: Site correction
  const P_atm = 101325 * Math.pow(1 - 2.25577e-5 * inp.h_alt, 5.25588);
  const T_feed_K = inp.T_feed + 273.15;
  const rho_air = P_atm / (287 * T_feed_K);
  const P_CO2 = (inp.y_CO2 / 100) * P_atm;
  const f_P = Math.min(1.2, Math.max(0.5, Math.pow(P_CO2 / 6080, 0.6)));

  // Step 2: Working capacity
  const dq_dry = interp(S.dq_table, inp.T_regen);
  const f_hum = interp(S.hum_table, inp.RH_feed);
  const dq = dq_dry * f_P * f_hum;
  if (dq < 0.3) warnings.push({ t: `Working capacity ${dq.toFixed(2)} mol/kg is very low.`, fix: "Raise T_regen or cut feed RH", c: "red" });
  if (inp.T_regen > S.T_regen_max) warnings.push({ t: `T_regen ${inp.T_regen}°C exceeds ${S.name} limit (${S.T_regen_max}°C).`, fix: `Set T_regen ≤ ${S.T_regen_max}°C`, c: "red" });

  // Step 3: Dew point
  const alpha = Math.log(inp.RH_feed / 100) + 17.625 * inp.T_feed / (243.04 + inp.T_feed);
  const T_dp = 243.04 * alpha / (17.625 - alpha);

  // Step 4: Bed mass
  const A_col = Math.PI / 4 * inp.D_col ** 2;
  const V_bed = A_col * inp.L_bed;
  const rho_bed = S.rho_p * (1 - S.eps);
  const m_sorbent_col = rho_bed * V_bed;
  const m_sorbent_total = m_sorbent_col * inp.N_col;

  // Steps 5-7: Enforced schedule, capacity vs feed limit, recovery
  const t_ads = (inp.t_regen + inp.t_cool) * N_ads / (inp.N_col - N_ads);
  const t_cycle = t_ads + inp.t_regen + inp.t_cool;

  const CO2_cap = m_sorbent_col * dq * 0.044;
  const MW_mix = (inp.y_CO2 / 100) * 44 + (1 - inp.y_CO2 / 100) * 28.8;
  const w_CO2 = (inp.y_CO2 / 100) * 44 / MW_mix;
  const mdot_CO2 = inp.m_feed * w_CO2;
  const CO2_feed_cycle = (mdot_CO2 / N_ads) * t_ads * 60;
  const CO2_per_cycle = Math.min(CO2_cap, CO2_feed_cycle * 0.95);
  const recovery = CO2_feed_cycle > 0 ? CO2_per_cycle / CO2_feed_cycle * 100 : 0;
  const feed_limited = CO2_cap > CO2_feed_cycle * 0.95;
  if (feed_limited) warnings.push({ t: `Beds oversized for feed — recovery-capped. Idle capital.`, fix: "Consider smaller beds", c: "amber" });
  if (recovery < 90) warnings.push({ t: `Recovery ${recovery.toFixed(0)}% below CRADA 90% target.`, fix: "Increase bed mass or N_ads", c: "amber" });

  // Step 8: Throughput
  const CO2_tpd = CO2_per_cycle * (1440 / t_cycle) * inp.N_col / 1000;
  const CO2_tpy = CO2_tpd * 365 * inp.f_avail;

  // Step 9: Velocity
  const v_sup = (inp.m_feed / N_ads) / (rho_air * A_col);
  if (v_sup > 1.0) warnings.push({ t: `Face velocity ${v_sup.toFixed(2)} m/s — fluidization risk.`, fix: `Increase D_col to ≥ ${(inp.D_col * Math.sqrt(v_sup / 0.6)).toFixed(2)} m`, c: "red" });
  else if (v_sup > 0.65) warnings.push({ t: `Face velocity ${v_sup.toFixed(2)} m/s is elevated.`, fix: "Consider larger D_col", c: "amber" });

  // Step 10: MTZ
  const r_p = inp.d_p / 2000;
  const k_LDF = 15 * S.D_eff / (r_p * r_p);
  const L_MTZ = v_sup / k_LDF;
  const f_MTZ = L_MTZ / inp.L_bed;
  if (f_MTZ > 0.5) warnings.push({ t: `MTZ is ${(f_MTZ * 100).toFixed(0)}% of bed — breakthrough likely.`, fix: `Extend L_bed to ≥ ${(L_MTZ / 0.3).toFixed(2)} m`, c: "red" });
  else if (f_MTZ > 0.3) warnings.push({ t: `MTZ margin thin (${(f_MTZ * 100).toFixed(0)}%).`, fix: "Extend L_bed", c: "amber" });

  // Step 11: dP + feed blower
  const d_p_m = inp.d_p / 1000, eps = S.eps, mu = 1.85e-5;
  const dP_bed = ((150 * mu * v_sup * (1 - eps) ** 2) / (d_p_m ** 2 * eps ** 3)
    + (1.75 * rho_air * v_sup ** 2 * (1 - eps)) / (d_p_m * eps ** 3)) * inp.L_bed;
  const dP_sys = dP_bed * inp.f_dP_system;
  const Q_vol = inp.m_feed / rho_air;
  const W_blower = Q_vol * dP_sys / inp.eta_blower / 1000;

  // Step 12: Closed-loop regen energy
  const Q_sens = m_sorbent_col * S.Cp_s * (inp.T_regen - inp.T_feed);
  const Q_des = m_sorbent_col * dq * S.dH_ads;
  const m_steel = Math.PI * inp.D_col * inp.L_bed * 0.006 * 7800;
  const Q_ves = m_steel * 500 * (inp.T_regen - inp.T_feed);
  const Q_loss = 0.10 * (Q_sens + Q_des + Q_ves);
  const Q_regen_cycle = (Q_sens + Q_des + Q_ves + Q_loss) / inp.eta_HX_loop;
  const Q_regen_rate = Q_regen_cycle / (inp.t_regen * 60) / 1000;
  const N_regen = Math.ceil(inp.N_col * inp.t_regen / t_cycle);
  const Q_regen_total = Q_regen_rate * N_regen;
  const W_loop = inp.W_loop_blower * N_regen;
  const rev_therm_forgone = Q_regen_total * 8760 * inp.f_avail * inp.R_therm_opp;
  if (Q_regen_total > inp.Q_avail) warnings.push({ t: `Regen needs ${Q_regen_total.toFixed(0)} kW > budget ${inp.Q_avail} kW.`, fix: "Raise Q_avail, drop T_regen, or shrink beds", c: "red" });
  else if (Q_regen_total > inp.Q_avail * 0.9) warnings.push({ t: `Regen uses ${(Q_regen_total / inp.Q_avail * 100).toFixed(0)}% of thermal budget.`, fix: "Little headroom", c: "amber" });

  // Step 13: Purity (mass balance, closed loop)
  const V_void = A_col * inp.L_bed * eps;
  const m_void = V_void * rho_air;
  const m_inert = m_void * (1 - w_CO2);
  const q_H2O = S.q_H2O_max * Math.sqrt(inp.RH_feed / 100) * (1 - f_hum);
  const m_H2O = m_sorbent_col * q_H2O * 0.018 * inp.f_H2O_carry;
  const purity = CO2_per_cycle / (CO2_per_cycle + m_inert + m_H2O) * 100;
  if (purity < inp.y_target) warnings.push({ t: `Est. purity ${purity.toFixed(0)}% below ${inp.y_target}% target.`, fix: "Reduce RH or increase bed vs void volume", c: "amber" });

  // Step 14: Cooling (dedicated cooling-air fan, decoupled from feed; 40°C air rise)
  const Q_cool = (m_sorbent_col * S.Cp_s + m_steel * 500) * (inp.T_regen - inp.T_feed);
  const mdot_cool = inp.cool_air;
  const t_cool_req = inp.f_cool_corr * Q_cool / (mdot_cool * 1005 * 40) / 60;
  if (t_cool_req > inp.t_cool * 1.5) warnings.push({ t: `Severe cooling bottleneck: needs ${t_cool_req.toFixed(1)} min vs ${inp.t_cool} allocated.`, fix: `Raise cooling air flow or shorten/shrink beds`, c: "red" });
  else if (t_cool_req > inp.t_cool) warnings.push({ t: `Cooling needs ${t_cool_req.toFixed(1)} min but ${inp.t_cool} min allocated.`, fix: `Raise t_cool to ${Math.ceil(t_cool_req)} min or increase cooling air`, c: "amber" });

  // Step 15: Specific energy (uses AVERAGE loop power for consistency with OPEX)
  const W_loop_avg = inp.W_loop_blower * inp.N_col * inp.t_regen / t_cycle;
  const W_total_avg = W_blower + W_loop_avg + 5;
  const W_total_peak = W_blower + W_loop + 5;
  const E_elec = CO2_tpy > 0 ? W_total_avg * 8760 * inp.f_avail / CO2_tpy : 0;
  const E_therm = CO2_tpy > 0 ? Q_regen_total * 8760 * inp.f_avail / CO2_tpy : 0;

  // Step 16: Container
  const clearance = inp.D_col + 0.30;
  const col_height = inp.L_bed + 0.50;
  const fits_h = col_height <= 2.39;
  let fits = fits_h && (inp.N_col * clearance <= 12.03) && (clearance <= 2.35);
  if (!fits && fits_h) {
    const cpr = Math.ceil(inp.N_col / 2);
    fits = (cpr * clearance <= 12.03) && (2 * clearance <= 2.35);
  }
  if (!fits) warnings.push({ t: `Does not fit 40ft ISO container.`, fix: fits_h ? "Reduce D_col or N_col" : "L_bed must be ≤ 1.89 m", c: "red" });

  // Step 17: CAPEX
  const Q_cool_feed = inp.m_feed * 1005 * (275 - inp.T_feed) / 1000;
  const cx = {
    sorbent: m_sorbent_total * inp.C_sorbent,
    vessels: Math.PI * inp.D_col * (inp.L_bed + 0.4) * inp.N_col * inp.C_vessel_rate,
    piping: 3500 * inp.N_col + 5000,
    valves: inp.C_valve_col * inp.N_col,
    blower: 5000 + 400 * W_blower,
    cooler: 5000 + 100 * Q_cool_feed,
    regen_loop: 12000 + 60 * Q_regen_total + 2500 * inp.N_col,
    controls: 15000 + 2500 * inp.N_col,
    analyzer: 8000,
    container: 12000,
  };
  const C_equip = Object.values(cx).reduce((s, v) => s + v, 0);
  const CAPEX_total = C_equip * 1.35;

  // Step 18: OPEX (W_loop_avg / W_total_avg from Step 15)
  const ox = {
    electricity: W_total_avg * 8760 * inp.f_avail * inp.P_elec,
    "thermal opp cost": Q_regen_total * 8760 * inp.f_avail * inp.R_therm_opp,
    sorbent: m_sorbent_total * inp.C_sorbent / S.life,
    valves: 1500 * inp.N_col,
    calibration: 2000 + 500 * inp.N_col,
    maintenance: C_equip * 0.03,
    condensate: 500 * inp.N_col,
  };
  const OPEX_total = Object.values(ox).reduce((s, v) => s + v, 0);

  // Step 19: LCCC
  const r = inp.r_disc / 100, N = inp.T_project;
  const CRF = r * Math.pow(1 + r, N) / (Math.pow(1 + r, N) - 1);
  const LCCC = CO2_tpy > 0 ? (CAPEX_total * CRF + OPEX_total) / CO2_tpy : Infinity;

  return {
    P_atm, rho_air, P_CO2, f_P, dq_dry, f_hum, dq, T_dp,
    A_col, m_sorbent_col, m_sorbent_total, t_ads, t_cycle,
    CO2_cap, CO2_feed_cycle, CO2_per_cycle, recovery, feed_limited,
    CO2_tpd, CO2_tpy, v_sup, f_MTZ, L_MTZ, dP_bed, dP_sys, W_blower, W_loop, W_total_avg, W_total_peak,
    Q_sens, Q_des, Q_ves, Q_loss, Q_regen_rate, N_regen, Q_regen_total,
    rev_therm_forgone, purity, m_inert, m_H2O, t_cool_req, E_elec, E_therm, fits,
    cx, C_equip, CAPEX_total, ox, OPEX_total, LCCC, warnings,
  };
}

// Pareto eval
function evalConfig(base, D, L, N, RH) {
  const r = runModel({ ...base, D_col: D, L_bed: L, N_col: N, RH_feed: RH, N_ads_target: Math.min(base.N_ads_target, N - 1) });
  const feasible = r.fits && r.v_sup <= 1.0 && r.f_MTZ <= 0.5 && r.Q_regen_total <= base.Q_avail && r.purity >= base.y_target - 5;
  const clean = feasible && r.v_sup <= 0.65 && r.f_MTZ <= 0.35 && r.purity >= base.y_target && r.recovery >= 55;
  return { tpd: r.CO2_tpd, lccc: r.LCCC, feasible, clean, D, L, N, RH };
}

// ─── UI Components ───
function SliderInput({ label, value, onChange, min, max, step, unit = "", decimals = 2, prefix = "", note, redAbove, info }) {
  const [ed, setEd] = useState(false); const [ev, setEv] = useState("");
  const pct = ((value - min) / (max - min)) * 100;
  const redPct = redAbove ? ((redAbove - min) / (max - min)) * 100 : null;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
        <span style={{ fontSize: 11, color: COLORS.textMuted }}>{label}{info && <InfoTip id={info} />}</span>
        {ed ? (
          <input autoFocus value={ev} onChange={e => setEv(e.target.value)}
            onBlur={() => { setEd(false); const n = parseFloat(ev); if (!isNaN(n)) onChange(Math.min(max, Math.max(min, n))); }}
            onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }}
            style={{ width: 70, background: COLORS.bg, border: `1px solid ${COLORS.accent}`, borderRadius: 3, color: COLORS.white, textAlign: "right", fontSize: 12, padding: "1px 4px", fontFamily: "'JetBrains Mono', monospace" }} />
        ) : (
          <span onClick={() => { setEd(true); setEv(String(value)); }} style={{ fontSize: 12, color: COLORS.white, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace", borderBottom: `1px dashed ${COLORS.textDim}` }}>
            {prefix}{value.toFixed(decimals)} <span style={{ color: COLORS.textDim, fontSize: 10 }}>{unit}</span>
          </span>
        )}
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width: "100%", height: 4, appearance: "none", borderRadius: 2, outline: "none", cursor: "pointer",
          background: redPct != null
            ? `linear-gradient(to right, ${COLORS.accent} 0%, ${COLORS.accent} ${pct}%, ${COLORS.panelBorder} ${pct}%, ${COLORS.panelBorder} ${redPct}%, rgba(239,68,68,0.35) ${redPct}%, rgba(239,68,68,0.35) 100%)`
            : `linear-gradient(to right, ${COLORS.accent} 0%, ${COLORS.accent} ${pct}%, ${COLORS.panelBorder} ${pct}%, ${COLORS.panelBorder} 100%)` }} />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8, color: COLORS.textDim }}>
        <span>{min}</span>{note && <span style={{ color: COLORS.cyan }}>{note}</span>}<span>{max}</span>
      </div>
    </div>
  );
}

function MetricCard({ label, value, unit = "", status, decimals = 1, tip, sub }) {
  const color = status === "ok" ? COLORS.accent : status === "warn" ? COLORS.amber : status === "error" ? COLORS.red : COLORS.white;
  let display = value;
  if (typeof value === "number") display = isFinite(value) ? value.toFixed(decimals) : "—";
  return (
    <div title={tip} style={{ background: COLORS.card, borderRadius: 6, border: `1px solid ${COLORS.cardBorder}`, padding: "8px 6px", textAlign: "center" }}>
      <div style={{ fontSize: 8.5, color: COLORS.textDim, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3, whiteSpace: "nowrap" }}>{label} {tip && <span style={{ opacity: 0.5, cursor: "help" }}>ⓘ</span>}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace" }}>{display}<span style={{ fontSize: 10, color: COLORS.textDim, marginLeft: 2 }}>{unit}</span></div>
      {sub && <div style={{ fontSize: 8.5, color: COLORS.textDim, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Accordion({ title, icon, children, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen || false);
  return (
    <div style={{ marginBottom: 6 }}>
      <div onClick={() => setOpen(!open)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px", background: COLORS.card, borderRadius: 4, cursor: "pointer", border: `1px solid ${COLORS.cardBorder}` }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: COLORS.accent, textTransform: "uppercase", letterSpacing: "0.04em" }}>{icon} {title}</span>
        <span style={{ color: COLORS.textDim, fontSize: 10 }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && <div style={{ padding: "8px 6px 2px" }}>{children}</div>}
    </div>
  );
}

// ─── Glossary of plain-language explanations ───
const INFO = {
  // Feed & Site
  RH_feed: "Relative humidity of the gas entering the beds. Water competes with CO₂ for adsorption sites — the single biggest performance risk for zeolite 13X. Above ~20% RH, 13X capacity collapses. The dew point readout tells you how much actual water is present.",
  y_CO2: "CO₂ concentration in the BioCHP exhaust. Air-fired combustion gives ~5–7%. Higher concentration means higher partial pressure, which improves working capacity.",
  h_alt: "Site elevation. INL is at ~1,500 m. Thinner air reduces both gas density (raising face velocity) and CO₂ partial pressure (lowering capacity by ~10% here). The tool corrects for all three effects.",
  // Geometry
  D_col: "Inner diameter of each adsorption column. Wider columns lower the gas face velocity (good — avoids fluidization) but hold more sorbent, increasing cost and the heat that must be removed each cycle.",
  L_bed: "Length of the packed sorbent bed. Longer beds capture more CO₂ and give a bigger safety margin against breakthrough, but cost more and raise pressure drop. Above 1.89 m the column won't fit standing up in a 40ft container.",
  N_col: "Total number of columns. More columns allow smoother staggered cycling (some always adsorbing while others regenerate and cool) but add valves, piping, and cost.",
  d_p: "Sorbent pellet diameter. Smaller pellets give faster mass transfer (sharper, shorter MTZ) but much higher pressure drop. Typical TSA pellets are 2–3 mm.",
  // Cycle
  N_ads_target: "How many columns adsorb simultaneously. More adsorbing columns split the feed flow, lowering face velocity. The tool auto-computes adsorption time so exactly this many are always adsorbing (continuous operation).",
  t_regen: "Time spent heating the bed to drive off captured CO₂. Longer regen means lower peak heat demand but a longer overall cycle.",
  t_cool: "Time spent cooling the bed back down before the next adsorption step. Cooling is often the rate-limiting step because the bed holds a lot of heat — watch the 'needs X min' note.",
  T_regen: "Temperature the bed is heated to during regeneration. Higher temperature releases more CO₂ (higher working capacity and purity) but costs more energy, slows cooling, and stresses the sorbent. 13X tolerates 350°C; CALF-20 only 200°C.",
  // Thermal
  Q_avail: "How much of the BioCHP's 400 kW of heat you allocate to running the TSA regeneration. Every kW used here is a kW you can't sell as thermal energy — so this is a heat-vs-capture economic tradeoff, not a fixed limit.",
  // Closed-loop
  eta_HX_loop: "Effectiveness of the heat exchanger in the closed-loop regeneration circuit — how efficiently BioCHP exhaust heat transfers into the recirculating CO₂ loop. Higher is better.",
  W_loop_blower: "Electrical power to circulate CO₂ around the closed regeneration loop while a column is being regenerated.",
  f_H2O_carry: "Fraction of desorbed water that slips past the loop condenser into the product CO₂. Higher carryover lowers purity. Keeping the condenser cold minimizes this.",
  // Operating
  eta_blower: "Combined mechanical and motor efficiency of the main feed blower. Affects how much electricity it takes to push exhaust through the beds.",
  cool_air: "Airflow from the dedicated cooling fan used to cool a bed after regeneration. More airflow cools faster, removing the cooling bottleneck, at the cost of a bigger fan.",
  f_dP_system: "Multiplier that accounts for pressure losses beyond the packed bed itself — valves, distributors, screens, and manifolds. These typically add 50–100% on top of the bed pressure drop.",
  y_target: "The CO₂ purity you want out of the TSA system. The CRADA needs >99% overall, but that final polish happens downstream — the TSA beds only need to reach ~85%.",
  // Economics
  C_sorbent: "Cost per kilogram of sorbent. Zeolite 13X is cheap (~$5/kg); CALF-20 is currently $10–25/kg but water-tolerant. Drives both upfront cost and periodic replacement.",
  R_therm_opp: "The value of one kWh of BioCHP heat if sold to the customer instead of used for regeneration. This is the 'opportunity cost' of heat — it makes every kW of regen energy show up as lost revenue.",
  C_vessel_rate: "Fabrication cost per square meter of vessel shell surface. Carbon steel is cheaper; stainless is $1,800–2,500/m².",
  r_disc: "Discount rate used to annualize the upfront capital cost when computing levelized cost. Roughly your cost of capital or hurdle rate.",
  // Metrics
  m_recovery: "Percentage of the CO₂ in the feed that actually gets captured. CRADA target is >90%. At this feed rate, working capacity limits recovery to ~70% unless the feed is very dry.",
  m_lccc: "Levelized Cost of Carbon Capture — the all-in cost per ton of CO₂, combining annualized capital and yearly operating cost. Compare against the ~$85 (45Q credit) + offtake revenue you'd earn per ton.",
  m_purity: "Estimated CO₂ purity leaving the TSA system, from a mass balance of captured CO₂ vs. leftover inert gas and water. Labeled 'estimated' because real purity needs bench confirmation.",
  m_mtz: "Mass Transfer Zone — the moving band inside the bed where CO₂ is actively being adsorbed. If it reaches the bed outlet (over ~30–50% of bed length), CO₂ breaks through and purity drops.",
  m_regen: "Total heat demand to regenerate the beds. Must stay under the thermal budget you allocated. Shown as used/budget.",
  m_dq: "Working capacity — the amount of CO₂ (per kg of sorbent) actually captured and released each cycle. It's the dry-basis capacity reduced by altitude (f_P) and humidity (f_hum). The bigger it is, the less sorbent you need.",
  m_velocity: "Superficial gas velocity through the bed. Too high (>0.65 m/s) risks lifting/fluidizing the pellets and channeling; too low wastes bed volume. Sweet spot is 0.2–0.6 m/s.",
  pareto: "Each dot is one complete bed design (diameter, length, column count, humidity). Green = meets all targets, amber = works with warnings, red = infeasible. The blue frontier line marks the best possible tradeoffs — designs where you can't capture more CO₂ without paying more per ton. Your current design is the white diamond. Click near the frontier to find the cheapest design at your target throughput.",
};

// ─── Info Tooltip (click to toggle — works on mobile) ───
function InfoTip({ id }) {
  const [open, setOpen] = useState(false);
  const text = INFO[id];
  if (!text) return null;
  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <span onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        style={{ cursor: "help", color: open ? COLORS.accent : COLORS.textDim, fontSize: 11, marginLeft: 3, userSelect: "none" }}>ⓘ</span>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <div style={{ position: "absolute", left: 16, top: -4, zIndex: 41, width: 240,
            background: COLORS.panel, border: `1px solid ${COLORS.accent}55`, borderRadius: 8,
            padding: "10px 12px", fontSize: 11, lineHeight: 1.5, color: COLORS.white,
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
            {text}
          </div>
        </>
      )}
    </span>
  );
}

const tempColor = (T) => {
  const t = Math.min(1, Math.max(0, (T - 40) / 210));
  const r = Math.round(30 + t * 209), g = Math.round(90 - t * 30), b = Math.round(200 - t * 160);
  return `rgb(${r},${g},${b})`;
};

// ─── Animated Bed Schematic ───
function BedSchematic({ inp, res, phase }) {
  const N = inp.N_col;
  const colW = Math.min(90, 480 / N);
  const bedH = 150;
  const stagger = res.t_cycle / N;
  const stateColor = { ADSORB: COLORS.accent, REGEN: COLORS.red, COOL: COLORS.cyan };

  const columns = [];
  for (let i = 0; i < N; i++) {
    const localT = ((phase + i * stagger) % res.t_cycle + res.t_cycle) % res.t_cycle;
    let state, frac, T_bed;
    if (localT < res.t_ads) { state = "ADSORB"; frac = localT / res.t_ads; T_bed = inp.T_feed; }
    else if (localT < res.t_ads + inp.t_regen) { state = "REGEN"; frac = (localT - res.t_ads) / inp.t_regen; T_bed = inp.T_feed + frac * (inp.T_regen - inp.T_feed); }
    else { state = "COOL"; frac = (localT - res.t_ads - inp.t_regen) / inp.t_cool; T_bed = inp.T_regen - frac * (inp.T_regen - inp.T_feed); }
    columns.push({ state, frac, T_bed, i });
  }

  return (
    <svg width="100%" viewBox={`0 0 ${N * (colW + 20) + 20} 230`} style={{ maxHeight: 240 }}>
      {columns.map(c => {
        const x = 20 + c.i * (colW + 20);
        return (
          <g key={c.i}>
            <rect x={x} y={30} width={colW} height={bedH} rx={6} fill={tempColor(c.T_bed)} opacity={0.85} stroke={COLORS.cardBorder} strokeWidth={1.5} />
            {c.state === "ADSORB" && (
              <>
                <rect x={x} y={30 + (1 - c.frac) * bedH} width={colW} height={c.frac * bedH} rx={4} fill={COLORS.accent} opacity={0.35} />
                <rect x={x} y={Math.max(30, 30 + (1 - Math.min(1, c.frac + res.f_MTZ)) * bedH)} width={colW} height={Math.min(res.f_MTZ * bedH, bedH)} fill="url(#mtzGrad)" opacity={0.6} />
                <path d={`M ${x + colW / 2} 195 l 0 15`} stroke={COLORS.accent} strokeWidth={2} markerEnd="url(#arrow)" />
              </>
            )}
            {c.state === "REGEN" && <path d={`M ${x + colW / 2} 25 q ${colW / 2 + 8} ${bedH / 2 + 20} 0 ${bedH + 15}`} fill="none" stroke={COLORS.red} strokeWidth={1.5} strokeDasharray="4 3" opacity={0.8} />}
            <rect x={x} y={8} width={colW} height={15} rx={3} fill={stateColor[c.state]} opacity={0.2} />
            <text x={x + colW / 2} y={19} textAnchor="middle" fill={stateColor[c.state]} fontSize={9} fontWeight={700} fontFamily="'JetBrains Mono', monospace">{c.state}</text>
            <text x={x + colW / 2} y={110} textAnchor="middle" fill="#fff" fontSize={11} fontWeight={700} fontFamily="'JetBrains Mono', monospace">{c.T_bed.toFixed(0)}°C</text>
            <text x={x + colW / 2} y={222} textAnchor="middle" fill={COLORS.textDim} fontSize={9}>Col {c.i + 1}</text>
          </g>
        );
      })}
      <defs>
        <linearGradient id="mtzGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={COLORS.amber} stopOpacity={0} />
          <stop offset="50%" stopColor={COLORS.amber} stopOpacity={0.9} />
          <stop offset="100%" stopColor={COLORS.amber} stopOpacity={0} />
        </linearGradient>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill={COLORS.accent} /></marker>
      </defs>
    </svg>
  );
}

// ─── Cycle Gantt ───
function CycleGantt({ inp, res, phase }) {
  const W = 560, H = inp.N_col * 26 + 20;
  const scale = W / res.t_cycle;
  const stagger = res.t_cycle / inp.N_col;
  return (
    <svg width="100%" viewBox={`0 0 ${W + 60} ${H}`} style={{ maxHeight: H + 10 }}>
      {Array.from({ length: inp.N_col }).map((_, i) => {
        const offset = ((-i * stagger) % res.t_cycle + res.t_cycle) % res.t_cycle;
        const y = 10 + i * 26;
        const segs = [
          { name: "ads", dur: res.t_ads, color: COLORS.accent },
          { name: "regen", dur: inp.t_regen, color: COLORS.red },
          { name: "cool", dur: inp.t_cool, color: COLORS.cyan },
        ];
        let elems = [], t0 = offset;
        for (const s of segs) {
          const start = t0 % res.t_cycle;
          elems.push(<rect key={`${i}-${s.name}`} x={50 + start * scale} y={y} width={Math.min(s.dur, res.t_cycle - start) * scale} height={18} rx={3} fill={s.color} opacity={0.55} />);
          if (start + s.dur > res.t_cycle) elems.push(<rect key={`${i}-${s.name}w`} x={50} y={y} width={(start + s.dur - res.t_cycle) * scale} height={18} rx={3} fill={s.color} opacity={0.55} />);
          t0 += s.dur;
        }
        return (
          <g key={i}>
            <text x={44} y={y + 13} textAnchor="end" fill={COLORS.textMuted} fontSize={10} fontFamily="'JetBrains Mono', monospace">C{i + 1}</text>
            {elems}
          </g>
        );
      })}
      <line x1={50 + (phase % res.t_cycle) * scale} y1={6} x2={50 + (phase % res.t_cycle) * scale} y2={H - 4} stroke="#fff" strokeWidth={1.5} opacity={0.9} />
    </svg>
  );
}

// ─── Main App ───
export default function TSABedSizingApp() {
  const [scenario, setScenario] = useState("base");
  const [inputs, setInputs] = useState({
    sorbent: "13X", m_feed: 0.76, T_feed: 40, RH_feed: 15, y_CO2: 6, h_alt: 1500,
    D_col: 0.85, L_bed: 0.90, N_col: 6, d_p: 2.0,
    N_ads_target: 3, t_regen: 18, t_cool: 12, T_regen: 200,
    eta_HX_loop: 0.75, W_loop_blower: 2, f_H2O_carry: 0.05,
    f_avail: 0.90, eta_blower: 0.70, cool_air: 3.0, f_dP_system: 1.8, f_cool_corr: 1.4,
    Q_avail: 250, y_target: 85,
    P_elec: 0.08, R_therm_opp: 0.027, C_sorbent: 5, C_vessel_rate: 1200, C_valve_col: 7500,
    r_disc: 10, T_project: 20,
  });

  const [phase, setPhase] = useState(0);
  const [playing, setPlaying] = useState(true);
  const raf = useRef();

  const set = (k) => (v) => { setScenario("custom"); setInputs(p => ({ ...p, [k]: v })); };
  const applyScenario = (key) => {
    setScenario(key);
    if (SCENARIOS[key]) {
      const s = SCENARIOS[key];
      setInputs(p => ({ ...p, ...s, C_sorbent: SORBENTS[s.sorbent].cost, d_p: SORBENTS[s.sorbent].d_p_default }));
    }
  };
  const setSorbent = (s) => { setScenario("custom"); setInputs(p => ({ ...p, sorbent: s, C_sorbent: SORBENTS[s].cost, d_p: SORBENTS[s].d_p_default, T_regen: Math.min(p.T_regen, SORBENTS[s].T_regen_max) })); };

  // Load a configuration from a clicked Pareto point
  const loadConfig = (d) => {
    if (!d || d.D == null) return;
    setScenario("custom");
    setInputs(p => ({ ...p, D_col: d.D, L_bed: d.L, N_col: d.N, RH_feed: d.RH, N_ads_target: Math.min(p.N_ads_target, d.N - 1) }));
  };

  const res = useMemo(() => runModel(inputs), [inputs]);

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const tick = (now) => {
      const dt = (now - last) / 1000; last = now;
      setPhase(p => (p + dt * res.t_cycle / 8) % res.t_cycle);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, res.t_cycle]);

  const pareto = useMemo(() => {
    const pts = [];
    for (const D of [0.5, 0.6, 0.7, 0.8, 0.9, 1.0])
      for (const L of [0.8, 1.0, 1.2, 1.5, 1.8, 2.0, 2.5])
        for (const N of [2, 3, 4, 5, 6])
          for (const RH of [10, 20, 30, 40, 60]) {
            const p = evalConfig(inputs, D, L, N, RH);
            if (isFinite(p.lccc) && p.lccc > 0 && p.lccc < 250 && isFinite(p.tpd) && p.tpd > 0.2 && p.tpd <= 6) {
              pts.push({ tpd: +p.tpd.toFixed(3), lccc: +p.lccc.toFixed(1), feasible: p.feasible, clean: p.clean, D, L, N, RH });
            }
          }
    const clean = pts.filter(p => p.clean);
    const warn = pts.filter(p => p.feasible && !p.clean);
    const infeasible = pts.filter(p => !p.feasible);
    const frontier = clean.filter(p => !clean.some(q => q.tpd >= p.tpd && q.lccc <= p.lccc && (q.tpd > p.tpd || q.lccc < p.lccc))).sort((a, b) => a.tpd - b.tpd);
    return { pts, clean, warn, infeasible, frontier };
  }, [inputs.sorbent, inputs.T_regen, inputs.t_regen, inputs.t_cool, inputs.N_ads_target, inputs.Q_avail, inputs.h_alt, inputs.T_feed, inputs.y_CO2, inputs.P_elec, inputs.R_therm_opp, inputs.C_sorbent, inputs.r_disc, inputs.T_project, inputs.y_target, inputs.cool_air, inputs.d_p, inputs.f_avail, inputs.eta_blower, inputs.f_dP_system, inputs.f_cool_corr, inputs.eta_HX_loop, inputs.W_loop_blower, inputs.f_H2O_carry, inputs.C_vessel_rate, inputs.C_valve_col]);

  const sensitivity = useMemo(() => {
    const params = [
      { key: "D_col", label: "Column Diameter" }, { key: "L_bed", label: "Bed Length" },
      { key: "T_regen", label: "Regen Temp" }, { key: "RH_feed", label: "Feed Humidity" },
      { key: "C_sorbent", label: "Sorbent Cost" }, { key: "P_elec", label: "Electricity" },
      { key: "Q_avail", label: "Thermal Budget" }, { key: "f_avail", label: "Availability" },
    ];
    const b = res.LCCC;
    return params.map(p => {
      const lo = runModel({ ...inputs, [p.key]: inputs[p.key] * 0.8 }).LCCC;
      const hi = runModel({ ...inputs, [p.key]: inputs[p.key] * 1.2 }).LCCC;
      return { label: p.label, lo: isFinite(lo) ? lo - b : 0, hi: isFinite(hi) ? hi - b : 0, range: Math.abs((isFinite(hi) ? hi : b) - (isFinite(lo) ? lo : b)) };
    }).sort((a, b2) => b2.range - a.range);
  }, [inputs, res.LCCC]);

  const dqCurves = useMemo(() => {
    const S = SORBENTS[inputs.sorbent];
    const rows = [];
    const [tMin, tMax] = [S.dq_table[0][0], S.dq_table[S.dq_table.length - 1][0]];
    for (let T = tMin; T <= tMax; T += 10) {
      const row = { T };
      for (const RH of [10, 20, 40, 60]) row[`RH${RH}`] = +(interp(S.dq_table, T) * res.f_P * interp(S.hum_table, RH)).toFixed(3);
      rows.push(row);
    }
    return rows;
  }, [inputs.sorbent, res.f_P]);

  const S = SORBENTS[inputs.sorbent];
  const capexData = Object.entries(res.cx).map(([k, v]) => ({ name: k.replace("_", " "), value: v }));
  const opexData = Object.entries(res.ox).map(([k, v]) => ({ name: k, value: v }));
  const energyBreakdown = [
    { name: "Sensible", value: +(res.Q_sens / 1e6).toFixed(1), fill: COLORS.red },
    { name: "Desorption", value: +(res.Q_des / 1e6).toFixed(1), fill: COLORS.amber },
    { name: "Vessel", value: +(res.Q_ves / 1e6).toFixed(1), fill: COLORS.purple },
    { name: "Losses", value: +(res.Q_loss / 1e6).toFixed(1), fill: "#64748b" },
  ];

  const ttip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.cardBorder}`, borderRadius: 6, padding: "8px 12px", fontSize: 11 }}>
        <div style={{ color: COLORS.white, fontWeight: 600, marginBottom: 4 }}>{label}</div>
        {payload.map((p, i) => <div key={i} style={{ color: p.color || COLORS.textMuted }}>{p.name}: {typeof p.value === "number" ? p.value.toFixed(2) : p.value}</div>)}
      </div>
    );
  };

  return (
    <div style={{ background: COLORS.bg, minHeight: "100vh", color: COLORS.white, fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 20px", borderBottom: `1px solid ${COLORS.panelBorder}`, background: COLORS.panel }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <svg width={32} height={32} viewBox="0 0 600 600" fill="none">
            <path d="M21.6,63.5h100.4c21.4,0,41.9,9,56.4,24.8l179.1,200.7-139.5,152.2c-14.5,15.8-35,24.9-56.5,24.9H60.2s162.8-177,162.8-177L21.6,63.5Z" fill="#fff"/>
            <path d="M375.2,269.6l145.1-158.3h-100.4c-21.4,0-41.9,9-56.4,24.8l-55,59.8,66.8,73.7Z" fill="#fff"/>
            <path d="M374.5,309.9l-67.7,73.9,113.7,127.9c14.5,15.8,35,24.9,56.5,24.9h101.4l-203.8-226.6Z" fill="#fff"/>
          </svg>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>TSA Bed Sizing & Economics</div>
            <div style={{ fontSize: 10, color: COLORS.textDim }}>ENEXOR BIOCO₂ · MCS v1.0-R2 · CLOSED-LOOP REGEN</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {["conservative", "base", "optimistic", "custom"].map(s => (
            <button key={s} onClick={() => applyScenario(s)}
              style={{ padding: "5px 14px", borderRadius: 4, border: `1px solid ${scenario === s ? COLORS.accent : COLORS.panelBorder}`, background: scenario === s ? COLORS.accent : "transparent", color: scenario === s ? COLORS.bg : COLORS.textMuted, fontSize: 11, fontWeight: 600, cursor: "pointer", textTransform: "uppercase" }}>
              {s}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", height: "calc(100vh - 56px)" }}>
        {/* LEFT */}
        <div style={{ width: 300, minWidth: 300, overflowY: "auto", borderRight: `1px solid ${COLORS.panelBorder}`, padding: "12px 10px", background: COLORS.panel }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            {Object.keys(SORBENTS).map(s => (
              <button key={s} onClick={() => setSorbent(s)}
                style={{ flex: 1, padding: "8px 4px", borderRadius: 5, cursor: "pointer", fontSize: 11, fontWeight: 700,
                  border: `1px solid ${inputs.sorbent === s ? COLORS.accent : COLORS.cardBorder}`,
                  background: inputs.sorbent === s ? "rgba(34,197,94,0.15)" : COLORS.card,
                  color: inputs.sorbent === s ? COLORS.accent : COLORS.textMuted }}>
                {SORBENTS[s].name}
              </button>
            ))}
          </div>

          <Accordion title="Feed & Site" icon="◉" defaultOpen>
            <SliderInput label="Feed Temperature" value={inputs.T_feed} onChange={set("T_feed")} min={25} max={80} step={1} unit="°C" decimals={0} />
            <SliderInput label="Feed Humidity" value={inputs.RH_feed} onChange={set("RH_feed")} min={5} max={80} step={1} unit="% RH" decimals={0} note={`dew pt ${res.T_dp.toFixed(0)}°C`} info="RH_feed" />
            <SliderInput label="CO₂ Concentration" value={inputs.y_CO2} onChange={set("y_CO2")} min={3} max={15} step={0.5} unit="vol%" decimals={1} info="y_CO2" />
            <SliderInput label="Site Altitude" value={inputs.h_alt} onChange={set("h_alt")} min={0} max={3000} step={100} unit="m" decimals={0} note={`P_CO₂ ${(res.P_CO2/1000).toFixed(1)} kPa`} info="h_alt" />
            <div style={{ fontSize: 9, color: COLORS.textDim, padding: "2px 4px" }}>Feed flow locked: 0.76 kg/s (system max)</div>
          </Accordion>

          <Accordion title="Bed Geometry" icon="▭" defaultOpen>
            <SliderInput label="Column Diameter" value={inputs.D_col} onChange={set("D_col")} min={0.30} max={1.20} step={0.05} unit="m" decimals={2} info="D_col" />
            <SliderInput label="Bed Length" value={inputs.L_bed} onChange={set("L_bed")} min={0.50} max={3.00} step={0.10} unit="m" decimals={2} redAbove={1.89} note="red = exceeds container" info="L_bed" />
            <SliderInput label="Number of Columns" value={inputs.N_col} onChange={v => { const n = Math.round(v); setScenario("custom"); setInputs(p => ({ ...p, N_col: n, N_ads_target: Math.min(p.N_ads_target, n - 1) })); }} min={2} max={6} step={1} unit="" decimals={0} info="N_col" />
            <SliderInput label="Pellet Diameter" value={inputs.d_p} onChange={set("d_p")} min={1.0} max={4.0} step={0.25} unit="mm" decimals={2} info="d_p" />
          </Accordion>

          <Accordion title="Cycle Schedule" icon="⟳">
            <SliderInput label="Columns Adsorbing" value={inputs.N_ads_target} onChange={v => set("N_ads_target")(Math.max(1, Math.min(Math.round(v), inputs.N_col - 1)))} min={1} max={inputs.N_col - 1} step={1} unit="" decimals={0} note={`t_ads auto: ${res.t_ads.toFixed(0)} min`} info="N_ads_target" />
            <SliderInput label="Regen Time" value={inputs.t_regen} onChange={set("t_regen")} min={10} max={45} step={1} unit="min" decimals={0} info="t_regen" />
            <SliderInput label="Cooling Time" value={inputs.t_cool} onChange={set("t_cool")} min={5} max={20} step={1} unit="min" decimals={0} note={`needs ${res.t_cool_req.toFixed(1)} min`} info="t_cool" />
            <SliderInput label="Regen Temperature" value={inputs.T_regen} onChange={set("T_regen")} min={100} max={300} step={5} unit="°C" decimals={0} redAbove={S.T_regen_max < 300 ? S.T_regen_max : undefined} info="T_regen" />
          </Accordion>

          <Accordion title="Thermal Budget" icon="♨">
            <SliderInput label="Thermal Allocated to TSA" value={inputs.Q_avail} onChange={set("Q_avail")} min={0} max={400} step={10} unit="kW" decimals={0} note={`regen uses ${res.Q_regen_total.toFixed(0)} kW`} info="Q_avail" />
            <div style={{ fontSize: 10, color: COLORS.textMuted, padding: 4, background: COLORS.bg, borderRadius: 4 }}>
              Heat sales forgone: <span style={{ color: COLORS.amber, fontFamily: "'JetBrains Mono', monospace" }}>{fmt$(res.rev_therm_forgone)}/yr</span>
            </div>
          </Accordion>

          <Accordion title="Closed-Loop Regen" icon="◌">
            <SliderInput label="Loop HX Effectiveness" value={inputs.eta_HX_loop} onChange={set("eta_HX_loop")} min={0.5} max={0.9} step={0.05} unit="" decimals={2} info="eta_HX_loop" />
            <SliderInput label="Loop Blower Power" value={inputs.W_loop_blower} onChange={set("W_loop_blower")} min={0.5} max={5} step={0.5} unit="kW" decimals={1} info="W_loop_blower" />
            <SliderInput label="H₂O Carryover" value={inputs.f_H2O_carry} onChange={set("f_H2O_carry")} min={0} max={0.2} step={0.01} unit="" decimals={2} info="f_H2O_carry" />
          </Accordion>

          <Accordion title="Operating" icon="⚙">
            <SliderInput label="Availability" value={inputs.f_avail} onChange={set("f_avail")} min={0.70} max={0.99} step={0.01} unit="" decimals={2} />
            <SliderInput label="Blower Efficiency" value={inputs.eta_blower} onChange={set("eta_blower")} min={0.50} max={0.85} step={0.05} unit="" decimals={2} info="eta_blower" />
            <SliderInput label="Cooling Air Flow" value={inputs.cool_air} onChange={set("cool_air")} min={0.5} max={8.0} step={0.5} unit="kg/s" decimals={1} note={`needs ${res.t_cool_req.toFixed(0)} min cool`} info="cool_air" />
            <SliderInput label="System ΔP Factor" value={inputs.f_dP_system} onChange={set("f_dP_system")} min={1.0} max={3.0} step={0.1} unit="×" decimals={1} info="f_dP_system" />
            <SliderInput label="Purity Target (TSA)" value={inputs.y_target} onChange={set("y_target")} min={70} max={95} step={1} unit="%" decimals={0} info="y_target" />
          </Accordion>

          <Accordion title="Economics" icon="◈">
            <SliderInput label="Sorbent Cost" value={inputs.C_sorbent} onChange={set("C_sorbent")} min={2} max={50} step={1} unit="$/kg" decimals={0} prefix="$" info="C_sorbent" />
            <SliderInput label="Electricity Rate" value={inputs.P_elec} onChange={set("P_elec")} min={0.03} max={0.20} step={0.005} unit="$/kWh" decimals={3} prefix="$" />
            <SliderInput label="Thermal Opp. Cost" value={inputs.R_therm_opp} onChange={set("R_therm_opp")} min={0} max={0.10} step={0.001} unit="$/kWh" decimals={3} prefix="$" info="R_therm_opp" />
            <SliderInput label="Vessel Cost Rate" value={inputs.C_vessel_rate} onChange={set("C_vessel_rate")} min={600} max={2500} step={50} unit="$/m²" decimals={0} prefix="$" info="C_vessel_rate" />
            <SliderInput label="Discount Rate" value={inputs.r_disc} onChange={set("r_disc")} min={4} max={20} step={0.5} unit="%" decimals={1} info="r_disc" />
            <SliderInput label="Project Life" value={inputs.T_project} onChange={set("T_project")} min={5} max={30} step={1} unit="yrs" decimals={0} />
          </Accordion>
        </div>

        {/* CENTER */}
        <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 6, marginBottom: 12 }}>
            <MetricCard label="CO₂ Capture" value={res.CO2_tpd} unit="t/d" status={res.CO2_tpd >= 3.5 ? "ok" : res.CO2_tpd >= 2 ? "warn" : "error"} tip="Total capture rate, all columns" />
            <MetricCard label="Recovery" value={res.recovery} unit="%" decimals={0} status={res.recovery >= 90 ? "ok" : res.recovery >= 75 ? "warn" : "error"} tip="CO₂ captured ÷ CO₂ fed — CRADA target >90%" />
            <MetricCard label="LCCC" value={res.LCCC} unit="$/t" decimals={0} status={res.LCCC < 80 ? "ok" : res.LCCC < 120 ? "warn" : "error"} tip="Levelized cost of capture for the TSA capture island only. Compare vs $85 45Q + offtake. NOTE: gas cleaning and pre-treatment (drying, particulate/acid-gas removal) are a separate cost not yet included." />
            <MetricCard label="Purity (est.)" value={res.purity} unit="%" decimals={0} status={res.purity >= inputs.y_target ? "ok" : res.purity >= 75 ? "warn" : "error"} tip="Mass-balance estimate — bench validation required" />
            <MetricCard label="Power (avg)" value={res.W_total_avg} unit="kW" decimals={1} status={res.W_total_avg < 25 ? "ok" : res.W_total_avg < 40 ? "warn" : "error"} sub={`peak ${res.W_total_peak.toFixed(0)} kW`} tip="Feed blower + loop blowers (avg over cycle) + aux. OPEX and specific energy use this average." />
            <MetricCard label="Regen Heat" value={res.Q_regen_total} unit="kW" decimals={0} status={res.Q_regen_total < inputs.Q_avail * 0.75 ? "ok" : res.Q_regen_total <= inputs.Q_avail ? "warn" : "error"} tip="Thermal demand for regeneration" />
            <MetricCard label="Heat Sellable" value={400 - Math.min(400, res.Q_regen_total)} unit="kW" decimals={0} status={(400 - res.Q_regen_total) > 200 ? "ok" : "warn"} sub={`${fmt$((400 - Math.min(400, res.Q_regen_total)) * 8760 * inputs.f_avail * inputs.R_therm_opp)}/yr`} tip="BioCHP thermal remaining for customer sales" />
            <MetricCard label="Container" value={res.fits ? "FITS" : "NO FIT"} unit="" status={res.fits ? "ok" : "error"} tip="40ft ISO: 12.03 × 2.35 × 2.39 m" />
          </div>

          {res.warnings.map((w, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: w.c === "red" ? "rgba(239,68,68,0.10)" : "rgba(245,158,11,0.10)", border: `1px solid ${w.c === "red" ? COLORS.red : COLORS.amber}33`, borderRadius: 4, padding: "5px 10px", fontSize: 11, marginBottom: 5 }}>
              <span style={{ color: w.c === "red" ? COLORS.red : COLORS.amber }}>⚠ {w.t}</span>
              <span style={{ color: COLORS.cyan, fontSize: 10, whiteSpace: "nowrap", marginLeft: 10 }}>→ {w.fix}</span>
            </div>
          ))}
          {res.warnings.length === 0 && (
            <div style={{ background: "rgba(34,197,94,0.10)", border: `1px solid ${COLORS.accent}33`, borderRadius: 4, padding: "5px 10px", fontSize: 11, color: COLORS.accent, marginBottom: 5 }}>
              ✓ Configuration feasible — LCCC ${res.LCCC.toFixed(0)}/ton · {res.CO2_tpd.toFixed(1)} t/day · recovery {res.recovery.toFixed(0)}% · purity ~{res.purity.toFixed(0)}%
            </div>
          )}

          <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 14, marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <div style={{ fontSize: 11, color: COLORS.textDim, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                Bed Schematic — Staggered Cycle ({res.t_ads.toFixed(0)}/{inputs.t_regen}/{inputs.t_cool} min · {res.t_cycle.toFixed(0)} min cycle)
              </div>
              <button onClick={() => setPlaying(!playing)} style={{ background: "transparent", border: `1px solid ${COLORS.cardBorder}`, borderRadius: 4, color: COLORS.accent, fontSize: 11, padding: "3px 10px", cursor: "pointer" }}>
                {playing ? "⏸ Pause" : "▶ Play"}
              </button>
            </div>
            <BedSchematic inp={inputs} res={res} phase={phase} />
            <div style={{ fontSize: 9, color: COLORS.textDim, display: "flex", gap: 14, marginTop: 4 }}>
              <span><span style={{ color: COLORS.accent }}>■</span> Adsorbing (fill = loading)</span>
              <span><span style={{ color: COLORS.amber }}>■</span> MTZ band ({(res.f_MTZ * 100).toFixed(0)}% of bed)</span>
              <span><span style={{ color: COLORS.red }}>■</span> Regen (closed loop)</span>
              <span><span style={{ color: COLORS.cyan }}>■</span> Cooling</span>
            </div>
          </div>

          <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 14, marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: COLORS.textDim, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>
              Cycle Timeline — {inputs.N_ads_target} column{inputs.N_ads_target > 1 ? "s" : ""} always adsorbing
            </div>
            <CycleGantt inp={inputs} res={res} phase={phase} />
          </div>

          <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 14, marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: COLORS.textDim, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>
              Pareto Explorer — {pareto.pts.length} configurations (geometry × humidity)<InfoTip id="pareto" />
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <ScatterChart margin={{ left: 10, right: 20, bottom: 10, top: 10 }}>
                <XAxis type="number" dataKey="tpd" name="CO2" unit=" t/d" tick={{ fill: COLORS.textDim, fontSize: 10 }} domain={[0, 6]} allowDataOverflow />
                <YAxis type="number" dataKey="lccc" name="LCCC" unit=" $/t" tick={{ fill: COLORS.textDim, fontSize: 10 }} domain={[0, 250]} allowDataOverflow />
                <Tooltip cursor={{ strokeDasharray: "3 3" }} content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0].payload;
                  return <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.cardBorder}`, borderRadius: 6, padding: 8, fontSize: 10 }}>
                    <div style={{ color: COLORS.white }}>{d.tpd?.toFixed(2)} t/day · ${d.lccc?.toFixed(0)}/ton</div>
                    {d.D && <div style={{ color: COLORS.textMuted }}>D={d.D}m L={d.L}m N={d.N} RH={d.RH}%</div>}
                  </div>;
                }} />
                <Scatter name="Infeasible" data={pareto.infeasible} fill={COLORS.red} fillOpacity={0.18} isAnimationActive={false} />
                <Scatter name="Warnings" data={pareto.warn} fill={COLORS.amber} fillOpacity={0.45} isAnimationActive={false} onClick={(d) => d && loadConfig(d)} style={{ cursor: "pointer" }} />
                <Scatter name="Feasible" data={pareto.clean} fill={COLORS.accent} fillOpacity={0.75} isAnimationActive={false} onClick={(d) => d && loadConfig(d)} style={{ cursor: "pointer" }} />
                {pareto.frontier.length > 1 && <Scatter name="Frontier" data={pareto.frontier} fill={COLORS.blue} line={{ stroke: COLORS.blue, strokeWidth: 2 }} isAnimationActive={false} />}
                <Scatter name="Current" data={[{ tpd: Math.min(res.CO2_tpd, 6), lccc: Math.min(isFinite(res.LCCC) ? res.LCCC : 250, 250) }]} fill="#ffffff" shape="diamond" isAnimationActive={false} />
              </ScatterChart>
            </ResponsiveContainer>
            <div style={{ fontSize: 9, color: COLORS.textDim, display: "flex", gap: 14 }}>
              <span><span style={{ color: COLORS.accent }}>●</span> Feasible</span>
              <span><span style={{ color: COLORS.amber }}>●</span> Warnings</span>
              <span><span style={{ color: COLORS.red }}>●</span> Infeasible</span>
              <span><span style={{ color: COLORS.blue }}>—</span> Pareto frontier</span>
              <span style={{ color: "#fff" }}>◆ Current</span>
              <span style={{ color: COLORS.cyan, marginLeft: "auto" }}>click any point to load it →</span>
            </div>
          </div>

          <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 14, marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: COLORS.textDim, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>
              Working Capacity — {S.name} (humidity fan, site-corrected)
            </div>
            <ResponsiveContainer width="100%" height={190}>
              <LineChart data={dqCurves} margin={{ left: 5, right: 20, bottom: 5 }}>
                <XAxis dataKey="T" tick={{ fill: COLORS.textDim, fontSize: 10 }} />
                <YAxis tick={{ fill: COLORS.textDim, fontSize: 10 }} />
                <Tooltip content={ttip} />
                <Line dataKey="RH10" name="10% RH" stroke={COLORS.accent} dot={false} strokeWidth={2} />
                <Line dataKey="RH20" name="20% RH" stroke={COLORS.cyan} dot={false} strokeWidth={1.5} />
                <Line dataKey="RH40" name="40% RH" stroke={COLORS.amber} dot={false} strokeWidth={1.5} />
                <Line dataKey="RH60" name="60% RH" stroke={COLORS.red} dot={false} strokeWidth={1.5} />
                <ReferenceLine x={inputs.T_regen} stroke="#fff" strokeDasharray="4 3" />
                <Legend wrapperStyle={{ fontSize: 10 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 14, marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: COLORS.textDim, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>
              Sensitivity — ΔLCCC ($/ton) at ±20%
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={sensitivity} layout="vertical" margin={{ left: 100, right: 20 }}>
                <XAxis type="number" tick={{ fill: COLORS.textDim, fontSize: 9 }} />
                <YAxis type="category" dataKey="label" tick={{ fill: COLORS.textMuted, fontSize: 10 }} width={95} />
                <Tooltip content={ttip} />
                <ReferenceLine x={0} stroke={COLORS.panelBorder} />
                <Bar dataKey="lo" fill={COLORS.red} opacity={0.7} name="−20%" />
                <Bar dataKey="hi" fill={COLORS.accent} opacity={0.7} name="+20%" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* RIGHT */}
        <div style={{ width: 300, minWidth: 300, overflowY: "auto", borderLeft: `1px solid ${COLORS.panelBorder}`, padding: "12px 10px", background: COLORS.panel }}>
          <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 12, marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: COLORS.textDim, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Bed Summary</div>
            {[
              ["Working capacity Δq", `${res.dq.toFixed(2)} mol/kg`],
              ["  dry × f_P × f_hum", `${res.dq_dry.toFixed(2)} × ${res.f_P.toFixed(2)} × ${res.f_hum.toFixed(2)}`],
              ["Sorbent per column", `${res.m_sorbent_col.toFixed(0)} kg`],
              ["Total sorbent", `${res.m_sorbent_total.toFixed(0)} kg`],
              ["CO₂ per cycle/col", `${res.CO2_per_cycle.toFixed(1)} kg ${res.feed_limited ? "(feed-lim)" : "(capacity)"}`],
              ["Face velocity", `${res.v_sup.toFixed(2)} m/s`],
              ["MTZ fraction", `${(res.f_MTZ * 100).toFixed(0)}%`],
              ["ΔP system", `${(res.dP_sys / 1000).toFixed(1)} kPa`],
              ["Specific energy", `${(res.E_elec + res.E_therm).toFixed(0)} kWh/t`],
            ].map(([k, v], i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
                <span style={{ fontSize: 10.5, color: COLORS.textMuted }}>{k}</span>
                <span style={{ fontSize: 11, color: COLORS.white, fontFamily: "'JetBrains Mono', monospace" }}>{v}</span>
              </div>
            ))}
          </div>

          <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 12, marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: COLORS.textDim, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Regen Energy / Cycle / Column</div>
            <ResponsiveContainer width="100%" height={110}>
              <BarChart data={energyBreakdown} layout="vertical" margin={{ left: 60, right: 15 }}>
                <XAxis type="number" tick={{ fill: COLORS.textDim, fontSize: 9 }} unit=" MJ" />
                <YAxis type="category" dataKey="name" tick={{ fill: COLORS.textMuted, fontSize: 10 }} width={58} />
                <Tooltip content={ttip} />
                <Bar dataKey="value" radius={[0, 3, 3, 0]}>
                  {energyBreakdown.map((d, i) => <Cell key={i} fill={d.fill} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div style={{ fontSize: 10, color: COLORS.textMuted, display: "flex", justifyContent: "space-between" }}>
              <span>{res.Q_regen_rate.toFixed(0)} kW/col · {res.N_regen} in regen</span>
              <span style={{ color: res.Q_regen_total <= inputs.Q_avail ? COLORS.accent : COLORS.red, fontFamily: "'JetBrains Mono', monospace" }}>{res.Q_regen_total.toFixed(0)} / {inputs.Q_avail} kW</span>
            </div>
          </div>

          <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 12, marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: COLORS.textDim, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>CAPEX Buildup</div>
            {capexData.sort((a, b) => b.value - a.value).map((r, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "1.5px 0" }}>
                <span style={{ fontSize: 10.5, color: COLORS.textMuted, textTransform: "capitalize" }}>{r.name}</span>
                <span style={{ fontSize: 11, color: COLORS.white, fontFamily: "'JetBrains Mono', monospace" }}>{fmt$(r.value)}</span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", padding: "2px 0", color: COLORS.textMuted, fontSize: 10.5 }}>
              <span>Install + eng (35%)</span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{fmt$(res.C_equip * 0.35)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", borderTop: `1px solid ${COLORS.panelBorder}`, paddingTop: 4, marginTop: 4 }}>
              <span style={{ fontSize: 11, color: COLORS.accent, fontWeight: 700 }}>Total CAPEX</span>
              <span style={{ fontSize: 12, color: COLORS.accent, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{fmt$(res.CAPEX_total)}</span>
            </div>
            <div style={{ marginTop: 8, padding: "6px 8px", background: "rgba(6,182,212,0.08)", border: `1px solid ${COLORS.cyan}33`, borderRadius: 4, fontSize: 9.5, color: COLORS.cyan, lineHeight: 1.4 }}>
              LCCC covers the TSA capture island. Gas cleaning and pre-treatment (drying, particulate / acid-gas removal) are a separate cost not yet included.
            </div>
          </div>

          <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 12, marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: COLORS.textDim, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>OPEX (Annual)</div>
            {opexData.sort((a, b) => b.value - a.value).map((r, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "1.5px 0" }}>
                <span style={{ fontSize: 10.5, color: COLORS.textMuted, textTransform: "capitalize" }}>{r.name}</span>
                <span style={{ fontSize: 11, color: COLORS.white, fontFamily: "'JetBrains Mono', monospace" }}>{fmt$(r.value)}</span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", borderTop: `1px solid ${COLORS.panelBorder}`, paddingTop: 4, marginTop: 4 }}>
              <span style={{ fontSize: 11, color: COLORS.accent, fontWeight: 700 }}>Total OPEX</span>
              <span style={{ fontSize: 12, color: COLORS.accent, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{fmt$(res.OPEX_total)}/yr</span>
            </div>
          </div>

          <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.accent}44`, padding: 12, marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: COLORS.accent, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>→ Send to Financial Model</div>
            {[
              ["Adsorption Vessels", res.cx.vessels], ["Adsorbent", res.cx.sorbent],
              ["Heat Exchanger", res.cx.cooler], ["Blower(s)", res.cx.blower],
              ["Valves + Actuators", res.cx.valves], ["PLC + Instruments", res.cx.controls + res.cx.analyzer],
              ["Piping + Manifolds", res.cx.piping], ["Container(s)", res.cx.container],
              ["CO₂ capture rate", `${res.CO2_tpd.toFixed(2)} t/day`],
            ].map(([k, v], i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "1.5px 0" }}>
                <span style={{ fontSize: 10, color: COLORS.textMuted }}>{k}</span>
                <span style={{ fontSize: 10.5, color: COLORS.white, fontFamily: "'JetBrains Mono', monospace" }}>{typeof v === "number" ? fmt$(v) : v}</span>
              </div>
            ))}
            <button onClick={() => {
              const txt = `CO2_tpd: ${res.CO2_tpd.toFixed(2)}\nVessels: ${res.cx.vessels.toFixed(0)}\nAdsorbent: ${res.cx.sorbent.toFixed(0)}\nHX: ${res.cx.cooler.toFixed(0)}\nBlower: ${res.cx.blower.toFixed(0)}\nValves: ${res.cx.valves.toFixed(0)}\nControls: ${(res.cx.controls + res.cx.analyzer).toFixed(0)}\nPiping: ${res.cx.piping.toFixed(0)}\nContainer: ${res.cx.container.toFixed(0)}`;
              if (navigator.clipboard) navigator.clipboard.writeText(txt);
            }} style={{ width: "100%", marginTop: 8, padding: "6px 0", background: COLORS.accent, color: COLORS.bg, border: "none", borderRadius: 4, fontWeight: 700, fontSize: 11, cursor: "pointer" }}>
              Copy Values
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

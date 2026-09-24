#!/usr/bin/env node
/**
 * cache-monitor — 缓存命中率监控（数据源：CCR usage.sqlite）
 *
 * 用法：
 *   node scripts/maintain/cache-monitor.mjs [--window 24h] [--threshold 50] [--live-hours 24] [--json]
 *
 * 判定：命中率 = cache_read / (input + cache_read)
 *   input 是「未命中缓存」的输入 token，cache_read 是命中部分，
 *   两者相加 = 本次请求的完整前缀长度，故比值即真实前缀命中率。
 *
 * 退出码：0 = 全部达标或样本不足；1 = 有**在用**路径低于阈值（可做门禁）。
 *
 * 历史：旧数据源 new-api/one-api.db 于 2026-09-03 随 new-api 退役而删除，
 * 本脚本一度退化成恒退出的空壳。2026-09-10 改接 CCR 的 usage.sqlite
 * （claude-code-router 运行期持续写入，含 cache_read_tokens 分列）。
 *
 * 两处设计修正，均由实测数据触发（见 tests/cache-monitor.test.mjs）：
 *   1. 分组键用 provider|model 而非 model。依据：同一 model 在不同 provider 下
 *      口径可能不同（实测同一 CCR 里两种口径并存），且命中率差异的主因是
 *      provider 附带的**协议**——同一模型走 anthropic 路径 0%、走
 *      openai_chat_completions 路径 57.9%。只按 model 分组会把这两者糊成一行。
 *   2. 引入 live 判定（默认 24h 内出现过）：退役路径仍留在 --window 内，
 *      旧版会把已废弃的 0% 路径当作在用故障报出来。现在退役行单独列出、不进门禁。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const MIN_SAMPLE = 5; // 样本太少不算命中率（首会话冷启动必然 miss，不代表异常）
const RATIO_SPLIT = 0.25; // 采样中位数低于此值判为 remainder 口径（实测两口径分别 ~0.001 / ~1.0）

// sqlite 是实验特性，会往 stderr 打 ExperimentalWarning；只吞这一条，其余照常
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (!(w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message))) console.warn(w);
});

export function windowToMs(spec) {
  const m = /^(\d+)([mhd])$/.exec(String(spec).trim());
  if (!m) throw new Error(`窗口格式非法: ${spec}（示例 60m / 24h / 7d）`);
  const n = Number(m[1]);
  return n * { m: 60000, h: 3600000, d: 86400000 }[m[2]];
}

export const groupKey = (provider, model) => `${provider}|${model}`;

/**
 * 判定上游对 usage.input_tokens 的上报口径 —— 按 provider|model 逐条判，不全局假设：
 *   remainder：input = 未命中余量，总前缀 = input + cache_read
 *   total    ：input = 完整前缀（含已命中部分），缓存部分被重复计数
 * 判据：命中行的 input/cache_read 比值中位数。remainder 口径下极小（实测 ~0.001），
 * total 口径下接近或大于 1（实测 ~1.09）。
 * 口径判错会把 99.9% 的命中率算成 50%，故必须逐条判定而非全局假设。
 *
 * 实测：同一 CCR 里两种口径同时存在（取决于 provider 及其所选协议），
 * 所以按 provider|model 分组判定是必须的，不能全局假设一种。
 */
export function inferConvention(samples) {
  const byKey = new Map();
  for (const s of samples) {
    if (!byKey.has(s.key)) byKey.set(s.key, []);
    byKey.get(s.key).push(s.i / s.c);
  }
  const conv = new Map();
  for (const [key, ratios] of byKey) {
    ratios.sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)];
    conv.set(key, median < RATIO_SPLIT ? 'remainder' : 'total');
  }
  return conv;
}

/**
 * 口径有效性守卫：total 口径要求 cache_read ≤ input（input 已含命中部分）。
 * 实测 某模型 走 openai_chat_completions 时 c > i（137%）——
 * total 口径此时不可能成立，必须回落 remainder，否则会被静默截断成 100%，
 * 把真实缺口盖掉（旧版正是用 Math.min(...,100) 掩盖的）。
 */
export function resolveConvention(inferred, uncached, cached) {
  const convention = inferred || 'remainder';
  if (convention === 'total' && cached > uncached) return { convention: 'remainder', corrected: true };
  return { convention, corrected: false };
}

export function hitRateOf(convention, uncached, cached) {
  const denom = convention === 'total' ? uncached : uncached + cached;
  if (denom <= 0) return null;
  return Math.min((cached / denom) * 100, 100);
}

export function shapeRow(raw, convMap, liveHours, nowMs) {
  const sep = raw.key.indexOf('|');
  const provider = raw.key.slice(0, sep);
  const model = raw.key.slice(sep + 1);
  const { convention, corrected } = resolveConvention(convMap.get(raw.key), raw.uncached, raw.cached);
  const age = raw.lastSeen ? nowMs - Date.parse(raw.lastSeen) : Infinity;
  return {
    key: raw.key,
    provider,
    model,
    requests: raw.requests,
    uncached: raw.uncached,
    cached: raw.cached,
    convention,
    corrected,
    hitRate: raw.cached === 0 ? null : hitRateOf(convention, raw.uncached, raw.cached),
    unsupported: raw.cached === 0,
    live: age <= liveHours * 3600000,
    lastSeen: raw.lastSeen,
  };
}

/**
 * 把 usage_events.model 的多种写法归一到逻辑模型名。
 * 实测同一模型出现过 5 种写法（带 provider 前缀、带构建日期、带过期说明等），
 * 成本被拆散在多个分组里，按原样汇总必然低估。
 * 通用规则按顺序去掉：provider 前缀 → 过期说明 → 尾部构建日期 → [1m] 标记；
 * 通用规则处理不了的走 model-aliases.json（左边的键是归一化后的名字）。
 * 注意：尾部 4 位数字一刀切有误伤风险（如 gpt-4-1106），故显式别名优先于通用规则。
 */
export function normalizeModel(raw, aliases = new Map()) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const slash = trimmed.lastIndexOf('/');
  let name = slash === -1 ? trimmed : trimmed.slice(slash + 1);
  name = name.replace(/-expires-on-\d+\s*$/i, '').replace(/-\d{4}\s*$/, '').replace(/\[1m\]\s*$/i, '');
  if (aliases.has(name)) return aliases.get(name);
  if (aliases.has(trimmed)) return aliases.get(trimmed);
  return name;
}

const STATUS_LABELS = {
  200: 'success',
  0: 'logging gap (succeeded, status unrecorded)',
  429: 'rate limited',
  499: 'client aborted',
};

function labelFor(status) {
  if (STATUS_LABELS[status]) return STATUS_LABELS[status];
  if (status >= 500) return 'upstream error';
  if (status >= 400) return 'request error';
  return 'other';
}

/**
 * 状态分布汇总。关键约定：`status_code=0` 是**记录缺口**而非失败 ——
 * 实测 420 条 status=0 全部带正常 output_tokens（仅 09-10/09-11 两天），
 * 是请求成功但 CCR 没记上状态。若计入失败，成功率会从 ~90% 误算成 66.7%。
 * 故失败与成功率的分母都剔除 status=0，并把缺口单独报出。
 */
export function summarizeStatus(rows) {
  const byStatus = rows
    .map((r) => ({ status: r.status_code, n: r.n, label: labelFor(r.status_code) }))
    .sort((a, b) => b.n - a.n);
  const sum = (pred) => rows.filter(pred).reduce((s, r) => s + r.n, 0);
  const loggingGap = sum((r) => r.status_code === 0);
  const ok = sum((r) => r.status_code === 200);
  const failed = sum((r) => r.status_code !== 200 && r.status_code !== 0);
  const attempts = ok + failed;
  const top = rows.filter((r) => r.status_code !== 200 && r.status_code !== 0).sort((a, b) => b.n - a.n)[0];
  return {
    byStatus,
    loggingGap,
    ok,
    failed,
    successRate: attempts > 0 ? (ok / attempts) * 100 : 100,
    // 明确标注是**原始日志条数**：并发爆发会让同一批重试各占一条，
    // 实测 494 条 429 只聚成 53 个事件，不标注会让人以为真有几百次失败。
    // 按事件数的口径见 `npm run ccr:check` 的 rateLimit 项。
    topFailure: top
      ? `${top.status_code} (${labelFor(top.status_code)}) x${top.n} log rows (concurrency bursts included; see ccr-check for event counts)`
      : null,
  };
}

/**
 * 该 provider/模型是否免费。CCR 的 cost_usd 是按定价表估算的（cost_source =
 * models.dev / litellm），**免费 provider 也会被估出正数**，故必须显式声明，
 * 否则报表把免费额度当成真实支出（曾据此把免费模型误判为成本最高）。
 * provider 用前缀匹配 —— 运行期名可能带后缀，形如
 * `myprovider::openai_chat_completions::cred:key-1-1`。
 */
export function isFree(provider, logical, cfg) {
  if (!cfg) return false;
  const p = String(provider || '');
  if ((cfg.freeProviders || []).some((fp) => fp && p.startsWith(fp))) return true;
  return (cfg.freeModels || []).includes(logical);
}

/** 按逻辑模型合并各写法/各 provider 的 token 与成本；命中率用合并后的总量重算，不做比率平均。 */
export function aggregateByLogicalModel(rows, aliases = new Map(), freeCfg = null) {
  const map = new Map();
  for (const r of rows) {
    const logical = normalizeModel(r.model, aliases);
    if (!map.has(logical)) {
      map.set(logical, { logical, requests: 0, uncached: 0, cached: 0, cost: 0, estimatedCost: 0, free: false, spellings: new Set() });
    }
    const a = map.get(logical);
    const est = r.cost || 0;
    a.requests += r.requests || 0;
    a.uncached += r.uncached || 0;
    a.cached += r.cached || 0;
    a.estimatedCost += est;
    // 免费路径的估算值单独留档（estimatedCost），不进计费口径
    if (!isFree(r.provider, logical, freeCfg)) a.cost += est;
    else a.free = true;
    if (r.model) a.spellings.add(r.model);
  }
  return [...map.values()]
    .map((a) => ({
      ...a,
      spellings: [...a.spellings],
      hitRate: a.cached === 0 ? null : Math.min((a.cached / (a.uncached + a.cached)) * 100, 100),
    }))
    .sort((x, y) => y.requests - x.requests);
}

/** 配置缺失或损坏不该让监控挂掉 —— 退化为只用通用规则 */
function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(new URL('./model-aliases.json', import.meta.url), 'utf8'));
    return {
      aliases: new Map(Object.entries(raw.aliases || {})),
      free: { freeProviders: raw.free_providers || [], freeModels: raw.free_models || [] },
    };
  } catch {
    return { aliases: new Map(), free: { freeProviders: [], freeModels: [] } };
  }
}

function parseArgs(argv) {
  const out = { window: '24h', threshold: 50, liveHours: 24, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--window') out.window = argv[++i];
    else if (a === '--threshold') out.threshold = Number(argv[++i]);
    else if (a === '--live-hours') out.liveHours = Number(argv[++i]);
  }
  return out;
}

function locateDb() {
  const candidates = [
    process.env.CCR_HOME && path.join(process.env.CCR_HOME, 'usage.sqlite'),
    path.join(process.env.APPDATA || '', 'claude-code-router', 'usage.sqlite'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'claude-code-router', 'usage.sqlite'),
    path.join(os.homedir(), 'Library', 'Application Support', 'claude-code-router', 'usage.sqlite'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function collect(dbPath, sinceIso) {
  // readOnly 保证不会干扰正在运行的 CCR（不写、不 checkpoint）
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const series = db
      .prepare(
        `SELECT COALESCE(NULLIF(provider, ''), 'unknown') AS provider,
                model,
                COUNT(*)                            AS requests,
                SUM(COALESCE(input_tokens, 0))      AS uncached,
                SUM(COALESCE(cache_read_tokens, 0)) AS cached,
                SUM(COALESCE(cost_usd, 0))          AS cost,
                MAX(created_at)                     AS last_seen
           FROM usage_events
          WHERE created_at >= ?
            AND model IS NOT NULL
            AND TRIM(model) <> ''
          GROUP BY provider, model
          ORDER BY (SUM(COALESCE(input_tokens,0)) + SUM(COALESCE(cache_read_tokens,0))) DESC`
      )
      .all(sinceIso);
    // 取命中行样本，用于逐条判定上报口径（见 inferConvention）
    const samples = db
      .prepare(
        `SELECT COALESCE(NULLIF(provider, ''), 'unknown') AS provider,
                model, input_tokens AS i, cache_read_tokens AS c
           FROM usage_events
          WHERE created_at >= ? AND cache_read_tokens > 0 AND input_tokens > 0
          ORDER BY created_at DESC LIMIT 4000`
      )
      .all(sinceIso);
    const statusRows = db
      .prepare(
        `SELECT status_code, COUNT(*) AS n
           FROM usage_events
          WHERE created_at >= ?
          GROUP BY status_code
          ORDER BY n DESC`
      )
      .all(sinceIso);
    return {
      series: series.map((r) => ({
        key: groupKey(r.provider, r.model),
        provider: r.provider,
        model: r.model,
        requests: r.requests,
        uncached: r.uncached,
        cached: r.cached,
        cost: r.cost,
        lastSeen: r.last_seen,
      })),
      samples: samples.map((r) => ({ key: groupKey(r.provider, r.model), i: r.i, c: r.c })),
      statusRows,
    };
  } finally {
    db.close();
  }
}

const fmtRate = (r) => (r.unsupported ? 'n/a' : r.hitRate === null ? '—' : `${r.hitRate.toFixed(1)}%`);

function printTable(title, rows) {
  console.log(`\n${title}`);
  if (rows.length === 0) {
    console.log('  (none)');
    return;
  }
  const w = Math.max(9, ...rows.map((r) => r.provider.length));
  const m = Math.max(5, ...rows.map((r) => r.model.length));
  console.log(
    `  ${'provider'.padEnd(w)}  ${'model'.padEnd(m)}  ${'reqs'.padStart(6)}  ${'uncached tok'.padStart(12)}  ${'cached tok'.padStart(12)}  ${'hit rate'.padStart(8)}  last seen`
  );
  for (const r of rows) {
    const notes = [];
    if (r.unsupported) notes.push('upstream has no prefix cache');
    else if (r.corrected) notes.push('convention fell back to remainder (validity check)');
    else if (r.convention === 'total') notes.push('input_tokens includes cached tokens');
    console.log(
      `  ${r.provider.padEnd(w)}  ${r.model.padEnd(m)}  ${String(r.requests).padStart(6)}  ${String(r.uncached).padStart(11)}  ${String(r.cached).padStart(12)}  ${fmtRate(r).padStart(7)}  ${(r.lastSeen || '').slice(5, 16)}${notes.length ? '  <- ' + notes.join('; ') : ''}`
    );
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  // created_at 为 ISO8601 UTC（带 Z），用 toISOString 保证字符串可比
  const sinceIso = new Date(Date.now() - windowToMs(args.window)).toISOString();
  const nowMs = Date.now();

  const dbPath = locateDb();
  if (!dbPath) {
    console.error('❌ 未找到 CCR usage.sqlite（CCR 未安装或未运行过）');
    process.exit(0);
  }

  let rows, logical, health;
  try {
    const { series, samples, statusRows } = collect(dbPath, sinceIso);
    const conv = inferConvention(samples);
    const { aliases, free } = loadConfig();
    rows = series
      .filter((r) => r.requests >= MIN_SAMPLE)
      .map((r) => shapeRow(r, conv, args.liveHours, nowMs));
    logical = aggregateByLogicalModel(series.filter((r) => r.requests >= MIN_SAMPLE), aliases, free);
    health = summarizeStatus(statusRows);
  } catch (e) {
    console.error(`❌ 读取 usage.sqlite 失败: ${e.message}`);
    process.exit(0); // 监控本身不该因读不到数据而红灯
  }

  const live = rows.filter((r) => r.live);
  const retired = rows.filter((r) => !r.live);
  // 门禁只看在用路径：退役路径的 0% 是历史，不是当前故障
  const below = live.filter((r) => !r.unsupported && r.hitRate !== null && r.hitRate < args.threshold);

  if (args.json) {
    console.log(
      JSON.stringify({ ok: below.length === 0, window: args.window, threshold: args.threshold, liveHours: args.liveHours, below: below.map((r) => r.key), rows, logical, health })
    );
    process.exit(below.length === 0 ? 0 : 1);
  }

  console.log(`Prompt cache hit rate (window ${args.window}, threshold ${args.threshold}%, min sample ${MIN_SAMPLE}, live = seen within ${args.liveHours}h)`);
  console.log(`source: ${dbPath}`);

  if (rows.length === 0) {
    console.log('\n(not enough requests in window)');
    process.exit(0);
  }

  printTable('LIVE PATHS', live);
  if (retired.length > 0) printTable(`RETIRED PATHS (no traffic in the last ${args.liveHours}h — excluded from the gate)`, retired);

  const supported = live.filter((r) => !r.unsupported && r.hitRate !== null);
  if (supported.length > 0) {
    const totCached = supported.reduce((s, r) => s + r.cached, 0);
    const totAll = supported.reduce((s, r) => s + r.cached + r.uncached, 0);
    console.log(`\nOverall hit rate across live, cache-capable paths: ${((totCached / totAll) * 100).toFixed(1)}%`);
  }

  // 按逻辑模型汇总：合并同一模型的不同写法与 provider，成本口径才完整
  console.log('\nBY LOGICAL MODEL (merges provider prefixes, build dates, aliases)');
  const lw = Math.max(6, ...logical.map((a) => a.logical.length));
  console.log(`  ${'model'.padEnd(lw)}  ${'reqs'.padStart(7)}  ${'hit rate'.padStart(8)}  ${'cost USD'.padStart(9)}  notes`);
  for (const a of logical) {
    const rate = a.hitRate === null ? '—' : `${a.hitRate.toFixed(1)}%`;
    const cost = a.free ? 'free' : a.cost.toFixed(2);
    const notes = [];
    if (a.free && a.estimatedCost > 0) notes.push(`price-table estimate $${a.estimatedCost.toFixed(2)} (not billed)`);
    if (a.spellings.length > 1) notes.push(a.spellings.join(' + '));
    console.log(`  ${a.logical.padEnd(lw)}  ${String(a.requests).padStart(7)}  ${rate.padStart(7)}  ${cost.padStart(9)}  ${notes.join('; ')}`);
  }
  const billable = logical.filter((a) => !a.free).reduce((s, a) => s + a.cost, 0);
  const freeEstimate = logical.filter((a) => a.free).reduce((s, a) => s + a.estimatedCost, 0);
  console.log(`\n  Billable total: $${billable.toFixed(2)} (estimated by CCR from a pricing table — NOT a bill)`);
  if (freeEstimate > 0) console.log(`  Free-path price-table estimate: $${freeEstimate.toFixed(2)} (not actually billed; excluded from the total above)`);

  // 状态健康度：status=0 是记录缺口不是失败，必须单独说明，否则成功率会被误算
  console.log('\nSTATUS & HEALTH');
  for (const r of health.byStatus) {
    console.log(`  ${String(r.status).padStart(4)}  ${r.label.padEnd(22)} ${String(r.n).padStart(6)}`);
  }
  console.log(`  Success rate (logging gap excluded): ${health.successRate.toFixed(1)}%  = ${health.ok} / ${health.ok + health.failed}`);
  if (health.loggingGap > 0) {
    console.log(`  WARN: logging gap — ${health.loggingGap} row(s) with status=0 (succeeded but status unrecorded); excluded from failures and the success rate`);
  }
  if (health.topFailure) console.log(`  Top failure: ${health.topFailure}`);

  if (below.length > 0) {
    console.log(`\nWARN: ${below.length} live path(s) below ${args.threshold}%:`);
    below.forEach((r) => console.log(`  ${r.provider} / ${r.model} → ${r.hitRate.toFixed(1)}%`));
    console.log('Hint: check whether injected system-prompt files drifted — prefix drift is the #1 cause of a sudden hit-rate drop.');
    process.exit(1);
  }

  console.log('\nOK: every live path meets the threshold');
  process.exit(0);
}

// 仅直接执行时跑 main()，被 import（测试）时只导出纯函数
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

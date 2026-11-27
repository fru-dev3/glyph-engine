// `prevail arena <command>` and the Glyph Arena sidecar (`arena-engine <command>`).
// Every command prints JSON on stdout: one object, or, with --stream, JSON lines
// ({"event":"progress",...}) ending in {"event":"done","result":...}.
import { initVaultSession } from "../vault-session.ts";
import { autopilotSpent, readAutopilot, setAutopilot, tick as autopilotTick } from "./autopilot.ts";
import { loadKeyFiles } from "./media.ts";
import { addModel, makeModel, readModels, refreshModels, resolveModel } from "./models.ts";
import { computeRatings, listRuns, pickModel, type RatingsFile } from "./ratings.ts";
import { runStatus, runSuite } from "./suite-run.ts";
import { approve, listSuites, readSuite, type SuiteKind } from "./suites.ts";
import { recordAdverse } from "./adverse.ts";
import { classifyKind, classifyWeight } from "./classify.ts";
import { lookupRoute, readPolicy } from "./policy.ts";
import { isHomeOnlyTask } from "./privacy.ts";
import { addRecipe, detectRuntimes, ensureRecipes, makeRecipe, setRecipeActive } from "./recipes.ts";
import { runDuel, runReplay } from "./run.ts";
import {
  addScouted, allSignals, flagDuel, leagueTable, nextPick, rebuildPolicy, recordSignal, runSentinels, scouted, scoutWeb, status, submitPick,
} from "./service.ts";
import { appendLine, file, readAdverse, readConfig, readJson, readDuels, readRecipes, resolveArenaVault, writeConfig } from "./store.ts";
import { loadTasks, sampleTasks, taskId, type TaskSource } from "./tasks.ts";
import { TASK_KINDS, WEIGHTS, type AdverseEvent, type ArenaConfig, type ArenaTask, type League, type Severity, type TaskKind, type Weight } from "./types.ts";

type Flags = Record<string, string | true>;

export function parseFlags(argv: string[]): { pos: string[]; flags: Flags } {
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) flags[a.slice(2)] = argv[++i]!;
      else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const str = (f: Flags, k: string, d = "") => (typeof f[k] === "string" ? (f[k] as string) : d);
// stdout is a PIPE when the Arena app runs us, and a pipe takes 64 KB before it
// blocks: a write that large is only partly flushed when it returns, so the entry
// point has to wait for the rest before it exits (src/arena/main.ts). Every write
// is recorded here for that wait.
let lastWrite: Promise<void> = Promise.resolve();
const out = (v: unknown) => {
  const line = `${JSON.stringify(v)}\n`;
  lastWrite = new Promise<void>((res) => { process.stdout.write(line, () => res()); });
};
/** Resolves once everything written has left for the other end of the pipe. */
export const stdoutFlushed = (): Promise<void> => lastWrite;

function leagueFrom(f: Flags): League {
  const kind = str(f, "kind", "*");
  const weight = str(f, "weight", "*");
  if (kind !== "*" && !TASK_KINDS.includes(kind as TaskKind)) throw new Error(`unknown kind ${kind}`);
  if (weight !== "*" && !WEIGHTS.includes(weight as Weight)) throw new Error(`unknown weight ${weight}`);
  return { domain: str(f, "domain", "*"), kind: kind as TaskKind | "*", weight: weight as Weight | "*" };
}

function recipeOrThrow(vault: string, id: string) {
  const r = readRecipes(vault).find((x) => x.id === id);
  if (!r) throw new Error(`no recipe "${id}"`);
  return r;
}

function resolveAll(vault: string, specs: string[]): string[] {
  const list = readModels(vault);
  return specs.map((s) => {
    const m = resolveModel(list, s);
    if (!list.some((x) => x.id === m.id)) addModel(vault, m);
    return m.id;
  });
}

const SOURCES: TaskSource[] = ["ghost", "canonical", "sentinel", "custom"];
const SEVERITIES: Severity[] = ["minor", "major", "severe"];
const ADVERSE_KINDS: AdverseEvent["kind"][] = ["hallucination", "wrong_number", "unsafe_advice", "privacy", "regression", "other"];

export async function arenaCommand(argv: string[]): Promise<number> {
  initVaultSession();
  const { pos, flags } = parseFlags(argv);
  const vault = resolveArenaVault(str(flags, "vault") || null);
  const [cmd = "status", sub = ""] = pos;
  if (cmd === "help" || flags.help) {
    out({ commands: ["suites list", "suite show <id>", "run start --suite <id>|--all [--models a,b] [--budget USD] [--resume ID]", "run status [id]", "runs list", "runs show <id>", "ratings [--recompute]", "pick --area A", "pick-media --run R --item I --winner M|tie|none", "autopilot status|set|tick", "models [list|refresh|add]", "approve --suite S", "status", "recipes [add|toggle|runtimes]", "tasks", "replay", "duel", "pick [next|submit]", "flag", "adverse [add|lift]", "signal", "policy [rebuild|route]", "league", "duels", "config [set]", "sentinel", "scout [add|web]"] });
    return 0;
  }
  if (cmd === "where") {
    const flag = str(flags, "vault");
    out({ path: vault, source: flag ? "--vault" : process.env.PREVAIL_VAULT ? "chosen in Glyph Arena" : vault ? "shared with Glyph Studio" : "none" });
    return 0;
  }
  if (!vault) {
    out({ error: "no vault: pass --vault, set PREVAIL_VAULT, or set vaultPath in ~/.prevail/config.json" });
    return 2;
  }
  const stream = !!flags.stream;
  {
    const ef = readConfig(vault).env_files;
    if (ef?.length) loadKeyFiles(ef);
  }
  const progress = (e: object) => { if (stream) out({ event: "progress", ...e }); };
  const done = (result: unknown) => (stream ? out({ event: "done", result }) : out(result));

  try {
    switch (cmd) {
      case "status": {
        await ensureRecipes(vault, readConfig(vault));
        done(status(vault));
        return 0;
      }
      case "recipes": {
        if (sub === "runtimes") { done(await detectRuntimes(readConfig(vault))); return 0; }
        if (sub === "add") {
          const r = makeRecipe({
            cli: str(flags, "cli"), model: str(flags, "model"), baseUrl: str(flags, "base-url") || undefined,
            prompt: (str(flags, "prompt", "plain") as "plain"), context: (str(flags, "context", "none") as "none"), tools: (str(flags, "tools", "none") as "none"),
          });
          if (!r.cli || !r.model) throw new Error("recipes add needs --cli and --model");
          if (!["plain", "concise", "expert"].includes(r.prompt) || !["none", "domain"].includes(r.context) || !["none", "web"].includes(r.tools)) throw new Error("bad prompt, context or tools");
          done(addRecipe(vault, r));
          return 0;
        }
        if (sub === "toggle") { done(setRecipeActive(vault, pos[2] ?? "", pos[3] !== "off")); return 0; }
        done(await ensureRecipes(vault, readConfig(vault)));
        return 0;
      }
      case "tasks": {
        const source = str(flags, "source", "ghost") as TaskSource;
        if (!SOURCES.includes(source)) throw new Error(`source must be one of ${SOURCES.join(", ")}`);
        const cfg = readConfig(vault);
        const tasks = sampleTasks(loadTasks(vault, source), leagueFrom(flags), Number(str(flags, "limit", "50")));
        done(tasks.map((t) => ({ ...t, home_only: isHomeOnlyTask(t, cfg, vault) })));
        return 0;
      }
      case "replay": {
        const source = str(flags, "source", "ghost") as TaskSource;
        if (!SOURCES.includes(source)) throw new Error(`source must be one of ${SOURCES.join(", ")}`);
        const a = recipeOrThrow(vault, str(flags, "a"));
        const b = recipeOrThrow(vault, str(flags, "b"));
        if (a.id === b.id) throw new Error("pick two different recipes");
        const n = Math.max(1, Math.min(50, Number(str(flags, "n", String(readConfig(vault).replay_sample)))));
        const tasks = sampleTasks(loadTasks(vault, source), leagueFrom(flags), n);
        progress({ done: 0, total: tasks.length });
        const duels = await runReplay(vault, tasks, a, b, { onProgress: (e) => progress({ done: e.done, total: e.total, note: e.note, duel: e.duel ? brief(e.duel) : undefined }) });
        const policy = rebuildPolicy(vault);
        done({ duels: duels.map(brief), routes: policy.routes.length });
        return 0;
      }
      case "duel": {
        const prompt = str(flags, "prompt");
        if (!prompt) throw new Error("duel needs --prompt");
        const a = recipeOrThrow(vault, str(flags, "a"));
        const b = recipeOrThrow(vault, str(flags, "b"));
        const task: ArenaTask = {
          id: taskId("custom", prompt), source: "custom", domain: str(flags, "domain", "general"),
          kind: (str(flags, "kind") as TaskKind) || classifyKind(prompt), weight: (str(flags, "weight") as Weight) || classifyWeight(prompt), prompt,
        };
        const d = await runDuel(vault, task, a, b);
        rebuildPolicy(vault);
        done(brief(d));
        return 0;
      }
      case "pick": {
        if (flags.area || (sub && sub !== "next" && sub !== "submit")) {
          done(pickModel(readJson<RatingsFile | null>(file(vault, "ratings.json"), null), str(flags, "area") || sub));
          return 0;
        }
        if (sub === "submit") {
          const choice = pos[3] as "left" | "right" | "tie";
          if (!["left", "right", "tie"].includes(choice)) throw new Error("pick submit <duel> left|right|tie --left a|b --ms N");
          const left = str(flags, "left") as "a" | "b";
          if (left !== "a" && left !== "b") throw new Error("--left must be a or b");
          done(submitPick(vault, pos[2] ?? "", choice, left, Number(str(flags, "ms", "0"))));
          return 0;
        }
        done(nextPick(vault));
        return 0;
      }
      case "flag": {
        const side = pos[2] as "a" | "b";
        const kind = str(flags, "kind", "other") as AdverseEvent["kind"];
        const sev = str(flags, "severity", "minor") as Severity;
        if (side !== "a" && side !== "b") throw new Error("flag <duel> a|b --kind K --severity S --what TEXT");
        if (!ADVERSE_KINDS.includes(kind) || !SEVERITIES.includes(sev)) throw new Error("bad kind or severity");
        done(flagDuel(vault, sub, side, kind, sev, str(flags, "what", kind)));
        return 0;
      }
      case "adverse": {
        if (sub === "add" || sub === "lift") {
          const kind = sub === "lift" ? "lift" : (str(flags, "kind", "other") as AdverseEvent["kind"]);
          const sev = str(flags, "severity", "minor") as Severity;
          if (sub === "add" && (!ADVERSE_KINDS.includes(kind) || !SEVERITIES.includes(sev))) throw new Error("bad kind or severity");
          const ev = recordAdverse(vault, { model: str(flags, "model"), domain: str(flags, "domain", "*"), severity: sev, kind, what: str(flags, "what", sub === "lift" ? "lifted by hand" : ""), source: "manual" });
          rebuildPolicy(vault);
          done(ev);
          return 0;
        }
        done(readAdverse(vault).sort((x, y) => y.ts - x.ts));
        return 0;
      }
      case "signal": {
        const s = recordSignal(vault, {
          model: str(flags, "model"), domain: str(flags, "domain", "general"),
          signal: str(flags, "signal") as "accept", source: str(flags, "source", "cli"),
          ...(str(flags, "to") ? { to_model: str(flags, "to") } : {}),
          ...(str(flags, "kind") ? { kind: str(flags, "kind") as TaskKind } : {}),
          ...(str(flags, "weight") ? { weight: str(flags, "weight") as Weight } : {}),
        });
        done(s);
        return 0;
      }
      case "signals": { done(allSignals(vault)); return 0; }
      case "policy": {
        if (sub === "rebuild") { done(rebuildPolicy(vault)); return 0; }
        if (sub === "route") {
          const prompt = str(flags, "prompt");
          const p = readPolicy(vault);
          const kind = (str(flags, "kind") as TaskKind) || classifyKind(prompt);
          const weight = (str(flags, "weight") as Weight) || classifyWeight(prompt);
          done({ kind, weight, route: p ? lookupRoute(p, str(flags, "domain", "general"), kind, weight) : null });
          return 0;
        }
        done(readPolicy(vault) ?? rebuildPolicy(vault));
        return 0;
      }
      case "league": { done(leagueTable(vault, leagueFrom(flags))); return 0; }
      case "duels": {
        const lim = Number(str(flags, "limit", "50"));
        const lg = leagueFrom(flags);
        const list = readDuels(vault).filter((d) => (lg.domain === "*" || d.league.domain === lg.domain) && (lg.kind === "*" || d.league.kind === lg.kind)).reverse().slice(0, lim);
        done(flags.full ? list : list.map(brief));
        return 0;
      }
      case "config": {
        if (sub === "set") {
          const patch: Partial<ArenaConfig> = {};
          for (const kv of pos.slice(2)) {
            const i = kv.indexOf("=");
            if (i < 1) continue;
            const k = kv.slice(0, i) as keyof ArenaConfig;
            const v = kv.slice(i + 1);
            if (["home_only", "home_endpoints", "home_hosts"].includes(k)) (patch as Record<string, unknown>)[k] = v.split(",").map((x) => x.trim()).filter(Boolean);
            else if (["monthly_cap_usd", "replay_sample", "min_games", "sentinel_day"].includes(k)) (patch as Record<string, unknown>)[k] = Number(v);
            else if (k === "code_tests") patch.code_tests = v === "true" || v === "on";
            else if (k === "judge") patch.judge = v;
            else if (k === "judges" || k === "env_files") (patch as Record<string, unknown>)[k] = v.split(",").map((x) => x.trim()).filter(Boolean);
            else if (k === "whisper_model") patch.whisper_model = v;
            else throw new Error(`unknown setting ${k}`);
          }
          const cfg = writeConfig(vault, patch);
          rebuildPolicy(vault);
          done(cfg);
          return 0;
        }
        done(readConfig(vault));
        return 0;
      }
      case "sentinel": {
        const ids = str(flags, "recipes").split(",").filter(Boolean);
        const r = await runSentinels(vault, ids, { onProgress: (e) => progress(e) });
        done(r);
        return 0;
      }
      case "scout": {
        if (sub === "web") { done({ found: await scoutWeb(vault) }); return 0; }
        if (sub === "add") { done(addScouted(vault, JSON.parse(str(flags, "json", "{}")))); return 0; }
        done(await scouted(vault));
        return 0;
      }
      case "suites": {
        done(listSuites(vault).map((s) => ({ id: s.id, title: s.title, kind: s.kind, area: s.area, schedule: s.schedule, items: s.items.length, active: s.items.filter((i) => i.split !== "reserve").length })));
        return 0;
      }
      case "suite": {
        const s = readSuite(vault, pos[2] ?? str(flags, "suite"));
        done(flags.full ? s : { ...s, items: s.items.map((i) => ({ id: i.id, prompt: i.prompt?.slice(0, 200), split: i.split })) });
        return 0;
      }
      case "run": {
        if (sub === "status") { done(runStatus(vault, pos[2] ?? (str(flags, "run") || undefined))); return 0; }
        const wantAll = !!flags.all;
        const suiteId = str(flags, "suite");
        if (!wantAll && !suiteId) throw new Error("run needs --suite <id> or --all");
        const models = str(flags, "models").split(",").filter(Boolean);
        const budget = str(flags, "budget") ? Number(str(flags, "budget")) : undefined;
        const ids = wantAll ? listSuites(vault).filter((s) => s.kind !== "app").map((s) => s.id) : [suiteId];
        const results = [];
        for (const id of ids) {
          const r = await runSuite(vault, {
            suite: id, models: models.length ? resolveAll(vault, models) : undefined, budgetUsd: budget, resume: str(flags, "resume") || undefined,
            maxItems: str(flags, "items") ? Number(str(flags, "items")) : undefined, judges: str(flags, "judges").split(",").filter(Boolean),
            onProgress: (e) => progress(e),
          });
          results.push({ id: r.id, suite: r.suite, status: r.status, cost_usd: r.cost_usd, games: r.games.length, notes: r.notes });
        }
        computeRatings(vault);
        done(wantAll ? results : results[0]);
        return 0;
      }
      case "runs": {
        if (sub === "show") { done(runStatus(vault, pos[2] ?? str(flags, "run"))); return 0; }
        done(listRuns(vault).reverse().slice(0, Number(str(flags, "limit", "50"))).map((r) => ({ id: r.id, suite: r.suite, started: r.started, ended: r.ended, status: r.status, cost_usd: r.cost_usd, models: r.models, games: r.games.length })));
        return 0;
      }
      case "ratings": {
        done(flags.recompute || !readJson<RatingsFile | null>(file(vault, "ratings.json"), null) ? computeRatings(vault) : readJson(file(vault, "ratings.json"), null));
        return 0;
      }
      case "pick-media": {
        const run = str(flags, "run"), item = str(flags, "item"), winner = str(flags, "winner");
        if (!run || !item || !winner) throw new Error("pick-media --run R --item I --winner <model>|tie|none");
        const r = runStatus(vault, run);
        if (!r) throw new Error(`no run ${run}`);
        const shown = Object.entries(r.by_item[item] ?? {}).filter(([, c]) => c.output_ref).map(([m]) => m);
        if (winner !== "tie" && winner !== "none" && !shown.includes(winner)) throw new Error(`${winner} did not make an output for ${item}`);
        const line = { ts: new Date().toISOString(), run, item, winner, shown };
        appendLine(file(vault, "picks-media.jsonl"), line);
        computeRatings(vault);
        done(line);
        return 0;
      }
      case "autopilot": {
        if (sub === "set") {
          const on = str(flags, "on");
          done(setAutopilot(vault, { on: on ? on === "true" || on === "on" : undefined, budget: str(flags, "budget") ? Number(str(flags, "budget")) : undefined, at: str(flags, "at") || undefined }));
          return 0;
        }
        if (sub === "tick") { done(await autopilotTick(vault, { force: !!flags.force, onRun: (e) => progress(e) })); return 0; }
        const s = readAutopilot(vault);
        done({ ...s, spent_this_month_usd: Math.round(autopilotSpent(s, new Date()) * 1e4) / 1e4 });
        return 0;
      }
      case "models": {
        if (sub === "refresh") { done({ added: (await refreshModels(vault)).map((m) => m.id), models: readModels(vault).length }); return 0; }
        if (sub === "add") {
          const m = makeModel({ cli: str(flags, "cli"), model: str(flags, "model"), kind: (str(flags, "kind", "text") as SuiteKind), baseUrl: str(flags, "base-url") || undefined, effort: str(flags, "effort") || undefined });
          if (!m.cli || !m.model) throw new Error("models add needs --cli and --model");
          addModel(vault, m);
          done(m);
          return 0;
        }
        done(readModels(vault));
        return 0;
      }
      case "approve": {
        done(approve(vault, str(flags, "suite"), str(flags, "item") || undefined));
        return 0;
      }
      default:
        out({ error: `unknown arena command "${cmd}"` });
        return 2;
    }
  } catch (e) {
    out(stream ? { event: "error", error: (e as Error).message } : { error: (e as Error).message });
    return 1;
  }
}

/** A duel without the full answers: what lists and progress lines need. */
export function brief(d: import("./types.ts").Duel) {
  const side = (s: typeof d.a) => ({ recipe: s.recipe, ok: s.ok, status: s.status, error: s.error, ms: s.ms, cost_usd: s.cost_usd, check: s.check, judge: s.judge, chars: s.reply.length });
  return { id: d.id, ts: d.ts, league: d.league, task: { id: d.task.id, source: d.task.source, prompt: d.task.prompt.slice(0, 280) }, a: side(d.a), b: side(d.b), similarity: d.similarity, outcome: d.outcome, decided_by: d.decided_by, pick: d.pick };
}

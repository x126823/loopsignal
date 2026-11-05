import { z } from "zod";
import type { LLMProvider, ProviderRequest, ProviderResponse } from "./types";

/**
 * A rule-based stand-in for a model. It is what `LLM_PROVIDER=fake` runs, so the whole pipeline works locally with no
 * credentials and golden-set evaluation is deterministic. It is NOT an AI and its scores say nothing about a real
 * model: it matches keywords and is deliberately simple (and therefore imperfect). It reads only the delimited prompt it
 * is given, exactly as a real provider would, and quotes verbatim from the text it was shown.
 */
const tokens = (s: string) => Math.ceil(s.length / 4);

interface Parsed {
  messages: Array<{ id: string; direction: string; sentAt: string; text: string }>;
  candidates: Array<{ id: string; name: string; handle: string }>;
  facts: Record<string, string>;
}

function parse(user: string): Parsed {
  const messages = [...user.matchAll(/<message_([0-9a-f]{16}) id="([0-9a-f-]{36})" direction="(\w+)" sentAt="([^"]+)">\n([\s\S]*?)\n<\/message_\1>/g)].map((m) => ({
    id: m[2]!, direction: m[3]!, sentAt: m[4]!, text: m[5]!,
  }));
  const candidates = [...user.matchAll(/<candidate_[0-9a-f]{16} id="([0-9a-f-]{36})" name=("(?:[^"\\]|\\.)*") handle=("(?:[^"\\]|\\.)*")\/>/g)].map((m) => ({
    id: m[1]!, name: z.string().parse(JSON.parse(m[2]!)), handle: z.string().parse(JSON.parse(m[3]!)),
  }));
  const block = user.match(/<facts_[0-9a-f]{16}>\n([\s\S]*?)\n<\/facts_[0-9a-f]{16}>/);
  const facts = Object.fromEntries((block?.[1] ?? "").split("\n").flatMap((l) => { const i = l.indexOf(": "); return i > 0 ? [[l.slice(0, i), l.slice(i + 2)] as const] : []; }));
  return { messages, candidates, facts };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sentences = (t: string) => t.split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter(Boolean);

const NOISE = /unsubscribe|out of office|automatic reply|auto-?reply|no action (is )?needed|no reply needed|no further action|receipt #|you have won|click here|happy (holidays|new year)|webinar|delivery status|has shipped/i;
const THANKS_ONLY = /^(thanks|thank you|great|sounds good|perfect|ok(ay)?)\b[^?]*$/i;
const REQUEST = /\b(please|could you|can you|can someone|i need|we need|need help|unable|can'?t|cannot|not working|error|fail(ed|s)?|broken|wrong|missing|blocked|help|issue|problem|still (have )?no|following up|charged twice|pouvez)\b|\?/i;
const ACK = /(we have received|received (this|your|it)|got (it|your)|looking into|look into|we are on it|we'?ll get back|get back to you|acknowledged|will review|reviewing)/i;
const SUBSTANTIVE = /(fixed|resolved|reset|refund(ed)?|was issued|attached|the (cause|issue|problem) was|root cause|because|rotated|restarted|updated|ship(s|ped)? on|will ship|deployed|workaround|please (send|share|try|confirm)|could you (send|share|confirm)|can you (send|share|confirm)|cannot reproduce|can'?t reproduce|by (monday|tuesday|wednesday|thursday|friday)|on (monday|tuesday|wednesday|thursday|friday)|today|tomorrow|\?)/i;

const PROGRESS = /(working on|investigating|is being investigated|in review|scheduled|escalat(ed|ing)|has started|have started|underway|engineer|identified the cause|in progress|will investigate)/i;
const RESOLVED_BY_US = /(is now fixed|has been fixed|have fixed|is now resolved|has been resolved|should now work|is now working|let us know if (it|this) works|consider this resolved|fix (is|has been) (deployed|live))/i;
const CUSTOMER_CONFIRMS = /(works now|that fixed it|it'?s fixed|is fixed|fixed it|you can close|confirmed,? (the|that|it)|all good now|problem is gone|resolved on my side)/i;
const CUSTOMER_REJECTS = /(still (broken|not working|failing|happening|the same)|didn'?t work|did not work|same error|problem persists|not fixed)/i;

type Env = { result: unknown; confidence: number; evidence: Array<{ messageId: string; quote: string }>; recommendedAction: string; requiresHumanApproval: boolean };
const env = (result: unknown, confidence: number, evidence: Env["evidence"], recommendedAction: string): Env => ({ result, confidence, evidence, recommendedAction, requiresHumanApproval: false });

function intent(p: Parsed): Env {
  const last = p.messages.at(-1);
  const no = (c: number) => env({ actionable: false, kind: "other", priority: "NORMAL" }, c, [], "NOT_ACTIONABLE");
  if (!last || last.direction !== "INBOUND") return no(0.95);
  const text = last.text;
  if (NOISE.test(text)) return no(0.9);
  const hit = text.match(REQUEST);
  if (!hit) return no(0.7);
  if (THANKS_ONLY.test(text.trim())) return no(0.85);
  const signals = [...text.matchAll(new RegExp(REQUEST.source, "gi"))].length;
  const sentence = sentences(text).find((s) => REQUEST.test(s)) ?? hit[0];
  const priority = /outage|down for|urgent|asap|immediately|every customer|all (our )?customers/i.test(text) ? "URGENT"
    : /blocked|charged twice|wrong|before (friday|monday)|deadline/i.test(text) ? "HIGH"
    : /not urgent|in the future|whenever|at some point/i.test(text) ? "LOW" : "NORMAL";
  const kind = /following up|still (have )?no/i.test(text) ? "follow_up" : /error|not working|broken|fail/i.test(text) ? "incident" : /\?/.test(text) ? "question" : "request";
  return env({ actionable: true, kind, priority }, signals >= 2 ? 0.92 : signals === 1 && hit[0] !== "?" ? 0.85 : 0.65, [{ messageId: last.id, quote: sentence.slice(0, 500) }], "TRACK");
}

function ownership(p: Parsed): Env {
  const last = p.messages.at(-1);
  const none = () => env({ ownerUserId: null }, 0.85, [], "NONE");
  if (!last) return none();
  const found = p.candidates.flatMap((c) => {
    const first = c.name.split(/\s+/)[0] ?? c.name;
    const m = last.text.match(new RegExp(`@${esc(c.handle)}\\b|\\b${esc(first)}\\b`, "i"));
    return m ? [{ c, quote: m[0] }] : [];
  });
  if (found.length !== 1) return none();
  return env({ ownerUserId: found[0]!.c.id }, 0.9, [{ messageId: last.id, quote: found[0]!.quote }], "ASSIGN_OWNER");
}

function reply(p: Parsed, kind: "ack" | "sub"): Env {
  const last = p.messages.at(-1);
  const resultKey = kind === "ack" ? "isAcknowledgment" : "isSubstantive";
  const action = kind === "ack" ? "TRANSITION_ACKNOWLEDGED" : "TRANSITION_RESPONDED";
  const no = (c: number) => env({ [resultKey]: false }, c, [], "NONE");
  if (!last || last.direction === "INBOUND") return no(0.9); // never our acknowledgment or response
  const sub = last.text.match(SUBSTANTIVE);
  const ack = last.text.match(ACK);
  if (kind === "ack") return ack && !sub && last.text.length < 250 ? env({ isAcknowledgment: true }, 0.9, [{ messageId: last.id, quote: ack[0] }], action) : no(0.85);
  if (sub) return env({ isSubstantive: true }, 0.9, [{ messageId: last.id, quote: sub[0] }], action);
  if (last.text.length > 400) return env({ isSubstantive: true }, 0.6, [{ messageId: last.id, quote: last.text.slice(0, 40) }], action);
  return no(0.85);
}

function progress(p: Parsed): Env {
  const last = p.messages.at(-1);
  const no = () => env({ isProgress: false }, 0.85, [], "NONE");
  if (!last || last.direction === "INBOUND") return no();
  const hit = last.text.match(PROGRESS);
  if (!hit || RESOLVED_BY_US.test(last.text)) return no();
  return env({ isProgress: true }, 0.88, [{ messageId: last.id, quote: hit[0] }], "TRANSITION_IN_PROGRESS");
}

function resolution(p: Parsed): Env {
  const last = p.messages.at(-1);
  const none = (c = 0.85) => env({ signal: "none" }, c, [], "NONE");
  if (!last) return none();
  const claim = (re: RegExp, signal: string, action: string): Env | null => {
    const m = last.text.match(re);
    return m ? env({ signal }, 0.9, [{ messageId: last.id, quote: m[0] }], action) : null;
  };
  if (last.direction === "INBOUND") {
    return claim(CUSTOMER_REJECTS, "rejected_by_customer", "TRANSITION_IN_PROGRESS") ?? claim(CUSTOMER_CONFIRMS, "confirmed_by_customer", "TRANSITION_RESOLUTION_CONFIRMED") ?? none();
  }
  return claim(RESOLVED_BY_US, "resolved_by_us", "TRANSITION_RESOLUTION_PROPOSED") ?? none();
}

const BLOCKED = /(blocked|urgent|asap|escalat|again|still (no|waiting)|no one|nobody|third time|any update|deadline|outage)/i;
const NEARLY_DONE = /(is now fixed|has been fixed|have fixed|should now work|let us know if (it|this) works|fix (is|has been) (deployed|live)|sending (it|this|the \w+) (now|shortly)|will send (it|this) (today|within the hour))/i;

/** Advisory only: combines the system-measured percentElapsed with simple cues from the last message. */
function slaRisk(p: Parsed): Env {
  const pct = Number(p.facts["percentElapsed"]);
  const last = p.messages.at(-1);
  const level = (risk: string, c: number) => env({ risk }, c, [], "NONE");
  if (!Number.isFinite(pct)) return level("MEDIUM", 0.5);
  if (last && last.direction !== "INBOUND" && NEARLY_DONE.test(last.text)) return level("LOW", 0.85);
  if (last && last.direction === "INBOUND" && BLOCKED.test(last.text)) return level("HIGH", 0.85);
  if (pct >= 95) return level("HIGH", 0.8);
  if (last && last.direction !== "INBOUND" && PROGRESS.test(last.text)) return level("MEDIUM", 0.8);
  return level(pct >= 90 ? "HIGH" : "MEDIUM", 0.75);
}

const CORR_STOP = new Set("the and for are but not you your our out has have had was were with this that from they them their what when where which who will would could should can cant cannot get got just now all any one two its about after before again also been more some such only other each those these here please thanks thank hello dear regards team need help".split(" "));
const corrWords = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !CORR_STOP.has(w)));
const corrRefs = (t: string) => new Set([...t.matchAll(/#\d{3,}|\b[A-Za-z]{2,6}-\d{2,}\b|\b\d{5,}\b/g)].map((m) => m[0].toLowerCase()));
const verbatim = (text: string, token: string) => text.match(new RegExp(esc(token), "i"))?.[0] ?? null;

/** Advisory: the same matter if the two messages share a reference number or enough wording. Never links anything. */
function correlation(p: Parsed): Env {
  const first = p.messages[0];
  const last = p.messages.at(-1);
  const out = (v: "yes" | "no" | "unsure", c: number, ev: Env["evidence"] = []) => env({ sameMatter: v }, c, ev, v === "yes" ? "LINK_CANDIDATE" : "NONE");
  if (!first || !last || first.id === last.id) return out("unsure", 0.5);
  const [a, b] = [corrWords(first.text), corrWords(last.text)];
  const shared = [...a].filter((w) => b.has(w));
  const jac = a.size + b.size === 0 ? 0 : shared.length / (a.size + b.size - shared.length);
  const refs = [...corrRefs(first.text)].filter((r) => corrRefs(last.text).has(r));
  const quote = (token: string) => {
    const x = verbatim(first.text, token);
    const y = verbatim(last.text, token);
    return x && y ? [{ messageId: first.id, quote: x }, { messageId: last.id, quote: y }] : null;
  };
  if (refs[0]) { const ev = quote(refs[0]); if (ev) return out("yes", 0.9, ev); }
  const best = [...shared].sort((x, y) => y.length - x.length)[0];
  if (jac >= 0.3 && shared.length >= 3 && best) { const ev = quote(best); if (ev) return out("yes", 0.8, ev); }
  if (jac < 0.1) return out("no", 0.85);
  return out("unsure", 0.7);
}

export class HeuristicProvider implements LLMProvider {
  readonly name = "fake-heuristic";
  readonly model = "heuristic-1";

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const p = parse(req.user);
    let json: Env;
    switch (req.analyzer) {
      case "intent_classifier": json = intent(p); break;
      case "ownership_resolver": json = ownership(p); break;
      case "acknowledgment_detector": json = reply(p, "ack"); break;
      case "substantive_response": json = reply(p, "sub"); break;
      case "progress_analyzer": json = progress(p); break;
      case "resolution_analyzer": json = resolution(p); break;
      case "sla_risk_analyzer": json = slaRisk(p); break;
      case "correlation_analyzer": json = correlation(p); break;
      default: return { kind: "output", json: undefined, tokensIn: tokens(req.system) + tokens(req.user), tokensOut: 0, model: this.model }; // unknown analyzer: invalid on purpose
    }
    return { kind: "output", json, tokensIn: tokens(req.system) + tokens(req.user), tokensOut: tokens(JSON.stringify(json)), model: this.model };
  }
}

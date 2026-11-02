import type { Candidate, ShipmentCase, ShipmentDocument } from "./types.ts";
import { normalizedShipmentValue } from "./shipment-autofill.ts";

/** Grouping works on evidence from the entire batch, never upload order or email sender. */
type Profile = {
  documentIds: string[];
  caseIds: string[];
  facts: Map<string, Set<string>>;
  strong: Map<string, Set<string>>;
  synthetic: boolean;
};
export type ShipmentGroup = {
  documentIds: string[];
  caseIds: string[];
  confirmed: boolean;
  reason: string;
  evidence: string[];
};
type Match = { reason: string; rank: number };
const normalized = (value: string) =>
  value.normalize("NFKC").trim().toUpperCase().replace(/\s+/g, " ");
const set = (profile: Profile, field: string) =>
  profile.facts.get(field) ?? new Set<string>();
const reliable = (profile: Profile, field: string) =>
  profile.strong.get(field) ?? new Set<string>();
const overlap = (a: Set<string>, b: Set<string>) =>
  [...a].some((value) => b.has(value));
const intersects = (a: Profile, b: Profile, field: string) =>
  overlap(set(a, field), set(b, field));
const strongMatch = (a: Profile, b: Profile, field: string) =>
  overlap(reliable(a, field), reliable(b, field));
const disjoint = (a: Set<string>, b: Set<string>) =>
  a.size > 0 && b.size > 0 && !overlap(a, b);
const roleField = (field: string) =>
  ({ houseConsignee: "importer", houseShipper: "exporter" })[field] ?? field;
function add(map: Map<string, Set<string>>, field: string, value: string) {
  const values = map.get(field) ?? new Set<string>();
  values.add(value);
  map.set(field, values);
}
function valueKey(field: string, value: string) {
  if (["importer", "exporter"].includes(field))
    return normalizedShipmentValue(field, value);
  if (
    ["grossWeight", "netWeight", "packageCount"].includes(field) &&
    /^\d+(?:\.\d+)?$/.test(value)
  )
    return value
      .replace(/^0+(?=\d)/, "")
      .replace(/(\.\d*?)0+$/, "$1")
      .replace(/\.$/, "");
  return normalized(value);
}
function profile(document: ShipmentDocument, candidates: Candidate[]): Profile {
  const result: Profile = {
    documentIds: [document.id],
    caseIds: document.caseId ? [document.caseId] : [],
    facts: new Map(),
    strong: new Map(),
    synthetic: document.synthetic,
  };
  for (const candidate of candidates.filter(
    (item) =>
      item.documentId === document.id &&
      item.documentVersion === document.version &&
      !item.lineId,
  )) {
    const field = roleField(candidate.field);
    const values =
      field === "container"
        ? (candidate.value.match(/\b[A-Z]{4}\d{7}\b/gi) ?? [])
        : [candidate.value];
    for (const value of values) {
      const key = valueKey(field, value);
      add(result.facts, field, key);
      // AI proposals may corroborate other evidence; a lone low-confidence identifier cannot merge shipments.
      if (candidate.confidence !== "low") add(result.strong, field, key);
    }
  }
  // Group only typed source candidates; raw document text is never an extraction fallback.
  return result;
}
function combined(profiles: Profile[]): Profile {
  const merged: Profile = {
    documentIds: [],
    caseIds: [],
    facts: new Map(),
    strong: new Map(),
    synthetic: profiles[0].synthetic,
  };
  for (const p of profiles) {
    merged.documentIds.push(...p.documentIds);
    merged.caseIds.push(...p.caseIds);
    for (const [field, values] of p.facts)
      for (const value of values) add(merged.facts, field, value);
    for (const [field, values] of p.strong)
      for (const value of values) add(merged.strong, field, value);
  }
  merged.documentIds.sort();
  merged.caseIds = [...new Set(merged.caseIds)].sort();
  return merged;
}
function incompatible(a: Profile, b: Profile) {
  return (
    a.synthetic !== b.synthetic ||
    disjoint(set(a, "houseBillOfLading"), set(b, "houseBillOfLading")) ||
    disjoint(set(a, "billOfLading"), set(b, "billOfLading"))
  );
}
function match(a: Profile, b: Profile): Match | undefined {
  if (incompatible(a, b)) return;
  if (strongMatch(a, b, "houseBillOfLading"))
    return { rank: 100, reason: "Cùng số vận đơn House (HBL)." };
  // An unqualified B/L is not silently reinterpreted as a master or house number.
  if (strongMatch(a, b, "billOfLading"))
    return { rank: 95, reason: "Cùng số vận đơn ghi rõ trên chứng từ." };
  const parties = ["importer", "exporter"].filter((field) =>
    intersects(a, b, field),
  ).length;
  const partyConflict = ["importer", "exporter"].some((field) =>
    disjoint(set(a, field), set(b, field)),
  );
  const container = strongMatch(a, b, "container");
  const seal = strongMatch(a, b, "seal");
  if (
    !partyConflict &&
    !disjoint(set(a, "invoiceNumber"), set(b, "invoiceNumber")) &&
    container && seal && parties > 0
  )
    return {
      rank: 90,
      reason: "Cùng cặp container và niêm phong, không có HBL trái ngược.",
    };
  const invoice = strongMatch(a, b, "invoiceNumber");
  const invoiceContext =
    parties > 0 ||
    strongMatch(a, b, "invoiceDate") ||
    strongMatch(a, b, "contractNumber") ||
    container;
  if (invoice && invoiceContext && !partyConflict)
    return {
      rank: 85,
      reason: "Cùng số hóa đơn và thông tin đối chiếu của lô hàng.",
    };
  if (disjoint(set(a, "invoiceNumber"), set(b, "invoiceNumber"))) return;
  const packageAndWeight =
    strongMatch(a, b, "packageCount") && strongMatch(a, b, "grossWeight");
  const route = ["vessel", "voyage", "portOfLoading", "portOfDischarge"].filter(
    (field) => strongMatch(a, b, field),
  ).length;
  const supports =
    Number(container) +
    Number(packageAndWeight) +
    Number(route > 0) +
    Number(parties > 0);
  if (strongMatch(a, b, "transportReference") && supports >= 2)
    return {
      rank: 80,
      reason:
        "Cùng booking / tham chiếu vận chuyển và nhiều thông tin vận chuyển đối chiếu.",
    };
  if (!partyConflict && parties === 2 && packageAndWeight)
    return {
      rank: 70,
      reason:
        "Cùng bên mua, bên bán, tổng số kiện và tổng trọng lượng; không có HBL trái ngược.",
    };
  // Shared MBL, contract, sender, vessel or parties by themselves are deliberately insufficient.
  return;
}

/** Existing cases remain intact; strong new bridges may unite them. Ambiguous bridges remain separate. */
export function groupShipmentDocuments(
  documents: ShipmentDocument[],
  candidates: Candidate[],
  cases: ShipmentCase[],
): ShipmentGroup[] {
  const casesById = new Map(cases.map((shipment) => [shipment.id, shipment]));
  const canAutomaticallyCombine = (a: Profile, b: Profile) => {
    const existing = [...new Set([...a.caseIds, ...b.caseIds])];
    if (!existing.length) return true;
    // A reviewer chose these case boundaries through targeted upload or an
    // explicit move/merge. AI may add corroborating new originals, but joining
    // two existing cases still requires the reviewer to choose that operation.
    if (existing.length > 1 && existing.some(id => casesById.get(id)?.groupingMode === 'manual')) return false;
    const types = existing.map((id) => casesById.get(id)?.caseType);
    // Identifiers may be reused across an import and later re-export. An
    // unresolved direction or reference collection never establishes a new link.
    if (types.some((type) => type !== "import" && type !== "export")) return false;
    if (new Set(types).size !== 1) return false;
    // Incoming attachments use the import intake flow. They cannot silently
    // inherit an export direction just because a historical reference matches.
    if (!a.caseIds.length || !b.caseIds.length) return types[0] === "import";
    return true;
  };
  const byCase = new Map<string, Profile[]>();
  for (const document of [...documents].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const key = document.caseId || `new:${document.id}`;
    byCase.set(key, [
      ...(byCase.get(key) ?? []),
      profile(document, candidates),
    ]);
  }
  let groups = [...byCase.values()].map((items) => {
    const evidence: string[] = [];
    const reached = new Set([0]);
    for (;;) {
      let changed = false;
      for (let i = 0; i < items.length; i++)
        if (!reached.has(i)) {
          const linked = match(
            combined([...reached].map((n) => items[n])),
            items[i],
          );
          if (linked) {
            reached.add(i);
            evidence.push(linked.reason);
            changed = true;
          }
        }
      if (!changed) break;
    }
    return {
      profile: combined(items),
      evidence: reached.size === items.length ? [...new Set(evidence)] : [],
      uncertain: false,
    };
  });
  for (;;) {
    const edges: { a: number; b: number; match: Match }[] = [];
    for (let a = 0; a < groups.length; a++)
      for (let b = a + 1; b < groups.length; b++) {
        if (!canAutomaticallyCombine(groups[a].profile, groups[b].profile)) continue;
        const evidence = match(groups[a].profile, groups[b].profile);
        if (evidence) edges.push({ a, b, match: evidence });
      }
    if (!edges.length) break;
    const ambiguous = new Set<number>();
    for (let i = 0; i < groups.length; i++) {
      const neighbors = edges
        .filter((edge) => edge.a === i || edge.b === i)
        .map((edge) => (edge.a === i ? edge.b : edge.a));
      if (
        neighbors.some((a, n) =>
          neighbors
            .slice(n + 1)
            .some((b) => incompatible(groups[a].profile, groups[b].profile)),
        )
      )
        ambiguous.add(i);
    }
    for (const i of ambiguous) groups[i].uncertain = true;
    const safe = edges
      .filter((edge) => !ambiguous.has(edge.a) && !ambiguous.has(edge.b))
      .sort(
        (a, b) =>
          b.match.rank - a.match.rank ||
          groups[a.a].profile.documentIds[0].localeCompare(
            groups[b.a].profile.documentIds[0],
          ) ||
          groups[a.b].profile.documentIds[0].localeCompare(
            groups[b.b].profile.documentIds[0],
          ),
      );
    if (!safe.length) break;
    // Merge a single best-supported edge, then reevaluate against the enlarged evidence set.
    const edge = safe[0];
    const merged = {
      profile: combined([groups[edge.a].profile, groups[edge.b].profile]),
      evidence: [
        ...new Set([
          ...groups[edge.a].evidence,
          ...groups[edge.b].evidence,
          edge.match.reason,
        ]),
      ],
      uncertain: false,
    };
    groups = groups.filter((_, i) => i !== edge.a && i !== edge.b);
    groups.push(merged);
    groups.sort((a, b) =>
      a.profile.documentIds[0].localeCompare(b.profile.documentIds[0]),
    );
  }
  return groups
    .map(({ profile: p, evidence, uncertain }) => {
      const priorConfirmed =
        p.caseIds.length === 1 &&
        !!cases.find((c) => c.id === p.caseIds[0])?.groupingConfirmed;
      const conflictingBills =
        set(p, "houseBillOfLading").size > 1 || set(p, "billOfLading").size > 1;
      const confirmed =
        !uncertain &&
        !conflictingBills &&
        (evidence.length > 0 || priorConfirmed);
      return {
        documentIds: p.documentIds,
        caseIds: p.caseIds,
        confirmed,
        evidence,
        reason: conflictingBills
          ? "Nhóm có số vận đơn trái ngược; cần kiểm tra và tách chứng từ nếu thuộc nhiều lô hàng."
          : uncertain
            ? "Thông tin khớp nhiều lô hàng có vận đơn khác nhau; cần xác nhận lô hàng nhận chứng từ."
            : evidence.length
              ? evidence.join(" ")
              : priorConfirmed
                ? cases.find((c) => c.id === p.caseIds[0])!.groupingReason
                : p.caseIds.length === 1 && casesById.get(p.caseIds[0])?.groupingMode === 'manual'
                  ? "Chứng từ được thêm vào hồ sơ đã chọn; cần đối chiếu nội dung để xác nhận cùng lô hàng."
                  : "Chưa có đủ định danh và thông tin đối chiếu duy nhất; chứng từ được giữ riêng để xác nhận.",
      };
    })
    .sort((a, b) => a.documentIds[0].localeCompare(b.documentIds[0]));
}

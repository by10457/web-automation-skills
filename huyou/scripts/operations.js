/** 狐友：操作记录查询、证据和恢复。 */
import { storage } from "./storage.js";
import { readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Journal } from "./lib/actions/journal.js";
import { verifyPlan, operationKey, fail } from "./lib/actions/schema.js";
import { withLock } from "./lib/runner.js";
import { workspacePath } from "./config.js";
import { withHuyou } from "./session.js";
import { pauseBeforeOperation } from "./lib/pacing.js";
import {
  checkAccount,
  ensureNoDraft,
  readDetail,
  closeDetail,
} from "./lib/actions/dom.js";
import { readSnapshot, assertContext } from "./lib/snapshot.js";
import { DraftStore, assertOwnedDraft } from "./lib/actions/drafts.js";
import { HuyouAdapter } from "./lib/actions/adapter.js";
import { hash } from "./lib/actions/schema.js";

export async function recoverOwnedDraft(options) {
  const plan = sealedActionPlan(options.plan);
  if (options.page)
    fail(
      "MANAGED_SESSION_REQUIRED",
      "草稿恢复需由技能连接并锁定窗口，不接受外部 page",
    );
  return withHuyou(
    { ...options, binding: plan.binding, requireContext: false },
    async ({ page, binding, workspace, targetId }) => {
      await pauseBeforeOperation();
      const store = new DraftStore(workspacePath(workspace)),
        record = await store.get(plan.digest);
      assertOwnedDraft(record, plan, targetId);
      if (hash(binding) !== hash(plan.binding))
        fail("BINDING_CHANGED", "绑定已变化");
      const adapter = new HuyouAdapter(page, binding, {
        plan,
        targetId,
        draftStore: store,
      });
      await checkAccount(
        page,
        binding.expectedAccountName,
        plan.evidence.account,
      );
      assertContext(await readSnapshot(page), binding);
      await adapter.assertStaged(plan.task, plan.evidence);
      const extra = await page.evaluate(
        (selector) =>
          [...document.querySelectorAll("input[type=file]")].some(
            (e) => e.files?.length,
          ) ||
          [
            ...document.querySelectorAll(
              ".detail-input__textarea,.publish-editor__content",
            ),
          ].some(
            (e) => !e.matches(selector) && (e.value ?? e.innerText)?.trim(),
          ),
        record.selector,
      );
      if (extra) fail("EXISTING_DRAFT", "存在其他草稿或附件，保留现场");
      const dir = storage(workspacePath(workspace), "recovery", randomUUID());
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "draft.json"),
        JSON.stringify(record, null, 2),
      );
      await page.screenshot({ path: path.join(dir, "page.png") });
      adapter.ownDraft = record;
      await adapter.clearOwnDraft();
      return {
        status: "draft-cleared",
        evidenceDir: dir,
        operationStatusUnchanged: true,
        nextAction: "reconcile-before-any-resubmission",
      };
    },
  );
}

export function sealedActionPlan(value) {
  const { runId, runDir, planFile, cleanupWarning, ...plan } = value;
  verifyPlan(plan, 0);
  return plan;
}
export async function listOperations({ workspace, status, limit = 100 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    fail("INVALID_LIMIT", "limit 为 1–1000");
  const journal = new Journal(workspacePath(workspace));
  let names;
  try {
    names = await readdir(journal.dir);
  } catch (e) {
    if (e.code === "ENOENT") return { operations: [], complete: true };
    throw e;
  }
  const rows = [];
  for (const name of names
    .filter((n) => /^[a-f0-9]{64}\.json$/.test(n))
    .sort()) {
    const key = name.slice(0, -5),
      record = await journal.get(key);
    if (!status || record.status === status)
      rows.push({ ...record, operationKey: key });
  }
  return {
    operations: rows.slice(0, limit),
    complete: rows.length <= limit,
    total: rows.length,
  };
}
export async function recordOperationEvidence({
  workspace,
  plan: input,
  source,
  note,
  confirmed = false,
}) {
  if (
    !["external-execution", "user-confirmation"].includes(source) ||
    typeof note !== "string" ||
    !note.trim() ||
    typeof confirmed !== "boolean" ||
    (confirmed && source !== "user-confirmation")
  )
    fail(
      "INVALID_EVIDENCE",
      "需要来源、说明；仅明确的用户确认可标为 confirmed",
    );
  const plan = sealedActionPlan(input),
    root = workspacePath(workspace),
    key = operationKey(plan),
    journal = new Journal(root);
  return withLock(root, plan.binding.browserId, async () => {
    const prior = await journal.get(key);
    const entry = { source, note, confirmed, at: new Date().toISOString() };
    const record = {
      ...(prior || { status: "external-unverified", planDigest: plan.digest }),
      operationKey: key,
      evidenceHistory: [...(prior?.evidenceHistory || []), entry],
    };
    if (
      confirmed &&
      ![
        "verified-ui",
        "skipped-already-liked",
        "skipped-already-followed",
      ].includes(record.status)
    )
      record.status = "confirmed-by-user";
    if (prior) await journal.finish(key, record);
    else await journal.begin(key, record);
    return { status: record.status, operationKey: key };
  });
}
export async function recoverInteractionPage(options) {
  return withHuyou(
    { ...options, requireContext: false },
    async ({ page, binding, workspace }) => {
      await pauseBeforeOperation();
      await checkAccount(page, binding.expectedAccountName);
      await ensureNoDraft(page);
      assertContext(await readSnapshot(page), binding);
      const dir = storage(workspacePath(workspace), "recovery", randomUUID());
      await mkdir(dir, { recursive: true });
      const detail = (await page.$(".feed-detail"))
        ? await readDetail(page)
        : null;
      await writeFile(
        path.join(dir, "snapshot.json"),
        JSON.stringify(
          { url: page.url(), detail, at: new Date().toISOString() },
          null,
          2,
        ),
      );
      await page.screenshot({ path: path.join(dir, "page.png") });
      await closeDetail(page);
      assertContext(await readSnapshot(page), binding);
      return {
        status: "recovered",
        closedDetail: Boolean(detail),
        evidenceDir: dir,
        operationStatusUnchanged: true,
      };
    },
  );
}
export function classifyInteractionResult(result) {
  const code = result?.code || result?.error?.code,
    status = result?.status;
  if (
    [
      "verified-ui",
      "skipped-duplicate",
      "skipped-already-liked",
      "skipped-already-followed",
      "confirmed-by-user",
      "rehearsed",
    ].includes(status) &&
    !result.cleanupWarning
  )
    return { decision: "continue", retrySubmission: false };
  if (
    [
      "uncertain",
      "blocked-uncertain",
      "pending",
      "external-unverified",
      "blocked-previous-operation",
    ].includes(status)
  )
    return { decision: "reconcile", retrySubmission: false };
  return {
    decision: "stop",
    retrySubmission: false,
    reason: code || result?.cleanupWarning || status || "UNKNOWN_RESULT",
  };
}

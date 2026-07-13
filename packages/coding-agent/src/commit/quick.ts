import type { Settings } from "../config/settings";
import type { HookCommandContext } from "../extensibility/hooks/types";
import * as git from "../utils/git";
import { resolvePrimaryModel } from "./model-selection";
import { generateQuickCommitPlan, type QuickCommitPlan, type QuickCommitPlanItem } from "./quick-planner";

export type { QuickCommitPlan } from "./quick-planner";

const RECENT_COMMITS_COUNT = 8;
const MAX_DIFF_CHARS = 120_000;
const CONVENTIONAL_MESSAGE =
	/^(feat|fix|refactor|docs|test|chore|style|perf|build|ci|revert)(\([a-z0-9_-]+(?:\/[a-z0-9_-]+)?\))?!?:\s\S/m;

export interface QuickCommitResult {
	commitCount: number;
	branchName?: string;
}

export interface QuickCommitBranchContext {
	hasUI: boolean;
	ui: Pick<HookCommandContext["ui"], "select">;
}

export interface QuickCommitBranch {
	name: string;
	action: "create" | "checkout";
}

export async function runQuickCommit(
	startDir: string,
	ctx: HookCommandContext,
	settings: Settings,
): Promise<QuickCommitResult | undefined> {
	const cwd = await resolveQuickCommitCwd(startDir);
	let stagedFiles = await git.diff.changedFiles(cwd, { cached: true });
	if (stagedFiles.length === 0) {
		ctx.ui.setStatus("commit", "Staging changes…");
		await git.stage.files(cwd);
		stagedFiles = await git.diff.changedFiles(cwd, { cached: true });
	}
	if (stagedFiles.length === 0) {
		ctx.ui.setStatus("commit", undefined);
		ctx.ui.notify("No changes to commit.", "warning");
		return undefined;
	}

	ctx.ui.setStatus("commit", "Preparing commit plan…");
	const [diff, stat, numstat, recentCommits, currentBranch, defaultBranch] = await Promise.all([
		git.diff(cwd, { cached: true }),
		git.diff(cwd, { cached: true, stat: true }),
		git.diff(cwd, { cached: true, numstat: true }),
		git.log.subjects(cwd, RECENT_COMMITS_COUNT),
		git.branch.current(cwd),
		git.branch.default(cwd),
	]);
	if (
		settings.get("commit.messageFormat") === "user-submitted" &&
		!settings.get("commit.messageInstructions")?.trim()
	) {
		throw new Error("Commit Message Instructions are required when using the User-submitted message format.");
	}
	const resolved = await resolvePrimaryModel(undefined, settings, ctx.modelRegistry);
	const plan = await generateQuickCommitPlan({
		model: resolved.model,
		apiKey: resolved.apiKey,
		thinkingLevel: resolved.thinkingLevel,
		splitMode: settings.get("commit.splitMode"),
		messageFormat: settings.get("commit.messageFormat"),
		messageInstructions: settings.get("commit.messageInstructions") ?? "",
		files: stagedFiles,
		stat,
		numstat,
		recentCommits,
		diff: limitDiff(diff),
	});
	validateQuickCommitPlan(plan, stagedFiles, settings.get("commit.splitMode"), settings.get("commit.messageFormat"));

	if (plan.commits.length > 1) {
		if (!ctx.hasUI) throw new Error("Split commit plans require an interactive session.");
		const confirmed = await ctx.ui.confirm("Create split commits", formatSplitPlan(plan));
		if (!confirmed) {
			ctx.ui.setStatus("commit", undefined);
			return undefined;
		}
	}

	const branch = await resolveQuickCommitBranch(cwd, ctx, settings, currentBranch, defaultBranch, plan);
	if (branch) {
		if (branch.action === "create") {
			await git.branch.checkoutNew(cwd, branch.name);
		} else {
			await git.checkout(cwd, branch.name);
		}
	}
	const branchName = branch?.name;

	ctx.ui.setStatus("commit", "Creating commit…");
	try {
		if (plan.commits.length === 1) {
			await git.commit(cwd, plan.commits[0].message);
		} else {
			await createSplitCommits(cwd, plan);
		}
		ctx.ui.notify(`Created ${plan.commits.length} commit${plan.commits.length === 1 ? "" : "s"}.`, "info");
		return { commitCount: plan.commits.length, branchName };
	} finally {
		ctx.ui.setStatus("commit", undefined);
	}
}

export async function resolveQuickCommitCwd(startDir: string): Promise<string> {
	const cwd = await git.repo.root(startDir);
	if (!cwd) throw new Error("Commit requires a Git repository.");
	return cwd;
}

function limitDiff(diff: string): string {
	if (diff.length <= MAX_DIFF_CHARS) return diff;
	return `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[Diff truncated after ${MAX_DIFF_CHARS} characters; file metadata is complete.]`;
}

export function validateQuickCommitPlan(
	plan: QuickCommitPlan,
	stagedFiles: string[],
	splitMode: "on" | "off" | "auto",
	messageFormat: "conventional" | "freeform" | "user-submitted",
): void {
	if (plan.commits.length === 0) throw new Error("Commit planner returned no commits.");
	if (splitMode === "off" && plan.commits.length !== 1) {
		throw new Error("Commit planner returned multiple commits while split commits are disabled.");
	}
	const staged = new Set(stagedFiles);
	const assigned = new Set<string>();
	for (const commit of plan.commits) {
		if (commit.files.length === 0) throw new Error("Commit planner returned an empty file group.");
		if (!commit.message) throw new Error("Commit planner returned an empty commit message.");
		if (!commit.body) throw new Error("Commit planner returned an empty commit body.");
		if (!commit.branchType) throw new Error("Commit planner returned an empty branch type.");
		if (messageFormat === "conventional" && !CONVENTIONAL_MESSAGE.test(commit.message)) {
			throw new Error(`Commit message is not conventional: ${commit.message.split("\n", 1)[0]}`);
		}
		for (const file of commit.files) {
			if (!staged.has(file)) throw new Error(`Commit planner included a file that is not staged: ${file}`);
			if (assigned.has(file)) throw new Error(`Commit planner assigned a file to multiple commits: ${file}`);
			assigned.add(file);
		}
	}
	for (const file of stagedFiles) {
		if (!assigned.has(file)) throw new Error(`Commit planner omitted staged file: ${file}`);
	}
}

export async function resolveQuickCommitBranch(
	cwd: string,
	ctx: QuickCommitBranchContext,
	settings: Settings,
	currentBranch: string | null,
	defaultBranch: string | null,
	plan: QuickCommitPlan,
): Promise<QuickCommitBranch | undefined> {
	if (!isProtectedBranch(currentBranch, defaultBranch)) return undefined;
	const protection = settings.get("commit.mainBranchProtection");
	if (protection === "off") return undefined;
	const branchName = renderBranchName(settings.get("commit.branchNameTemplate") ?? "{type}/{slug}", plan.commits[0]);
	const branchExists = await git.ref.exists(cwd, `refs/heads/${branchName}`);
	if (protection === "on") {
		if (branchExists) throw new Error(`Feature branch already exists: ${branchName}`);
		return { name: branchName, action: "create" };
	}
	if (!ctx.hasUI) throw new Error("Main branch protection is set to ask, but this session is not interactive.");
	const useBranch = branchExists ? `Use existing ${branchName}` : `Create ${branchName}`;
	const commitHere = `Commit on ${currentBranch}`;
	const selected = await ctx.ui.select("Protected branch", [useBranch, commitHere]);
	if (!selected) throw new Error("Commit cancelled.");
	if (selected === commitHere) return undefined;
	return { name: branchName, action: branchExists ? "checkout" : "create" };
}

function isProtectedBranch(currentBranch: string | null, defaultBranch: string | null): boolean {
	if (!currentBranch) return false;
	return currentBranch === defaultBranch || currentBranch === "main" || currentBranch === "master";
}

function renderBranchName(template: string, commit: QuickCommitPlanItem): string {
	const type = normalizeBranchSegment(commit.branchType);
	const scope = commit.branchScope ? normalizeBranchSegment(commit.branchScope) : "";
	const subject = commit.message.split("\n", 1)[0].replace(/^[a-z]+(?:\([^)]+\))?!?:\s*/i, "");
	const slug = normalizeBranchSegment(subject);
	const name = template
		.replaceAll("{type}", type)
		.replaceAll("{scope}", scope)
		.replaceAll("{slug}", slug)
		.replace(/\/{2,}/g, "/")
		.replace(/^\/+|\/+$/g, "");
	if (
		!name ||
		name.startsWith(".") ||
		name.endsWith(".") ||
		name.includes("..") ||
		name.includes("@{") ||
		name.endsWith(".lock")
	) {
		throw new Error(`Feature branch template produced an invalid name: ${name || "(empty)"}`);
	}
	return name;
}

function normalizeBranchSegment(value: string): string {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!normalized) throw new Error("Commit planner could not derive a valid branch name.");
	return normalized;
}

export async function createSplitCommits(cwd: string, plan: QuickCommitPlan): Promise<void> {
	await git.stage.reset(cwd);
	for (const commit of plan.commits) {
		await git.stage.files(cwd, commit.files);
		await git.commit(cwd, commit.message);
		await git.stage.reset(cwd);
	}
}

function formatSplitPlan(plan: QuickCommitPlan): string {
	return plan.commits
		.map((commit, index) => `${index + 1}. ${commit.message.split("\n", 1)[0]}\n   ${commit.files.join(", ")}`)
		.join("\n\n");
}

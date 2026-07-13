import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createSplitCommits,
	type QuickCommitPlan,
	resolveQuickCommitBranch,
	resolveQuickCommitCwd,
	validateQuickCommitPlan,
} from "@oh-my-pi/pi-coding-agent/commit/quick";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadCustomCommands } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/loader";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import { $ } from "bun";

let repoDir: string;

beforeEach(async () => {
	repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-quick-commit-"));
	await $`git init --initial-branch=main`.cwd(repoDir).quiet();
	await $`git config user.email tester@example.com`.cwd(repoDir).quiet();
	await $`git config user.name Tester`.cwd(repoDir).quiet();
	await Bun.write(path.join(repoDir, "baseline.txt"), "baseline\n");
	await $`git add -A && git commit -m baseline`.cwd(repoDir).quiet();
});

afterEach(async () => {
	await fs.rm(repoDir, { recursive: true, force: true });
});

describe("quick commit split execution", () => {
	it("creates whole-file commits from one staged snapshot", async () => {
		await Bun.write(path.join(repoDir, "feature.ts"), "export const enabled = true;\n");
		await Bun.write(path.join(repoDir, "docs.md"), "# Feature\n");
		await git.stage.files(repoDir);

		const plan: QuickCommitPlan = {
			commits: [
				{
					files: ["feature.ts"],
					message: "feat: add feature flag\n\n- Add the feature flag implementation.",
					body: "- Add the feature flag implementation.",
					branchType: "feat",
					branchScope: null,
				},
				{
					files: ["docs.md"],
					message: "docs: document feature flag\n\n- Document how to enable the feature flag.",
					body: "- Document how to enable the feature flag.",
					branchType: "docs",
					branchScope: null,
				},
			],
		};

		await createSplitCommits(repoDir, plan);

		expect(await git.log.subjects(repoDir, 2)).toEqual(["docs: document feature flag", "feat: add feature flag"]);
		expect((await git.commitDetails(repoDir, "HEAD")).message).toContain(
			"- Document how to enable the feature flag.",
		);
		expect(await git.status(repoDir)).toBe("");
	});

	it("rejects plans that duplicate or omit staged files before execution", () => {
		const duplicate: QuickCommitPlan = {
			commits: [
				{
					files: ["feature.ts"],
					message: "feat: add feature\n\n- Add the feature.",
					body: "- Add the feature.",
					branchType: "feat",
					branchScope: null,
				},
				{
					files: ["feature.ts"],
					message: "docs: document feature\n\n- Document the feature.",
					body: "- Document the feature.",
					branchType: "docs",
					branchScope: null,
				},
			],
		};
		expect(() => validateQuickCommitPlan(duplicate, ["feature.ts"], "auto", "conventional")).toThrow(
			"Commit planner assigned a file to multiple commits: feature.ts",
		);
		expect(() => validateQuickCommitPlan(duplicate, ["feature.ts"], "off", "conventional")).toThrow(
			"Commit planner returned multiple commits while split commits are disabled.",
		);

		const omitted: QuickCommitPlan = {
			commits: [
				{
					files: ["feature.ts"],
					message: "feat: add feature\n\n- Add the feature.",
					body: "- Add the feature.",
					branchType: "feat",
					branchScope: null,
				},
			],
		};
		expect(() => validateQuickCommitPlan(omitted, ["feature.ts", "docs.md"], "auto", "conventional")).toThrow(
			"Commit planner omitted staged file: docs.md",
		);

		const bodyless: QuickCommitPlan = {
			commits: [
				{ files: ["feature.ts"], message: "feat: add feature", body: "", branchType: "feat", branchScope: null },
			],
		};
		expect(() => validateQuickCommitPlan(bodyless, ["feature.ts"], "auto", "conventional")).toThrow(
			"Commit planner returned an empty commit body.",
		);
	});
});

describe("quick commit repository resolution", () => {
	it("uses the repository root when invoked from a nested directory", async () => {
		const nestedDir = path.join(repoDir, "packages", "coding-agent", "src");
		await fs.mkdir(nestedDir, { recursive: true });

		expect(await resolveQuickCommitCwd(nestedDir)).toBe(repoDir);
	});
});

describe("quick commit command", () => {
	it("registers commit in the in-session command list", async () => {
		const result = await loadCustomCommands({ cwd: repoDir, agentDir: path.join(repoDir, ".omp") });

		expect(result.commands.some(command => command.command.name === "commit")).toBe(true);
	});
});

describe("quick commit protected branch choices", () => {
	it("asks to use an existing feature branch instead of failing before selection", async () => {
		await git.branch.create(repoDir, "feat/add-feature");
		const settings = Settings.isolated({ "commit.mainBranchProtection": "ask" });
		const plan: QuickCommitPlan = {
			commits: [
				{
					files: ["feature.ts"],
					message: "feat: add feature\n\n- Add the feature.",
					body: "- Add the feature.",
					branchType: "feat",
					branchScope: null,
				},
			],
		};

		const selected = await resolveQuickCommitBranch(
			repoDir,
			{
				hasUI: true,
				ui: {
					select: async (_title, options) => {
						expect(options).toEqual(["Use existing feat/add-feature", "Commit on main"]);
						return options[0];
					},
				},
			},
			settings,
			"main",
			"main",
			plan,
		);

		expect(selected).toEqual({ name: "feat/add-feature", action: "checkout" });
	});
});

describe("quick commit settings", () => {
	it("defaults to protected, adaptive conventional commits", () => {
		const settings = Settings.isolated();

		expect(settings.get("commit.mainBranchProtection")).toBe("ask");
		expect(settings.get("commit.splitMode")).toBe("auto");
		expect(settings.get("commit.messageFormat")).toBe("conventional");
		expect(settings.get("commit.branchNameTemplate")).toBe("{type}/{slug}");
	});
});

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

let repoDir: string;

beforeEach(async () => {
	repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-quick-commit-"));
	await git.repo.init(repoDir, { initialBranch: "main" });
	await git.config.set(repoDir, "user.email", "tester@example.com");
	await git.config.set(repoDir, "user.name", "Tester");
	await Bun.write(path.join(repoDir, "baseline.txt"), "baseline\n");
	await git.stage.files(repoDir);
	await git.commit(repoDir, "baseline");
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

	it("commits only the staged snapshot when a split file also has unstaged hunks", async () => {
		await Bun.write(path.join(repoDir, "tracked.txt"), "one\n");
		await git.stage.files(repoDir);
		await git.commit(repoDir, "chore: seed tracked file");

		await Bun.write(path.join(repoDir, "tracked.txt"), "one\ntwo\n");
		await Bun.write(path.join(repoDir, "docs.md"), "# Feature\n");
		await git.stage.files(repoDir);
		// Left unstaged on purpose: the split executor must not fold this in.
		await Bun.write(path.join(repoDir, "tracked.txt"), "one\ntwo\nthree\n");

		const plan: QuickCommitPlan = {
			commits: [
				{
					files: ["tracked.txt"],
					message: "feat: extend tracked file\n\n- Add the staged line.",
					body: "- Add the staged line.",
					branchType: "feat",
					branchScope: null,
				},
				{
					files: ["docs.md"],
					message: "docs: document the feature\n\n- Document the feature.",
					body: "- Document the feature.",
					branchType: "docs",
					branchScope: null,
				},
			],
		};

		await createSplitCommits(repoDir, plan);

		expect(await git.log.subjects(repoDir, 2)).toEqual(["docs: document the feature", "feat: extend tracked file"]);
		// Everything committed matches the staged snapshot, so the only remaining
		// difference between HEAD and the working tree is the never-staged hunk.
		const residual = await git.diff(repoDir);
		expect(residual).toContain("+three");
		expect(residual).not.toContain("+two");
		expect(await git.diff.changedFiles(repoDir, { cached: true })).toEqual([]);
	});

	it("preserves a staged rename across split commits", async () => {
		await Bun.write(path.join(repoDir, "old.txt"), "alpha\nbeta\ngamma\n");
		await git.stage.files(repoDir);
		await git.commit(repoDir, "chore: seed renamed file");

		await fs.rename(path.join(repoDir, "old.txt"), path.join(repoDir, "new.txt"));
		await Bun.write(path.join(repoDir, "docs.md"), "# Feature\n");
		await git.stage.files(repoDir);
		expect(await git.diff.changedFiles(repoDir, { cached: true })).toEqual(["docs.md", "new.txt"]);

		const plan: QuickCommitPlan = {
			commits: [
				{
					files: ["new.txt"],
					message: "refactor: rename the file\n\n- Rename old.txt to new.txt.",
					body: "- Rename old.txt to new.txt.",
					branchType: "refactor",
					branchScope: null,
				},
				{
					files: ["docs.md"],
					message: "docs: document the rename\n\n- Document the rename.",
					body: "- Document the rename.",
					branchType: "docs",
					branchScope: null,
				},
			],
		};

		await createSplitCommits(repoDir, plan);

		const tracked = await git.ls.tree(repoDir, "HEAD");
		expect(tracked).toContain("new.txt");
		expect(tracked).not.toContain("old.txt");
		expect(await git.status(repoDir)).toBe("");
	});

	it("rejects a nonconventional subject whose body contains a conventional line", () => {
		const buriedPrefix: QuickCommitPlan = {
			commits: [
				{
					files: ["feature.ts"],
					message: "release the thing\n\nfeat: buried in body",
					body: "feat: buried in body",
					branchType: "feat",
					branchScope: null,
				},
			],
		};
		expect(() => validateQuickCommitPlan(buriedPrefix, ["feature.ts"], "auto", "conventional")).toThrow(
			"Commit message is not conventional: release the thing",
		);
		expect(() => validateQuickCommitPlan(buriedPrefix, ["feature.ts"], "auto", "freeform")).not.toThrow();
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

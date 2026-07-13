import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, ApiKey, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { completeSimple, validateToolCall } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { toReasoningEffort } from "../thinking";
import quickSystemPrompt from "./prompts/quick-system.md" with { type: "text" };
import quickUserPrompt from "./prompts/quick-user.md" with { type: "text" };
import { extractToolCall } from "./utils";

const quickCommitSchema = type({
	files: "string[]",
	subject: "string",
	body: "string",
	branch_type: "string",
	branch_scope: type("string").or("null"),
});

const quickCommitPlanSchema = type({
	commits: quickCommitSchema.array(),
});

const QuickCommitPlanTool = {
	name: "propose_quick_commit_plan",
	description: "Return the complete whole-file commit plan for the provided staged diff.",
	parameters: quickCommitPlanSchema,
};

export interface QuickCommitPlanItem {
	files: string[];
	message: string;
	body: string;
	branchType: string;
	branchScope: string | null;
}

export interface QuickCommitPlan {
	commits: QuickCommitPlanItem[];
}

export interface GenerateQuickCommitPlanInput {
	model: Model<Api>;
	apiKey: ApiKey;
	thinkingLevel?: ThinkingLevel;
	splitMode: "on" | "off" | "auto";
	messageFormat: "conventional" | "freeform" | "user-submitted";
	messageInstructions: string;
	files: string[];
	stat: string;
	numstat: string;
	recentCommits: string[];
	diff: string;
}

export async function generateQuickCommitPlan(input: GenerateQuickCommitPlanInput): Promise<QuickCommitPlan> {
	const systemPrompt = prompt.render(quickSystemPrompt, {
		split_mode: input.splitMode,
		message_format: input.messageFormat,
		message_instructions:
			input.messageFormat === "user-submitted" ? input.messageInstructions.trim() || undefined : undefined,
	});
	const userPrompt = prompt.render(quickUserPrompt, {
		files: input.files.join("\n"),
		stat: input.stat,
		numstat: input.numstat,
		recent_commits: input.recentCommits.join("\n"),
		diff: input.diff,
	});
	const response = await completeSimple(
		input.model,
		{
			systemPrompt: [systemPrompt],
			messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
			tools: [QuickCommitPlanTool],
		},
		{ apiKey: input.apiKey, maxTokens: 2000, reasoning: toReasoningEffort(input.thinkingLevel) },
	);
	return parseQuickCommitPlan(response);
}

function parseQuickCommitPlan(message: AssistantMessage): QuickCommitPlan {
	const toolCall = extractToolCall(message, QuickCommitPlanTool.name);
	if (!toolCall) throw new Error("Commit planner did not return a commit plan.");
	const parsed = validateToolCall([QuickCommitPlanTool], toolCall) as typeof quickCommitPlanSchema.infer;
	return {
		commits: parsed.commits.map(commit => ({
			files: commit.files,
			message: formatQuickCommitMessage(commit.subject, commit.body),
			body: commit.body.trim(),
			branchType: commit.branch_type.trim(),
			branchScope: commit.branch_scope?.trim() || null,
		})),
	};
}

export function formatQuickCommitMessage(subject: string, body: string): string {
	const normalizedSubject = subject.trim();
	const normalizedBody = body.trim();
	if (!normalizedSubject || !normalizedBody) return normalizedSubject;
	return `${normalizedSubject}\n\n${normalizedBody}`;
}
